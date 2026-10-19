// Remedy executor: takes an Accept (narrowing) offer the way a host's model would.
//   tool_call  mcp__appa__execute_remedy_plan {offer_id}  -> pass_control
//   MCP        tools/call execute_remedy_plan {offer_id} on /mcp
//   tool_result for the control call (the MCP reply text)  -> ack
// The caller then proposes the original call again (with a new call id).
// Which tools may accept a narrowing is the guard's decision (T10.2), not this module's.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type DenyCall, type HookClient, type WireCall, newCallId } from './wire';

/** The runtime's control tool, in the amp adapter's raw spelling. */
export const CONTROL_TOOL = 'mcp__appa__execute_remedy_plan';
/** The MCP tool name on the runtime's own /mcp endpoint. */
export const REMEDY_MCP_TOOL = 'execute_remedy_plan';
/** The runtime's feedback names a plain narrowing offer with this phrase. */
export const NARROWING_PHRASE = 'Accept narrower readers';

export class RemedyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemedyError';
  }
}

/**
 * The offer id of a plain Accept (narrowing) offer on this deny, or undefined. The wire does
 * not type offers, so this reads the runtime's own feedback: exactly one offer, with no return
 * route or input sanitizer, under feedback that says "Accept narrower readers".
 */
export function narrowingOfferId(deny: DenyCall): string | undefined {
  if (deny.offers.length !== 1) return undefined;
  const [offer] = deny.offers;
  if (!offer || offer.returns !== undefined || offer.input_sanitizer !== undefined) return undefined;
  if (!deny.feedback.includes(NARROWING_PHRASE)) return undefined;
  if (!deny.feedback.includes(offer.offer_id)) return undefined;
  return offer.offer_id;
}

export interface RemedyReply {
  /** The runtime's reply text (one text block). */
  text: string;
  isError: boolean;
}

/** Calls `execute_remedy_plan` on the runtime's /mcp endpoint. */
export interface RemedyCaller {
  callRemedy(offerId: string): Promise<RemedyReply>;
  close(): Promise<void>;
}

/** MCP Streamable HTTP client for `<baseUrl>/mcp`, connected on first use. */
export class McpRemedyClient implements RemedyCaller {
  private client: Client | undefined;
  private readonly url: URL;

  constructor(
    baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.url = new URL(`${baseUrl.replace(/\/$/, '')}/mcp`);
  }

  private async connected(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'clearance-guard', version: '0.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(this.url), { timeout: this.timeoutMs });
    } catch {
      throw new RemedyError('runtime /mcp unreachable');
    }
    this.client = client;
    return client;
  }

  async callRemedy(offerId: string): Promise<RemedyReply> {
    const client = await this.connected();
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await client.callTool({ name: REMEDY_MCP_TOOL, arguments: { offer_id: offerId } }, undefined, {
        timeout: this.timeoutMs,
      });
    } catch (error) {
      // A broken MCP session is not reused.
      this.client = undefined;
      await client.close().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      throw new RemedyError(`execute_remedy_plan failed over MCP: ${message}`);
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((block): block is { type: 'text'; text: string } => isText(block))
      .map((block) => block.text)
      .join('\n');
    return { text, isError: result.isError === true };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }
}

function isText(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

export interface RemedyRun {
  offerId: string;
  /** The control call as posted. */
  control: WireCall;
  /** The runtime's MCP reply text. */
  reply: string;
}

/**
 * Take one offer for `root`. Resolves when the runtime has executed the plan and acked the
 * control call's result; the caller then retries the original call once. Throws RemedyError
 * or WireError on anything else, so the caller fails closed.
 */
export async function executeRemedy(
  hook: HookClient,
  mcp: RemedyCaller,
  root: string,
  offerId: string,
): Promise<RemedyRun> {
  const control: WireCall = { tool: CONTROL_TOOL, arguments: { offer_id: offerId }, callId: newCallId() };
  const proposed = await hook.toolCall(root, control);
  if (proposed.decision !== 'pass_control') {
    const detail = proposed.decision === 'deny_call' ? `: ${proposed.feedback}` : '';
    throw new RemedyError(`the control call got ${proposed.decision}, not pass_control${detail}`);
  }

  let reply: RemedyReply;
  try {
    reply = await mcp.callRemedy(offerId);
  } catch (error) {
    // Close the dispatch the runtime opened for the control call, then fail.
    await hook.toolResult(root, control, { status: 'failure', message: 'execute_remedy_plan did not answer' }).catch(() => {});
    throw error;
  }

  const outcome = reply.isError
    ? ({ status: 'failure', message: reply.text || 'execute_remedy_plan failed' } as const)
    : ({ status: 'success', body: reply.text } as const);
  const settled = await hook.toolResult(root, control, outcome);
  if (reply.isError) throw new RemedyError(`execute_remedy_plan refused: ${reply.text}`);
  if (settled.decision === 'block') throw new RemedyError(`the control result was blocked: ${settled.reason}`);
  return { offerId, control, reply: reply.text };
}
