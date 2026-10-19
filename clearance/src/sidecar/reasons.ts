// Reason text for a runtime deny. The runtime decides; this module only words its answer.
// A recipient deny on `send` is rewritten from the session's label source (the file or
// memory entry whose narrowing the guard accepted). Any other deny passes the runtime text
// through unchanged.
import { type Audience, FOLDER_AUDIENCES, MEMORY_SCOPE_AUDIENCES, normalizeAddress } from './audiences';

/** Why the session's label is what it is: set when the guard accepts a narrowing. */
export type LabelSource =
  | { kind: 'file'; folder: keyof typeof FOLDER_AUDIENCES; audience: Audience }
  | { kind: 'memory'; scope: string; audience: Audience };

export function fileSource(folder: string): LabelSource | undefined {
  const audience = (FOLDER_AUDIENCES as Record<string, Audience>)[folder];
  return audience ? { kind: 'file', folder: folder as keyof typeof FOLDER_AUDIENCES, audience } : undefined;
}

export function memorySource(scope: string): LabelSource | undefined {
  const audience = MEMORY_SCOPE_AUDIENCES[scope];
  return audience ? { kind: 'memory', scope, audience } : undefined;
}

/** The runtime's wording for "some recipient is not a reader" (live amp feedback). */
const RECIPIENT_DENY = /the readers do not include \d+ required recipient\(s\)/;
/** The runtime's wording when an audience source could not answer: not a policy decision. */
const SOURCE_FAILURE = /audience source \S+ gave no answer|the call was not checked/;

export function isRecipientDeny(feedback: string): boolean {
  return RECIPIENT_DENY.test(feedback);
}

export function isSourceFailure(feedback: string): boolean {
  return SOURCE_FAILURE.test(feedback);
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The demo-script reason for recipients outside a source's readers. */
export function recipientReason(source: LabelSource, outside: readonly string[]): string {
  const readers = listOf(source.audience.readers);
  const who = `${listOf(outside)} ${outside.length === 1 ? 'is' : 'are'} outside that list.`;
  const label = source.audience.label;
  return source.kind === 'file'
    ? `Blocked: ${label} content may only go to ${readers}. ${who}`
    : `Blocked: this memory entry came from ${label} content, which may only go to ${readers}. ${who}`;
}

export interface DenyContext {
  tool: string;
  /** `send` recipients, as proposed. */
  to?: readonly string[];
  source?: LabelSource;
}

/**
 * The reason the guard reports for a runtime deny. Only a recipient deny on `send`, in a
 * session with a known label source and at least one recipient outside that source's
 * readers, is rewritten; everything else is the runtime's own text.
 */
export function reasonFor(feedback: string, ctx: DenyContext): string {
  if (ctx.tool === 'send' && ctx.source && ctx.to && isRecipientDeny(feedback)) {
    const readers = new Set(ctx.source.audience.readers.map(normalizeAddress));
    const outside = [...new Set(ctx.to)].filter((r) => !readers.has(normalizeAddress(r)));
    if (outside.length > 0) return recipientReason(ctx.source, outside);
  }
  return feedback.trim();
}
