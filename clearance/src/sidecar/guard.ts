// The guard: the trusted harness between the scripted agent and its tools. One guarded call
// (docs/architecture.md "One guarded call"):
//   1. session_start + prompt once per session;
//   2. trusted arguments filled here (drive_read's `folder` from DriveClient.folderOf);
//   3. tool_call `mcp__clearance__<tool>`;
//   4. allow_call: run the tool, post tool_result, honour ack / deliver_value / replace_output / block;
//   5. deny_call with an Accept offer on drive_read or memory_load: run the remedy, retry once;
//   6. deny_call otherwise: the tool never runs; the reason is the runtime's, reworded;
//   7. transport error, timeout, refuse, audience-source failure: fail closed (`error`);
//   8. drive_read whose file moved between the check and the read: fail closed (`error`).
// Every attempt writes exactly one `enforce` line. The guard never decides on its own.
import type { DriveClient, FolderKey } from '../drive/types';
import { isFolderKey } from '../drive/types';
import type { DecisionLog } from '../log/decision-log';
import type { EnforceLine, SessionId, Step, ToolName } from '../log/schema';
import { driveList, driveRead } from '../tools/drive';
import { type MemoryEntry, memoryLoad, memorySave } from '../tools/memory';
import { type SendArgs, send } from '../tools/send';
import { type LabelSource, fileSource, isSourceFailure, memorySource, reasonFor } from './reasons';
import { type RemedyCaller, executeRemedy, narrowingOfferId } from './remedy';
import { type DenyCall, type HookClient, type Outcome, type WireCall, newCallId, rawToolName } from './wire';

/** The prompt sent when `call` opens a session the agent did not `start`. */
export const DEFAULT_PROMPT = '(clearance scripted agent)';

/** Tools whose narrowing the guard accepts. Any other narrowing offer is a deny. */
export const NARROWING_TOOLS: ReadonlySet<ToolName> = new Set(['drive_read', 'memory_load']);

/** The reason prefix when a file moved between the APPA check and the read. */
export const FOLDER_CHANGED = '[guard] folder changed between check and read';

/** What the agent passes. `folder` on drive_read is ignored: the guard resolves it. */
export interface AgentArgs {
  drive_list: { folder: FolderKey };
  drive_read: { fileId: string; folder?: string };
  send: SendArgs;
  memory_save: { scope: string; value: string };
  memory_load: { scope: string };
}

export interface DriveListing {
  id: string;
  name: string;
}
export interface DriveReadResult {
  name: string;
  content: string;
  /** The folder the file was in when it was read. The guard checks it. */
  folder: string;
}

/** What each tool returns to the agent on allow. */
export interface ToolResults {
  drive_list: DriveListing[];
  drive_read: DriveReadResult;
  send: { to: string[]; subject: string; attachments: string[] };
  memory_save: MemoryEntry;
  memory_load: MemoryEntry | null;
}

/** The plain tool functions. They never call APPA. Injectable for tests (spies). */
export interface GuardTools {
  drive_list(args: { folder: FolderKey }, ctx: ToolContext): Promise<DriveListing[]>;
  /** Must report the folder the file is in after the read; a mismatch fails closed. */
  drive_read(args: { fileId: string; folder: string }, ctx: ToolContext): Promise<DriveReadResult>;
  send(args: SendArgs, ctx: ToolContext): Promise<ToolResults['send']>;
  memory_save(args: { scope: string; value: string }, ctx: ToolContext): Promise<MemoryEntry>;
  memory_load(args: { scope: string }, ctx: ToolContext): Promise<MemoryEntry | null>;
}

export interface ToolContext {
  session: SessionId;
  drive: DriveClient;
}

export interface GuardOptions {
  hook: HookClient;
  remedy: RemedyCaller;
  drive: DriveClient;
  log: DecisionLog;
  /** Override any tool (tests). Defaults use the DriveClient and src/tools. */
  tools?: Partial<GuardTools>;
  /** Outbox and memory files (tests). Defaults: logs/outbox.jsonl, state/memory.json. */
  outboxPath?: string;
  memoryPath?: string;
  /** The runtime root id for a session. Default: the session id itself (`agent-1`). */
  rootOf?: (session: SessionId) => string;
}

export type GuardResult<T extends ToolName = ToolName> =
  | { decision: 'allow'; tool: T; result: ToolResults[T] | string; line: EnforceLine }
  | { decision: 'deny'; tool: T; reason: string; line: EnforceLine }
  /** `line` is absent only when the decision log itself refused the write. */
  | { decision: 'error'; tool: T; reason: string; line?: EnforceLine };

interface SessionState {
  started: boolean;
  source?: LabelSource;
}

/** One attempt's outcome, before it is logged. */
type Attempt =
  | { decision: 'allow'; result: unknown; fields: AttemptFields }
  | { decision: 'deny' | 'error'; reason: string; fields: AttemptFields };
interface AttemptFields {
  file?: string;
  offerId?: string;
}

/** Thrown inside one attempt to end it as `error` with this reason. */
class FailClosed extends Error {}

const errorReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('[appa]') || message.startsWith('[guard]') ? message : `[guard] ${message}`;
};

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * The enforce-line fields taken from the agent's arguments, normalised so the log accepts
 * them whatever the agent passed: `to` only as an array of strings, `scope` only as a string.
 * Arguments APPA would reject are still proposed (and denied there); they are just not logged.
 */
function logFields(tool: ToolName, args: unknown): Pick<EnforceLine, 'to' | 'scope'> {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  if (tool === 'send' && isStringArray(a.to)) return { to: [...a.to] };
  if ((tool === 'memory_save' || tool === 'memory_load') && typeof a.scope === 'string') return { scope: a.scope };
  return {};
}

export class Guard {
  private readonly sessions = new Map<SessionId, SessionState>();
  private readonly tools: GuardTools;

  constructor(private readonly opts: GuardOptions) {
    const { outboxPath, memoryPath } = opts;
    const defaults: GuardTools = {
      drive_list: (args, ctx) => driveList(ctx.drive, args),
      // Reports the folder the file is in after the read, which the guard checks.
      drive_read: (args, ctx) => driveRead(ctx.drive, args),
      async send(args, ctx) {
        const line = send(args, { session: ctx.session, outboxPath });
        return { to: line.to, subject: line.subject, attachments: line.attachments };
      },
      async memory_save(args, ctx) {
        return memorySave(args, { origin: ctx.session, memoryPath });
      },
      async memory_load(args) {
        return memoryLoad(args, { memoryPath });
      },
    };
    this.tools = { ...defaults, ...opts.tools };
  }

  /** The session's label source, once a narrowing was accepted (for tests and the agent). */
  labelSource(session: SessionId): LabelSource | undefined {
    return this.sessions.get(session)?.source;
  }

  /** session_start + prompt, once per session. Called by `call` if the agent did not. */
  async start(session: SessionId, prompt: string): Promise<void> {
    const state = this.state(session);
    if (state.started) return;
    await this.opts.hook.sessionStart(this.root(session));
    await this.opts.hook.prompt(this.root(session), prompt);
    state.started = true;
  }

  /** turn_end for a session whose work is done. Throws on a runtime error. */
  async end(session: SessionId): Promise<void> {
    const state = this.sessions.get(session);
    if (!state?.started) return;
    await this.opts.hook.turnEnd(this.root(session));
  }

  /**
   * One guarded call. Total: it never throws, always returns an allow, deny or error result,
   * and always makes exactly one enforce-log write. If that write fails, the result is
   * `error` (with no `line`) and nothing the tool returned reaches the agent.
   */
  async call<T extends ToolName>(session: SessionId, step: Step, tool: T, args: AgentArgs[T]): Promise<GuardResult<T>> {
    let attempt: Attempt;
    try {
      attempt = await this.attempt(session, tool, args);
    } catch (error) {
      attempt = { decision: 'error', reason: errorReason(error), fields: {} };
    }
    let line: EnforceLine;
    try {
      line = this.opts.log.writeEnforce({
        // The caller's step tag is logged as given (the agent's listing is `list`).
        step,
        session,
        tool,
        ...logFields(tool, args),
        ...attempt.fields,
        decision: attempt.decision,
        reason: attempt.decision === 'allow' ? undefined : attempt.reason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { decision: 'error', tool, reason: `[guard] the decision log refused the enforce line: ${message}` };
    }
    if (attempt.decision === 'allow') {
      return { decision: 'allow', tool, result: attempt.result as ToolResults[T] | string, line };
    }
    return { decision: attempt.decision, tool, reason: attempt.reason, line };
  }

  /** The attempt itself, before it is logged. */
  private async attempt(session: SessionId, tool: ToolName, args: unknown): Promise<Attempt> {
    const root = this.root(session);
    const fields: AttemptFields = {};
    const fail = (reason: string): Attempt => ({ decision: 'error', reason, fields });
    try {
      await this.start(session, DEFAULT_PROMPT).catch((error: unknown) => {
        throw new FailClosed(errorReason(error));
      });
      const appaArgs = await this.trustedArgs(tool, args);
      if (tool === 'drive_read') fields.file = await this.fileName(appaArgs as { fileId: string; folder: string });

      let call: WireCall = { tool: rawToolName(tool), arguments: appaArgs, callId: newCallId() };
      let decision = await this.opts.hook.toolCall(root, call);

      if (decision.decision === 'deny_call') {
        const offer = narrowingOfferId(decision);
        if (offer && NARROWING_TOOLS.has(tool) && !isSourceFailure(decision.feedback)) {
          await executeRemedy(this.opts.hook, this.opts.remedy, root, offer);
          fields.offerId = offer;
          const state = this.state(session);
          state.source ??=
            tool === 'drive_read' ? fileSource(String(appaArgs.folder)) : memorySource(String(appaArgs.scope));
          call = { ...call, callId: newCallId() };
          decision = await this.opts.hook.toolCall(root, call);
        }
      }

      if (decision.decision === 'deny_call') return this.denied(tool, decision, args, session, fields);
      if (decision.decision !== 'allow_call') {
        throw new FailClosed(`[guard] runtime answered ${decision.decision} to ${call.tool}`);
      }

      // Allowed: run the tool, then report its outcome.
      let value: unknown;
      try {
        value = await this.run(tool, appaArgs, session);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.opts.hook.toolResult(root, call, { status: 'failure', message }).catch(() => {});
        return fail(`[guard] ${tool} failed: ${message}`);
      }
      if (tool === 'drive_read') {
        // Check-then-read race: APPA judged the folder proposed above. A file that moved
        // before the read is not the file APPA judged, so its content never reaches the agent
        // and the dispatch is settled as a failure, which admits no body.
        const read = value as Partial<DriveReadResult> | undefined;
        if (typeof read?.name === 'string') fields.file = read.name;
        if (read?.folder !== appaArgs.folder) {
          const reason = `${FOLDER_CHANGED} (checked ${String(appaArgs.folder)}, read ${String(read?.folder)})`;
          await this.opts.hook.toolResult(root, call, { status: 'failure', message: reason }).catch(() => {});
          return fail(reason);
        }
      }
      const outcome: Outcome = { status: 'success', body: value ?? null };
      const settled = await this.opts.hook.toolResult(root, call, outcome);
      if (settled.decision === 'block') return { decision: 'deny', reason: settled.reason.trim(), fields };
      const result =
        settled.decision === 'replace_output'
          ? settled.output
          : settled.decision === 'deliver_value'
            ? settled.value
            : value;
      return { decision: 'allow', result, fields };
    } catch (error) {
      return fail(errorReason(error));
    }
  }

  private denied(tool: ToolName, deny: DenyCall, args: unknown, session: SessionId, fields: AttemptFields): Attempt {
    if (isSourceFailure(deny.feedback)) return { decision: 'error', reason: deny.feedback.trim(), fields };
    const to = (args as { to?: unknown } | undefined)?.to;
    const reason = reasonFor(deny.feedback, {
      tool,
      to: tool === 'send' && isStringArray(to) ? to : undefined,
      source: this.sessions.get(session)?.source,
    });
    return { decision: 'deny', reason, fields };
  }

  /** The APPA arguments: exactly the policy schema, trusted fields filled by the guard. */
  private async trustedArgs(tool: ToolName, args: unknown): Promise<Record<string, unknown>> {
    const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    switch (tool) {
      case 'drive_read': {
        if (typeof a.fileId !== 'string' || !a.fileId) throw new FailClosed('[guard] drive_read needs a fileId');
        // Never the agent's folder: Drive says where the file is right now.
        const folder = await this.opts.drive.folderOf(a.fileId);
        return { fileId: a.fileId, folder };
      }
      case 'drive_list':
        if (!isFolderKey(a.folder)) throw new FailClosed('[guard] drive_list needs a tree folder');
        return { folder: a.folder };
      case 'send': {
        const out: Record<string, unknown> = { to: a.to, subject: a.subject };
        if (a.body !== undefined) out.body = a.body;
        if (a.attachments !== undefined) out.attachments = a.attachments;
        return out;
      }
      case 'memory_save':
        return { scope: a.scope, value: a.value };
      case 'memory_load':
        return { scope: a.scope };
    }
  }

  /** The file's name for the enforce line, from its folder's listing (metadata only). */
  private async fileName(args: { fileId: string; folder: string }): Promise<string> {
    if (!isFolderKey(args.folder)) return args.fileId;
    try {
      const listed = await this.opts.drive.list(args.folder);
      return listed.find((f) => f.id === args.fileId)?.name ?? args.fileId;
    } catch {
      return args.fileId;
    }
  }

  private run(tool: ToolName, args: Record<string, unknown>, session: SessionId): Promise<unknown> {
    const ctx: ToolContext = { session, drive: this.opts.drive };
    switch (tool) {
      case 'drive_list':
        return this.tools.drive_list(args as { folder: FolderKey }, ctx);
      case 'drive_read':
        return this.tools.drive_read(args as { fileId: string; folder: string }, ctx);
      case 'send':
        return this.tools.send(args as unknown as SendArgs, ctx);
      case 'memory_save':
        return this.tools.memory_save(args as { scope: string; value: string }, ctx);
      case 'memory_load':
        return this.tools.memory_load(args as { scope: string }, ctx);
    }
  }

  private root(session: SessionId): string {
    return this.opts.rootOf ? this.opts.rootOf(session) : session;
  }

  private state(session: SessionId): SessionState {
    let state = this.sessions.get(session);
    if (!state) {
      state = { started: false };
      this.sessions.set(session, state);
    }
    return state;
  }
}
