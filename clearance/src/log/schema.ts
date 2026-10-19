// Line types for logs/decisions.jsonl and logs/outbox.jsonl.
// Shapes and key order follow docs/demo-script.md. Owned by T1.1; other tasks
// import this file and never edit it (changes go back to the orchestrator).

// ---- shared vocab ----------------------------------------------------------

export const LABELS = ['Legal', 'Accounting', 'High Risk'] as const;
export type Label = (typeof LABELS)[number];

/** Labels Jev may answer with. High Risk is never a Jev answer. */
export const JEV_LABELS = ['Legal', 'Accounting'] as const;
export type JevLabel = (typeof JEV_LABELS)[number];

/**
 * `specimen-id`: the SPC-dddd-dddd rule fired, Jev was skipped.
 * `low-confidence`: Jev answered below CONFIDENCE_THRESHOLD.
 * `jev`: Jev answered at or above the threshold and its label was used.
 */
export const CLASSIFY_RULES = ['specimen-id', 'low-confidence', 'jev'] as const;
export type ClassifyRule = (typeof CLASSIFY_RULES)[number];

export const CLASSIFY_SOURCES = ['fixture', 'live'] as const;
export type ClassifySource = (typeof CLASSIFY_SOURCES)[number];

/** Step tags from docs/architecture.md ("One guarded call"). */
export const STEPS = ['read', '2a', '2b', '2c-save', '2c-load', '2c', '2d'] as const;
export type Step = (typeof STEPS)[number];

export const TOOLS = ['drive_list', 'drive_read', 'send', 'memory_save', 'memory_load'] as const;
export type ToolName = (typeof TOOLS)[number];

/** `error` = the guard failed closed (transport error, timeout, refuse); the tool did not run. */
export const DECISIONS = ['allow', 'deny', 'error'] as const;
export type Decision = (typeof DECISIONS)[number];

export const SESSIONS = ['agent-1', 'agent-2'] as const;
export type SessionId = (typeof SESSIONS)[number];

// ---- line types ------------------------------------------------------------

/**
 * Demo-script examples:
 * {"kind":"classify","file":"08-…","label":"High Risk","rule":"specimen-id","moved":"High Risk"}
 * {"kind":"classify","file":"10-…","label":"High Risk","rule":"low-confidence","jev":"Legal","confidence":0.58,"source":"fixture"}
 */
export interface ClassifyLine {
  kind: 'classify';
  file: string;
  label: Label;
  rule: ClassifyRule;
  /** Jev's answer; absent when the ID rule fired. */
  jev?: JevLabel;
  confidence?: number;
  source?: ClassifySource;
  /** Destination subfolder the file was moved to. */
  moved?: Label;
  /** Drive file id. Ignored by compare. */
  fileId?: string;
  /** ISO timestamp, added by the decision log writer. Ignored by compare. */
  ts?: string;
}

/**
 * Demo-script example:
 * {"kind":"enforce","step":"2a","session":"agent-1","tool":"send","decision":"deny","reason":"Blocked: …"}
 */
export interface EnforceLine {
  kind: 'enforce';
  step: Step;
  session: SessionId;
  tool: ToolName;
  /** Recipients of a `send`. */
  to?: string[];
  /** File name for drive_read. */
  file?: string;
  /** Memory scope for memory_save / memory_load. */
  scope?: string;
  decision: Decision;
  /** Short reason; present on deny and error. */
  reason?: string;
  /** Accepted narrowing offer id. Ignored by compare. */
  offerId?: string;
  ts?: string;
}

export type DecisionLine = ClassifyLine | EnforceLine;

/**
 * Demo-script example:
 * {"to":["legal@hashirai-poc.test"],"subject":"Legal documents for review","attachments":["01-…"],"session":"agent-1"}
 */
export interface OutboxLine {
  to: string[];
  subject: string;
  attachments: string[];
  session: SessionId;
}

/** Canonical key order for each line type (writers serialise in this order). */
export const CLASSIFY_KEYS = ['kind', 'file', 'label', 'rule', 'jev', 'confidence', 'source', 'moved', 'fileId', 'ts'] as const satisfies readonly (keyof ClassifyLine)[];
export const ENFORCE_KEYS = ['kind', 'step', 'session', 'tool', 'to', 'file', 'scope', 'decision', 'reason', 'offerId', 'ts'] as const satisfies readonly (keyof EnforceLine)[];
export const OUTBOX_KEYS = ['to', 'subject', 'attachments', 'session'] as const satisfies readonly (keyof OutboxLine)[];

/** Return a copy with keys in canonical order and undefined values dropped. */
export function orderKeys<T extends object>(line: T, keys: readonly (keyof T)[]): T {
  const out: Partial<T> = {};
  for (const k of keys) if (line[k] !== undefined) out[k] = line[k];
  return out as T;
}

// ---- runtime guards --------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => isStr(v) && (set as readonly string[]).includes(v);
const optional = (v: unknown, check: (x: unknown) => boolean) => v === undefined || check(v);
const onlyKeys = (v: Rec, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));

export function isClassifyLine(v: unknown): v is ClassifyLine {
  return (
    isRec(v) &&
    onlyKeys(v, CLASSIFY_KEYS) &&
    v.kind === 'classify' &&
    isStr(v.file) &&
    oneOf(LABELS, v.label) &&
    oneOf(CLASSIFY_RULES, v.rule) &&
    optional(v.jev, (x) => oneOf(JEV_LABELS, x)) &&
    optional(v.confidence, (x) => typeof x === 'number' && x >= 0 && x <= 1) &&
    optional(v.source, (x) => oneOf(CLASSIFY_SOURCES, x)) &&
    optional(v.moved, (x) => oneOf(LABELS, x)) &&
    optional(v.fileId, isStr) &&
    optional(v.ts, isStr)
  );
}

export function isEnforceLine(v: unknown): v is EnforceLine {
  return (
    isRec(v) &&
    onlyKeys(v, ENFORCE_KEYS) &&
    v.kind === 'enforce' &&
    oneOf(STEPS, v.step) &&
    oneOf(SESSIONS, v.session) &&
    oneOf(TOOLS, v.tool) &&
    optional(v.to, isStrArr) &&
    optional(v.file, isStr) &&
    optional(v.scope, isStr) &&
    oneOf(DECISIONS, v.decision) &&
    optional(v.reason, isStr) &&
    optional(v.offerId, isStr) &&
    optional(v.ts, isStr)
  );
}

export function isDecisionLine(v: unknown): v is DecisionLine {
  return isClassifyLine(v) || isEnforceLine(v);
}

export function isOutboxLine(v: unknown): v is OutboxLine {
  return (
    isRec(v) &&
    onlyKeys(v, OUTBOX_KEYS) &&
    isStrArr(v.to) &&
    isStr(v.subject) &&
    isStrArr(v.attachments) &&
    oneOf(SESSIONS, v.session)
  );
}
