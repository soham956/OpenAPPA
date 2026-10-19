// Classifier types. Field names match ClassifyLine in src/log/schema.ts so a
// Classification can be spread straight into a decision-log line.
import type { ClassifyRule, ClassifySource, JevLabel, Label } from '../log/schema';

/** Jev's answer for one document. */
export interface JevAnswer {
  label: JevLabel;
  /** 0..1 */
  confidence: number;
}

/**
 * The Jev model, injected. It receives the document content ONLY, never the
 * file name. The real TypeSafe adapter lives in jev.ts (T5.2).
 */
export type Jev = (content: string) => Promise<JevAnswer>;

/** A document to classify. `file` is used for fixture notes and logs only. */
export interface ClassifyInput {
  content: string;
  file?: string;
}

/** The classifier's verdict, shaped like the matching ClassifyLine fields. */
export interface Classification {
  label: Label;
  rule: ClassifyRule;
  /** Jev's label; absent when the ID rule fired. */
  jev?: JevLabel;
  /** Jev's confidence; absent when the ID rule fired. */
  confidence?: number;
  /** Where Jev's answer came from; absent when the ID rule fired. */
  source?: ClassifySource;
}

/** Jev's answer plus where it came from (fixture hit or live call). */
export interface SourcedAnswer extends JevAnswer {
  source: ClassifySource;
}

/** Anything that turns content into a sourced Jev answer (FixtureStore does). */
export interface AnswerSource {
  answer(content: string, note?: string): Promise<SourcedAnswer>;
}

/** One fixture entry. `note` is the file name at record time, for humans only. */
export interface FixtureEntry {
  label: JevLabel;
  confidence: number;
  note?: string;
}

/** On-disk fixture: sha256(content) hex → entry, keys sorted ascending. */
export type FixtureFile = Record<string, FixtureEntry>;
