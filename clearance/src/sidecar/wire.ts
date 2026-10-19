// Typed client for the runtime's `/hook` wire (protocol 1, adapter "amp"), modelled on
// integrations/amp/amppa.ts. Every failure to get a well-formed answer throws a WireError,
// so a caller that treats a throw as "do not run the tool" fails closed.
import { randomUUID } from 'node:crypto';

export const PROTOCOL = 1;
export const ADAPTER = 'amp';
/** The MCP server our tools are served under: raw names are `mcp__clearance__<tool>`. */
export const TOOL_SERVER = 'clearance';

export type EventName = 'session_start' | 'prompt' | 'tool_call' | 'tool_result' | 'turn_end';

/** What a tool reported, in the wire's outcome shape. `body` is any JSON value. */
export type Outcome =
  | { status: 'success'; body: unknown }
  | { status: 'success_without_body' }
  | { status: 'failure'; message: string }
  | { status: 'indeterminate' };

export interface WireOffer {
  offer_id: string;
  /** Set only for plans that declare a child's return; never for a plain narrowing. */
  returns?: unknown;
  /** Set only for an input-sanitizer offer; never for a plain narrowing. */
  input_sanitizer?: { name: string; target: string; description?: string };
}

export type AckDecision = { decision: 'ack' };
export type ContextDecision = { decision: 'context'; text: string };
export type AllowCall = { decision: 'allow_call' };
export type PassControl = { decision: 'pass_control' };
export type DenyCall = { decision: 'deny_call'; feedback: string; offers: WireOffer[] };
export type Block = { decision: 'block'; reason: string };
export type ReplaceOutput = { decision: 'replace_output'; output: string };
export type DeliverValue = { decision: 'deliver_value'; value: string };
export type Refuse = { decision: 'refuse'; class: string; detail: string };

/** Every decision this client understands. Anything else is a WireError. */
export type Decision =
  | AckDecision
  | ContextDecision
  | AllowCall
  | PassControl
  | DenyCall
  | Block
  | ReplaceOutput
  | DeliverValue
  | Refuse;

export type ToolCallDecision = AllowCall | PassControl | DenyCall;
export type ToolResultDecision = AckDecision | DeliverValue | ReplaceOutput | Block;

export type WireErrorKind = 'transport' | 'timeout' | 'http' | 'non-json' | 'malformed' | 'refuse' | 'unexpected';

export class WireError extends Error {
  constructor(
    readonly kind: WireErrorKind,
    message: string,
    /** The decision, when one was read (refuse, or one the event may not get). */
    readonly decision?: Decision,
  ) {
    super(message);
    this.name = 'WireError';
  }
}

/** One call as the wire carries it: raw tool name, JSON arguments, the host's call id. */
export interface WireCall {
  tool: string;
  arguments: Record<string, unknown>;
  callId: string;
}

export interface HookClientOptions {
  /** Runtime base URL, e.g. http://127.0.0.1:8790. */
  baseUrl: string;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Injected for tests. Default: global fetch. */
  fetch?: typeof fetch;
}

/** `mcp__clearance__<tool>`: the raw name the guard proposes for one of our tools. */
export function rawToolName(tool: string): string {
  return `mcp__${TOOL_SERVER}__${tool}`;
}

/** A fresh opaque call id. A call and its tool_result share one; a retry gets a new one. */
export function newCallId(): string {
  return `call-${randomUUID()}`;
}

/** Parse one reply body into a Decision, or throw a WireError. Exported for tests. */
export function parseDecision(status: number, text: string): Decision {
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new WireError('non-json', `runtime reply is not JSON (HTTP ${status})`);
  }
  if (!isObject(reply) || reply.protocol !== PROTOCOL || typeof reply.decision !== 'string') {
    throw new WireError('malformed', `runtime reply is not a protocol ${PROTOCOL} decision (HTTP ${status})`);
  }
  const str = (field: string): string => {
    const value = reply[field];
    if (typeof value !== 'string') throw new WireError('malformed', `${reply.decision} without its ${field}`);
    return value;
  };
  let decision: Decision;
  switch (reply.decision) {
    case 'ack':
    case 'allow_call':
    case 'pass_control':
      decision = { decision: reply.decision };
      break;
    case 'context':
      decision = { decision: 'context', text: str('text') };
      break;
    case 'deny_call':
      decision = { decision: 'deny_call', feedback: str('feedback'), offers: parseOffers(reply.offers) };
      break;
    case 'block':
      decision = { decision: 'block', reason: str('reason') };
      break;
    case 'replace_output':
      decision = { decision: 'replace_output', output: str('output') };
      break;
    case 'deliver_value':
      decision = { decision: 'deliver_value', value: str('value') };
      break;
    case 'refuse':
      decision = { decision: 'refuse', class: str('class'), detail: str('detail') };
      break;
    default:
      throw new WireError('unexpected', `runtime answered an unknown decision: ${reply.decision}`);
  }
  if (decision.decision === 'refuse') {
    throw new WireError('refuse', `[appa] ${decision.detail}`, decision);
  }
  if (status < 200 || status >= 300) {
    throw new WireError('http', `runtime returned HTTP ${status}`, decision);
  }
  return decision;
}

function parseOffers(value: unknown): WireOffer[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new WireError('malformed', 'deny_call offers is not an array');
  return value.map((offer) => {
    if (!isObject(offer) || typeof offer.offer_id !== 'string' || !offer.offer_id) {
      throw new WireError('malformed', 'deny_call offer without its offer_id');
    }
    return offer as unknown as WireOffer;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `/hook` client. Each method posts one event and returns only the decisions that event
 * may get; a refuse, a transport error, a timeout, a non-JSON or malformed reply, or any
 * other decision throws a WireError.
 */
export class HookClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HookClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Post one raw event. Returns any non-refuse decision; throws WireError otherwise. */
  async post(event: EventName, root: string, fields: Record<string, unknown> = {}): Promise<Decision> {
    const body = JSON.stringify({ protocol: PROTOCOL, adapter: ADAPTER, event, root_id: root, ...fields });
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      text = await response.text();
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new WireError('timeout', `runtime did not answer ${event} within ${this.timeoutMs} ms`);
      }
      // Never echo the raw fetch error: it can carry the endpoint.
      throw new WireError('transport', `runtime unreachable for ${event}`);
    }
    return parseDecision(response.status, text);
  }

  /** Open (or reopen) the session. */
  async sessionStart(root: string): Promise<AckDecision | ContextDecision> {
    const d = await this.post('session_start', root);
    if (d.decision === 'ack' || d.decision === 'context') return d;
    throw unexpected('session_start', d);
  }

  async prompt(root: string, text: string): Promise<AckDecision> {
    const d = await this.post('prompt', root, { text });
    if (d.decision === 'ack') return d;
    throw unexpected('prompt', d);
  }

  async toolCall(root: string, call: WireCall): Promise<ToolCallDecision> {
    const d = await this.post('tool_call', root, { tool: call.tool, arguments: call.arguments, call_id: call.callId });
    if (d.decision === 'allow_call' || d.decision === 'pass_control' || d.decision === 'deny_call') return d;
    throw unexpected('tool_call', d);
  }

  async toolResult(root: string, call: WireCall, outcome: Outcome): Promise<ToolResultDecision> {
    const d = await this.post('tool_result', root, {
      tool: call.tool,
      arguments: call.arguments,
      call_id: call.callId,
      outcome,
    });
    if (d.decision === 'ack' || d.decision === 'deliver_value' || d.decision === 'replace_output' || d.decision === 'block') {
      return d;
    }
    throw unexpected('tool_result', d);
  }

  async turnEnd(root: string): Promise<AckDecision> {
    const d = await this.post('turn_end', root);
    if (d.decision === 'ack') return d;
    throw unexpected('turn_end', d);
  }
}

function unexpected(event: EventName, decision: Decision): WireError {
  return new WireError('unexpected', `runtime answered ${decision.decision} to ${event}`, decision);
}
