import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLEARANCE_DIR } from '../src/config';
import { ALLOWED_READERS, FOLDER_AUDIENCES, LEGAL_READER, MEMORY_SCOPE_AUDIENCES, normalizeAddress } from '../src/sidecar/audiences';
import { fileSource, isRecipientDeny, isSourceFailure, memorySource, reasonFor, recipientReason } from '../src/sidecar/reasons';

const COUNSEL = 'counsel@outside-firm.test';
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(CLEARANCE_DIR, 'test', 'fixtures', 'runtime', `${name}.json`), 'utf8')) as {
    reply: { feedback: string };
  };
/** The live runtime's recipient deny (send to counsel after a Legal read). */
const LIVE_RECIPIENT_DENY = fixture('send-counsel-deny').reply.feedback;
const LIVE_HOLD_DENY = fixture('drive-read-high-risk-deny').reply.feedback;

describe('reasons', () => {
  it('words the 2a and 2b reason from a file source, exactly as the demo script', () => {
    const source = fileSource('legal');
    expect(reasonFor(LIVE_RECIPIENT_DENY, { tool: 'send', to: [LEGAL_READER, COUNSEL], source })).toBe(
      'Blocked: Legal content may only go to legal@hashirai-poc.test. counsel@outside-firm.test is outside that list.',
    );
    expect(reasonFor(LIVE_RECIPIENT_DENY, { tool: 'send', to: [COUNSEL], source })).toBe(
      'Blocked: Legal content may only go to legal@hashirai-poc.test. counsel@outside-firm.test is outside that list.',
    );
  });

  it('words the 2c reason from a memory source, exactly as the demo script', () => {
    expect(reasonFor(LIVE_RECIPIENT_DENY, { tool: 'send', to: [COUNSEL], source: memorySource('legal-handoff') })).toBe(
      'Blocked: this memory entry came from Legal content, which may only go to legal@hashirai-poc.test. counsel@outside-firm.test is outside that list.',
    );
  });

  it('names Accounting content and several outsiders', () => {
    expect(recipientReason(fileSource('accounting')!, ['a@x.test', 'b@y.test', 'c@z.test'])).toBe(
      'Blocked: Accounting content may only go to legal@hashirai-poc.test. a@x.test, b@y.test and c@z.test are outside that list.',
    );
  });

  it('compares addresses the way the runtime does (domain lowercased, local part exact)', () => {
    expect(normalizeAddress('Legal@HASHIRAI-poc.test')).toBe('Legal@hashirai-poc.test');
    const source = fileSource('legal');
    expect(reasonFor(LIVE_RECIPIENT_DENY, { tool: 'send', to: ['legal@HASHIRAI-poc.test', COUNSEL], source })).toMatch(
      /\. counsel@outside-firm\.test is outside that list\.$/,
    );
    expect(reasonFor(LIVE_RECIPIENT_DENY, { tool: 'send', to: ['LEGAL@hashirai-poc.test'], source })).toMatch(
      /\. LEGAL@hashirai-poc\.test is outside that list\.$/,
    );
  });

  it('passes any other deny through unchanged', () => {
    // No label source, another tool, another deny, or nobody outside the list.
    expect(reasonFor(LIVE_RECIPIENT_DENY, { tool: 'send', to: [COUNSEL] })).toBe(LIVE_RECIPIENT_DENY);
    expect(reasonFor(LIVE_HOLD_DENY, { tool: 'drive_read', source: fileSource('legal') })).toBe(LIVE_HOLD_DENY);
    expect(reasonFor(LIVE_HOLD_DENY, { tool: 'send', to: [COUNSEL], source: fileSource('legal') })).toBe(LIVE_HOLD_DENY);
    expect(reasonFor(LIVE_RECIPIENT_DENY, { tool: 'send', to: [LEGAL_READER], source: fileSource('legal') })).toBe(LIVE_RECIPIENT_DENY);
    expect(fileSource('high-risk')).toBeUndefined();
    expect(memorySource('notes')).toBeUndefined();
  });

  it('tells a recipient deny from an audience-source failure', () => {
    expect(isRecipientDeny(LIVE_RECIPIENT_DENY)).toBe(true);
    expect(isSourceFailure(LIVE_RECIPIENT_DENY)).toBe(false);
    const failure =
      '[appa] mcp__clearance__send: audience source rcpt gave no answer for addr/legal@hashirai-poc.test: it returned non-success status 1; the cause and retryability are unknown, so ask an operator to inspect the runtime diagnostics; the call was not checked';
    expect(isSourceFailure(failure)).toBe(true);
    expect(isRecipientDeny(failure)).toBe(false);
  });
});

// ---- audiences.ts against appa.toml ------------------------------------------------------

interface Contract {
  name: string;
  delta?: string[];
  contains?: string[];
}

/** The `[[policy.tool]]` blocks of appa.toml: name, `delta.audience`, `requires.audience.contains`. */
function contracts(): Contract[] {
  const text = readFileSync(join(CLEARANCE_DIR, 'appa.toml'), 'utf8').replace(/^\s*#.*$/gm, '');
  const list = (m: RegExpMatchArray | null) => (m ? [...(m[1] as string).matchAll(/"([^"]*)"/g)].map((x) => x[1] as string) : undefined);
  return text
    .split('[[policy.tool]]')
    .slice(1)
    .map((block) => {
      const body = block.split(/^\[(?!\[)/m)[0] as string;
      return {
        name: (body.match(/^name = "([^"]+)"/m)?.[1] ?? '') as string,
        delta: list(body.match(/^delta = \{ audience = \[([^\]]*)\]/m)),
        contains: list(body.match(/^requires = \{ audience = \{ contains = \[([^\]]*)\]/m)),
      };
    });
}

describe('audiences.ts matches appa.toml', () => {
  const all = contracts();
  const byName = new Map(all.map((c) => [c.name, c]));

  it('parses the policy', () => {
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(byName.get('mcp/clearance/send')?.contains).toEqual(['@rcpt:addr/$to']);
  });

  it('has the same folder audiences as the drive_read contracts', () => {
    const narrowing = all.filter((c) => c.name.startsWith('mcp/clearance/drive_read(') && c.delta);
    expect(Object.fromEntries(narrowing.map((c) => [c.name, c.delta]))).toEqual(
      Object.fromEntries(Object.entries(FOLDER_AUDIENCES).map(([folder, a]) => [`mcp/clearance/drive_read(folder:${folder})`, [...a.readers]])),
    );
  });

  it('has the same memory scope audiences as the memory contracts', () => {
    const loads = all.filter((c) => c.name.startsWith('mcp/clearance/memory_load(') && c.delta);
    expect(Object.fromEntries(loads.map((c) => [c.name, c.delta]))).toEqual(
      Object.fromEntries(Object.entries(MEMORY_SCOPE_AUDIENCES).map(([scope, a]) => [`mcp/clearance/memory_load(scope:${scope})`, [...a.readers]])),
    );
    for (const [scope, a] of Object.entries(MEMORY_SCOPE_AUDIENCES)) {
      expect(byName.get(`mcp/clearance/memory_save(scope:${scope})`)?.contains).toEqual([...a.readers]);
    }
  });

  it('names no reader the allowed list lacks', () => {
    const readers = new Set<string>();
    for (const c of all) for (const entry of [...(c.delta ?? []), ...(c.contains ?? [])]) if (/^[^@$][^@]*@[^@]+$/.test(entry)) readers.add(entry);
    expect([...readers].sort()).toEqual([...ALLOWED_READERS].sort());
  });
});
