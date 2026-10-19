// The real Jev: a TypeSafe `systemOne` call with one `choice` question over
// exactly {Legal, Accounting} (@typesafe-ai/sdk 0.7.0). Only the document
// content is sent, as `state`; the file name never leaves this process.
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type { Config } from '../config';
import { JEV_LABELS } from '../log/schema';
import type { Jev, JevAnswer } from './types';

/** The single question Jev answers. Criteria keys are exactly JEV_LABELS. */
export const JEV_QUESTION = choice('Is this business document a legal document or an accounting document?', {
  Legal: 'Contracts, agreements, legal letters, resolutions or other legal terms and obligations.',
  Accounting: 'Invoices, expenses, ledgers, payments or other financial records.',
});

export class JevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevError';
  }
}

export interface TypesafeJevOptions {
  /** Supplies the key via cfg.requireTypesafeKey(), read only on the first live call. */
  cfg: Pick<Config, 'requireTypesafeKey'>;
  /** Model override; default is the SDK's (TYPESAFE_DEFAULT_MODEL, then jev-latest). */
  model?: string;
}

/**
 * A Jev backed by TypeSafe. Building it never needs the key: the client is
 * created on the first call, so a missing TYPESAFE_API_KEY throws ConfigError
 * only when a live call is actually needed.
 */
export function createTypesafeJev(opts: TypesafeJevOptions): Jev {
  let client: TypeSafeClient | undefined;
  return async (content: string): Promise<JevAnswer> => {
    client ??= new TypeSafeClient({ apiKey: opts.cfg.requireTypesafeKey() });
    const res = await client.systemOne({
      state: content,
      questions: { category: JEV_QUESTION },
      ...(opts.model ? { model: opts.model } : {}),
    });
    return toJevAnswer(res.answers.category);
  };
}

/**
 * The Jev for this config, or undefined when there is no TYPESAFE_API_KEY.
 * Give the result to FixtureStore: a fixture miss without a key then fails with
 * MissingJevError naming the file, and replay hits never need the key.
 */
export function jevFromConfig(cfg: Pick<Config, 'typesafeApiKey' | 'requireTypesafeKey'>, model?: string): Jev | undefined {
  return cfg.typesafeApiKey ? createTypesafeJev({ cfg, model }) : undefined;
}

/** Map the SDK's choice answer to a JevAnswer; confidence is clamped to 0..1. */
export function toJevAnswer(answer: { choice: string; confidence: number }): JevAnswer {
  const { choice: label, confidence } = answer;
  if (!(JEV_LABELS as readonly string[]).includes(label)) {
    throw new JevError(`Jev answered "${label}"; expected one of ${JEV_LABELS.join(', ')}.`);
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new JevError(`Jev returned a non-numeric confidence: ${String(confidence)}.`);
  }
  return { label: label as JevAnswer['label'], confidence: Math.min(1, Math.max(0, confidence)) };
}
