// Mock `send` tool: appends one line to the outbox log. Plain function; it never
// calls APPA (only the guard does). `session` comes from the caller, outside the
// APPA arguments. Owned by T11.1.
import { buildPaths, CLEARANCE_DIR, REPO_ROOT } from '../config';
import { OUTBOX_KEYS, SESSIONS, orderKeys, type OutboxLine, type SessionId } from '../log/schema';
import { appendJsonl } from '../util/jsonl';

/** The APPA-visible arguments of `send` (policy/README.md). */
export interface SendArgs {
  to: string[];
  subject: string;
  body?: string;
  attachments?: string[];
}

export interface SendContext {
  session: SessionId;
  /** Outbox file. Default: logs/outbox.jsonl in clearance/. */
  outboxPath?: string;
}

const defaultOutbox = () => buildPaths(REPO_ROOT, CLEARANCE_DIR).outboxLog;

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Append exactly one outbox line `{to, subject, attachments, session}`.
 * Validates first and throws before touching the file, so a failed call writes nothing.
 * `body` is accepted but not logged. Returns the line written.
 */
export function send(args: SendArgs, ctx: SendContext): OutboxLine {
  if (!isStrArr(args.to) || args.to.length === 0) throw new TypeError('send: "to" must be a non-empty array of strings');
  if (typeof args.subject !== 'string') throw new TypeError('send: "subject" must be a string');
  if (args.body !== undefined && typeof args.body !== 'string') throw new TypeError('send: "body" must be a string');
  if (args.attachments !== undefined && !isStrArr(args.attachments)) {
    throw new TypeError('send: "attachments" must be an array of strings');
  }
  if (!(SESSIONS as readonly unknown[]).includes(ctx?.session)) throw new TypeError('send: a session id is required');

  const line = orderKeys<OutboxLine>(
    { to: [...args.to], subject: args.subject, attachments: [...(args.attachments ?? [])], session: ctx.session },
    OUTBOX_KEYS,
  );
  appendJsonl(ctx.outboxPath ?? defaultOutbox(), line);
  return line;
}
