// The classification decision: ID rule first, then Jev with a confidence
// threshold. classify() touches nothing but the injected AnswerSource.
import { type ClassifierMode, getConfig } from '../config';
import { FixtureStore } from './fixture-store';
import { hasSpecimenId } from './specimen';
import type { AnswerSource, Classification, ClassifyInput, Jev, SourcedAnswer } from './types';

/** Apply the threshold to a Jev answer. Below threshold → High Risk / low-confidence. */
export function decideFromAnswer(answer: SourcedAnswer, threshold: number): Classification {
  const { label, confidence, source } = answer;
  if (confidence < threshold) {
    return { label: 'High Risk', rule: 'low-confidence', jev: label, confidence, source };
  }
  return { label, rule: 'jev', jev: label, confidence, source };
}

export interface ClassifyDeps {
  /** Usually a FixtureStore. */
  answers: AnswerSource;
  /** Default: getConfig().confidenceThreshold (CONFIDENCE_THRESHOLD, 0.70). */
  threshold?: number;
}

/**
 * Classify one document. The ID rule runs first and skips Jev entirely.
 * Only `content` reaches Jev; `file` is passed to the store as a note.
 */
export async function classify(input: ClassifyInput, deps: ClassifyDeps): Promise<Classification> {
  if (hasSpecimenId(input.content)) {
    return { label: 'High Risk', rule: 'specimen-id' };
  }
  const threshold = deps.threshold ?? getConfig().confidenceThreshold;
  const answer = await deps.answers.answer(input.content, input.file);
  return decideFromAnswer(answer, threshold);
}

export interface ClassifierOptions {
  /** Fixture file. Default: config.paths.fixturesFile. */
  fixturePath?: string;
  /** Live Jev (T5.2 adapter); omit when there is no key. */
  jev?: Jev;
  /** Default: config.classifierMode. */
  mode?: ClassifierMode;
  /** Default: config.confidenceThreshold. */
  threshold?: number;
}

/** A ready classifier over a FixtureStore, with defaults from getConfig(). */
export function createClassifier(opts: ClassifierOptions = {}): (input: ClassifyInput) => Promise<Classification> {
  const cfg = opts.fixturePath && opts.mode && opts.threshold !== undefined ? undefined : getConfig();
  const answers = new FixtureStore({
    path: opts.fixturePath ?? cfg!.paths.fixturesFile,
    jev: opts.jev,
    mode: opts.mode ?? cfg!.classifierMode,
  });
  const threshold = opts.threshold ?? cfg!.confidenceThreshold;
  return (input) => classify(input, { answers, threshold });
}
