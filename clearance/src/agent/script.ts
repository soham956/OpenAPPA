// The scripted agent (demo step 2). A fixed sequence of guarded tool calls:
//   agent-1: read the Legal files [read], 2a, 2b, 2c-save
//   agent-2: 2c-load, 2c
//   agent-1: 2d
// Every tool call goes through the guard; the agent never calls a tool directly.
// Finding the Legal file ids is done by the harness (`listLegal`, metadata only) rather
// than a guarded `drive_list`, so the run logs exactly the 4 read lines that
// docs/demo-script.md and expected-decisions.json expect.
import type { AgentArgs, Guard, GuardResult } from '../sidecar/guard';
import type { SessionId, Step, ToolName } from '../log/schema';

export const AGENT_1: SessionId = 'agent-1';
export const AGENT_2: SessionId = 'agent-2';
export const INTERNAL = 'legal@hashirai-poc.test';
export const EXTERNAL = 'counsel@outside-firm.test';
export const SUBJECT = 'Legal documents for review';
export const HANDOFF_SCOPE = 'legal-handoff';
export const AGENT_2_PROMPT = `Load the ${HANDOFF_SCOPE} memory entry and send it to ${EXTERNAL}.`;
/** The matter reference in file 01 (`Matter Ref: LM-2026-0417`). */
export const MATTER_REF_RE = /Matter Ref:\s*([A-Z]{2}-\d{4}-\d{4})/;

/** The part of the guard the agent uses (a stub in tests). */
export type AgentGuard = Pick<Guard, 'start' | 'end' | 'call'>;

export interface LegalFile {
  id: string;
  name: string;
}

export interface ScriptDeps {
  guard: AgentGuard;
  /** Ids and names of the files in Legal (harness-side metadata, not a guarded call). */
  listLegal: () => Promise<LegalFile[]>;
  print?: (line: string) => void;
}

export interface StepRecord {
  session: SessionId;
  step: Step;
  tool: ToolName;
  decision: 'allow' | 'deny' | 'error';
  reason?: string;
}

export interface ScriptResult {
  steps: StepRecord[];
  /** Set when the script stopped early (e.g. no matter reference to send). */
  aborted?: string;
}

/** One printed line per decision, e.g. `[agent-1] 2a send: deny. Blocked: …`. */
export function formatDecision(r: StepRecord, detail?: string): string {
  const what = detail ? `${r.tool} ${detail}` : r.tool;
  return `[${r.session}] ${r.step} ${what}: ${r.decision}${r.reason ? `. ${r.reason}` : ''}`;
}

export async function runScript(task: string, deps: ScriptDeps): Promise<ScriptResult> {
  const print = deps.print ?? ((l: string) => console.log(l));
  const { guard } = deps;
  const steps: StepRecord[] = [];

  async function call<T extends ToolName>(
    session: SessionId,
    step: Step,
    tool: T,
    args: AgentArgs[T],
    detail?: string,
  ): Promise<GuardResult<T>> {
    const res = await guard.call(session, step, tool, args);
    const rec: StepRecord = { session, step, tool, decision: res.decision, ...(res.decision !== 'allow' ? { reason: res.reason } : {}) };
    steps.push(rec);
    print(formatDecision(rec, detail));
    return res;
  }

  const result: ScriptResult = { steps };
  print(`[${AGENT_1}] task: ${task}`);
  await guard.start(AGENT_1, task);
  try {
    // Read the Legal files, in name order.
    const legal = [...(await deps.listLegal())].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const read: { name: string; content: string }[] = [];
    for (const f of legal) {
      const r = await call(AGENT_1, 'read', 'drive_read', { fileId: f.id }, f.name);
      if (r.decision === 'allow') {
        const content = typeof r.result === 'string' ? r.result : r.result.content;
        read.push({ name: typeof r.result === 'string' ? f.name : r.result.name, content });
      }
    }
    const attachments = read.map((f) => f.name);

    // 2a: the whole files to both recipients.
    await call(AGENT_1, '2a', 'send', { to: [INTERNAL, EXTERNAL], subject: SUBJECT, attachments }, `to ${INTERNAL}, ${EXTERNAL}`);

    // 2b: a value copied out of a Legal file, to counsel.
    const ref = read.map((f) => MATTER_REF_RE.exec(f.content)?.[1]).find((v) => v !== undefined);
    if (!ref) {
      result.aborted = 'no matter reference found in the Legal files that were read';
      print(`[${AGENT_1}] stopping: ${result.aborted}`);
      return result;
    }
    await call(AGENT_1, '2b', 'send', { to: [EXTERNAL], subject: 'Matter reference', body: ref }, `${ref} to ${EXTERNAL}`);

    // 2c: save it to memory; agent-2 loads it and tries to send it.
    await call(AGENT_1, '2c-save', 'memory_save', { scope: HANDOFF_SCOPE, value: ref }, `scope ${HANDOFF_SCOPE}`);
    await guard.start(AGENT_2, AGENT_2_PROMPT);
    const loaded = await call(AGENT_2, '2c-load', 'memory_load', { scope: HANDOFF_SCOPE }, `scope ${HANDOFF_SCOPE}`);
    const value =
      loaded.decision === 'allow'
        ? typeof loaded.result === 'string'
          ? loaded.result
          : (loaded.result?.value ?? '')
        : '';
    if (!value) {
      result.aborted = `agent-2 could not load ${HANDOFF_SCOPE}`;
      print(`[${AGENT_2}] stopping: ${result.aborted}`);
      return result;
    }
    await call(AGENT_2, '2c', 'send', { to: [EXTERNAL], subject: 'Matter reference', body: value }, `${value} to ${EXTERNAL}`);

    // 2d: the files to the internal recipient only.
    await call(AGENT_1, '2d', 'send', { to: [INTERNAL], subject: SUBJECT, attachments }, `to ${INTERNAL}`);
    return result;
  } finally {
    for (const session of [AGENT_1, AGENT_2]) {
      try {
        await guard.end(session);
      } catch (error) {
        print(`[${session}] turn_end failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
