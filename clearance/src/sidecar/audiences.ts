// The readers clearance/appa.toml allows, mirrored for the guard's reason text.
// The guard never decides with this list: the runtime decides, and the guard only uses it
// to say who may receive what after a runtime deny. test/reasons.test.ts checks it against
// appa.toml, so the two cannot drift.

/** The one literal reader the policy names (a one-member internal stub). */
export const LEGAL_READER = 'legal@hashirai-poc.test';

/** Every reader the policy names. */
export const ALLOWED_READERS: readonly string[] = [LEGAL_READER];

export interface Audience {
  /** The content label used in reasons ("Legal content may only go to …"). */
  label: 'Legal' | 'Accounting';
  /** The readers the label narrows to (appa.toml `delta.audience`). */
  readers: readonly string[];
}

/** drive_read(folder:<key>) contracts with a narrowing `delta.audience`. */
export const FOLDER_AUDIENCES: Readonly<Record<'legal' | 'accounting', Audience>> = {
  legal: { label: 'Legal', readers: [LEGAL_READER] },
  accounting: { label: 'Accounting', readers: [LEGAL_READER] },
};

/**
 * Memory scopes with a fixed audience: memory_save(scope:<s>) requires `contains = readers`
 * and memory_load(scope:<s>) narrows to `readers`. Other scopes are public.
 */
export const MEMORY_SCOPE_AUDIENCES: Readonly<Record<string, Audience>> = {
  'legal-handoff': { label: 'Legal', readers: [LEGAL_READER] },
};

/** The runtime compares the local part exactly and lowercases the domain. */
export function normalizeAddress(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? address : `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}
