# Clearance policy

`clearance/appa.toml` is the APPA policy for demo steps 2a–2d and the High Risk hold. The
trace files in `clearance/policy-tests/` pin it. Both checks run from the repo root:

```sh
appa describe --config clearance/appa.toml --check
appa replay --config clearance/appa.toml clearance/policy-tests/
```

Checked against `appa` 0.35.1 (fork commit `7a3c42d`).

## Spike result: array recipients work (primary approach)

`send` takes `to` as an array of strings and is gated by
`requires = { audience = { contains = ["@rcpt:addr/$to"] } }`. The engine turns each element
of `to` into one collection `@rcpt:addr/<email>` (at most 100). `rcpt-audience.mjs` answers
each with exactly one member, the address itself. So every recipient must already be a reader
of what the session has read. The fallback (one string `to` and per-recipient guard checks)
is **not** needed.

How it was checked (`appa replay`, observed steps):

| Session state | `to` | Result |
|---|---|---|
| fresh (public) | `[counsel@, legal@]` | allow |
| after a Legal read | `[legal@, counsel@]` | deny |
| after a Legal read | `[counsel@]` | deny |
| after a Legal read | `[legal@]` | allow |
| after a Legal read | `["LEGAL@hashirai-poc.test"]` | deny (the local part is compared exactly) |
| after a Legal read | `["legal@HASHIRAI-poc.test"]` | allow (the runtime lowercases the domain) |
| any | `"legal@…"` (a string) or `[]` | deny, `invalid call` |

To prove the source is consulted, the same trace was replayed with the command swapped for
`node -e "process.exit(1)"`. The send to `[legal@]` after a Legal read then turned to deny.
A public session needs no membership read, so the first row stays allow even with a broken
source.

## Tool argument schemas

Every tool is served by the MCP server `clearance`. The guard proposes the raw name
`mcp__clearance__<tool>` (canonical `mcp/clearance/<tool>`); `appa describe --adapter amp
--session-tools mcp__clearance__…` maps all five to a rule. Every schema has
`additionalProperties = false`. Send exactly these arguments to APPA (in `tool_call` and
the matching `tool_result`). An extra argument, a missing required one or a wrong type gets a
`deny_call` with `[appa] invalid call: …` and no offer. Context the tool needs beyond these
(the session id for the outbox, the memory `origin`) goes to the tool function directly, not
into the APPA arguments.

| Tool | Arguments (all required unless marked) | Contracts |
|---|---|---|
| `drive_read` | `fileId`: string, non-empty · `folder`: string, **trusted**, filled by the guard from `DriveClient.folderOf` | `folder` = `legal` or `accounting`: `delta.audience = ["legal@hashirai-poc.test"]`. `high-risk`: `requires.attention = ["blocked"]`. Anything else (`root`, `other`, …): no contract, denied. |
| `drive_list` | `folder`: string, **trusted** | `legal`, `accounting`: `delta = {}`. Anything else: no contract, denied. |
| `send` | `to`: array of strings, at least 1 · `subject`: string · `body`: string, optional · `attachments`: array of strings, optional | `requires.audience.contains = ["@rcpt:addr/$to"]` |
| `memory_save` | `scope`: string · `value`: string | `scope` = `legal-handoff`: `requires.audience.contains = ["legal@hashirai-poc.test"]`. Other scopes: `contains = ["public"]`. |
| `memory_load` | `scope`: string | `legal-handoff`: `delta.audience = ["legal@hashirai-poc.test"]`. Other scopes: `delta = {}`. |

Folder values are the ones `folderOf` returns: `root`, `legal`, `accounting`, `high-risk`,
`other`. Selectors match the full value, case-sensitively.

The only reader the policy names is `legal@hashirai-poc.test` (a literal reader, no member
list), so `src/sidecar/audiences.ts` should hold exactly that one address.

## Runtime deny feedback

`appa replay` prints the feedback only when a step mismatches, so these texts were captured
by replaying copies of the traces with `expect deny` flipped to `expect allow`. The live
runtime sends the same text as `deny_call.feedback` (replay drives the production hook
dispatcher). The text never names a recipient, so the guard writes the demo reasons itself.

**2a** (send to `[legal@, counsel@]` after a Legal read), no offer:

```
[appa] Blocked: mcp/clearance/send cannot run yet.

Why:
  - the readers do not include 2 required recipient(s)

Alternative:
  If a child-session or subagent tool is available, handle the work there if isolation is useful.
  A child inherits the same session label, so delegation does not clear these requirements.
```

The count is the number of distinct addresses in `to`, not the number outside the readers:
`[legal@, legal@, counsel@]` also says 2.

**2b** (send to `[counsel@]` after a Legal read) and **2c** (agent-2 sends to `[counsel@]`
after loading `legal-handoff`): the same text with `1 required recipient(s)`.

Other denies, for reference:

- 2c-agent1, save to a non-`legal-handoff` scope after a Legal read:
  `Why: - the readers are not the public audience`, same frame as above.
- High Risk read: `Why: - requires attention: blocked`, same frame, no offer.
- Root or unknown folder: `[appa] invalid call: invalid call: arguments match no registered contract`.
- Wrong arguments, e.g. `to` as a string:
  `[appa] invalid call: invalid call: arguments do not satisfy the tool's registered schema: $.to: expected an array`.
- Audience source failure:
  `[appa] mcp/clearance/send: audience source rcpt gave no answer for addr/legal@hashirai-poc.test: it returned non-success status 1; …; the call was not checked`.
  This is a `deny_call`, not a `refuse`. The guard should log it as an error, not as a policy deny.

The narrowing on the first Legal/Accounting read, or on a `legal-handoff` load, is a
`deny_call` whose feedback starts `[appa] Blocked: mcp/clearance/drive_read cannot run yet.`,
says `allowed readers would narrow: public -> 1 reader`, and offers
`execute_remedy_plan(offer_id: "…")`. Replay takes it silently under `expect allow`. A later
read with the same audience in the same session is allowed with no offer.

## The audience source

`rcpt-audience.mjs` reads one consult request on stdin and prints
`{"version":1,"answer":{"members":["<email>"]}}` for selector `addr/<email>`. A member lookup
gets `{"principal":null}`. It exits 1 on anything else, including a templates list other
than `["addr/<email>"]`. The runtime runs it with `node` from `PATH`, with this config file's
directory as the working directory and a 2 s timeout (`[externals] timeout_ms`).
