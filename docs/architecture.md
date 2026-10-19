# Architecture: Hashirai Clearance POC

Scope is `docs/demo-script.md` and nothing more. Our code lives in `clearance/` (Node 22, TypeScript run with `tsx`). The fork root stays upstream OpenAPPA at `7a3c42d`; we only add `clearance/` and one CI workflow.

## Components and data flow

```
Drive test folder ─poll 10 s─▶ Poller ─▶ Classifier ─move─▶ Legal/ | Accounting/ | High Risk/
 (root only)                     │        ID rule → fixture/Jev → 0.70 threshold
                                 └──────────────▶ logs/decisions.jsonl  (classify)
Scripted agent ─guard.call()─▶ Hook client ─POST /hook, /mcp─▶ appa runtime (sidecar)
 agent-1, agent-2               │  allow → run tool → tool_result        --adapter amp, appa.toml, state/appa.db
                                ├──▶ logs/decisions.jsonl (enforce)
                                └──▶ tools: drive_list/drive_read (Drive), send (logs/outbox.jsonl), memory_save/load (state/memory.json)
```

| Component | Module | Job |
|---|---|---|
| Drive client | `src/drive/` | `DriveClient` interface: list, read, move, upload, trash, ensure subfolders, `folderOf(id)`. Google impl (OAuth or service account) and an in-memory fake used by every other test. |
| Classifier | `src/classifier/` | SPECIMEN regex `SPC-\d{4}-\d{4}` first (rule `specimen-id`). Else fixture lookup by sha256(content), live Jev `choice()` over {Legal, Accounting} on a miss. Below `CONFIDENCE_THRESHOLD` → High Risk (rule `low-confidence`). Content only, never the file name. |
| Poller | `src/poller/` | Lists the root every 10 s, classifies, moves, logs. Never looks inside subfolders. |
| Decision log | `src/log/` | One JSONL writer; `schema.ts` holds the `classify`, `enforce` and `outbox` line types from the demo script. `compare` diffs two runs or one run against `expected-decisions.json`. |
| Sidecar | `src/sidecar/runtime.ts` | Spawns `appa runtime --adapter amp --listen 127.0.0.1:$APPA_PORT --config appa.toml --db state/appa.db`, waits for `/health`. |
| Hook client | `src/sidecar/wire.ts`, `remedy.ts`, `guard.ts` | The trusted harness. Speaks the `/hook` wire (`protocol: 1`, `adapter: "amp"`), modelled on `integrations/amp/amppa.ts`. |
| Tools | `src/tools/` | Plain functions. They never call APPA; only the guard does. |
| Scripted agent | `src/agent/` | Fixed sequence, fixed session ids `agent-1` and `agent-2`. |

**One guarded call.** (1) `session_start` + `prompt` once per session. (2) The guard fills trusted arguments itself: `folder` comes from `DriveClient.folderOf`, never from the agent. (3) `tool_call` with raw name `mcp__clearance__<tool>` (canonical `mcp/clearance/<tool>`). (4) `allow_call`: run the tool, post `tool_result` with the body, apply `ack` / `deliver_value` / `replace_output` / `block`. (5) `deny_call` carrying an Accept (narrowing) offer on `drive_read` or `memory_load`: run the remedy, which is a `tool_call` for `mcp__appa__execute_remedy_plan` → `pass_control` → MCP `tools/call execute_remedy_plan {offer_id}` on `/mcp` → `tool_result`. Then retry once. (6) `deny_call` without offers: the tool never runs, and the guard returns the short reason. (7) A transport error, timeout or `refuse` fails closed. (8) `turn_end` when the session's work is done. Each attempt writes one `enforce` line. Step tags: `read`, `2a`, `2b`, `2c-save`, `2c-load`, `2c`, `2d`.

**Reasons.** The runtime authors deny text (`feedback`, prefixed `[appa]`). There is no custom reason field. The guard rewrites it only on a runtime deny, never decides locally, and builds the text from the session's label source. That source is set when the guard accepts a narrowing: `file` (Legal) or `memory` (scope, origin Legal). The allowed list comes from `src/sidecar/audiences.ts`, and a test checks it against `appa.toml`. An unknown deny passes the runtime text through.

## Policy design (`clearance/appa.toml`)

| Contract | Rule | Demo step |
|---|---|---|
| `drive_read(folder:legal)`, `drive_read(folder:accounting)` | `delta = { audience = ["legal@hashirai-poc.test"] }` (one-member internal stub, literal reader) | reads |
| `drive_read(folder:high-risk)` | `requires = { attention = ["blocked"] }` | hold |
| `drive_read` for `root` or anything else | no contract, so it is refused | unclassified |
| `drive_list(folder:legal\|accounting)` | `delta = {}` | listing |
| `send`, `to` = array of strings | `requires = { audience = { contains = ["@rcpt:addr/$to"] } }`; `[externals.audience.rcpt]` is a 10-line node identity source (`addr/<email>` → `[email]`), so every recipient must already be a reader | 2a deny, 2b deny, 2d allow |
| `memory_save(scope:legal-handoff)` / other scopes | `requires contains ["legal@hashirai-poc.test"]` / `["public"]` | 2c save allow |
| `memory_load(scope:legal-handoff)` / other scopes | `delta = { audience = ["legal@hashirai-poc.test"] }` / `{}` | 2c load narrows agent-2, then send to counsel is denied |

The label is per trajectory, so 2b gets the same reason as 2a. 2c crosses sessions because the memory scope has a fixed audience; APPA does not carry labels between trajectories. Replay runs one trajectory per file, so 2c is two trace files. **Fallback** if the array-recipient spike in T9.1 fails: `to` becomes one string with `contains = ["$to"]`, and the guard checks a multi-recipient send once per recipient. It sends only if all are allowed, and settles the allowed dispatches with a `failure` outcome.

**High Risk hold.** The classifier moves the file to `High Risk/`. The guard resolves the folder from Drive at call time and the policy blocks that folder. When a person moves the file out in Drive, the next read sees the new folder, so no release code is needed. This is pinned by `policy-tests/high-risk-read.appa`.

## Module layout

```
clearance/  package.json  tsconfig.json  vitest.config.ts  .env.example  README.md  appa.toml  expected-decisions.json
  policy/rcpt-audience.mjs  policy/README.md      policy-tests/*.appa        seed/*.txt  seed/new/11-*.txt
  fixtures/classifications.json                   docs/drive-setup.md
  src/config.ts  src/util/jsonl.ts  src/log/{schema,decision-log,compare}.ts
  src/drive/{types,google,fake,auth,factory}.ts   src/classifier/{types,specimen,decide,fixture-store,jev}.ts
  src/poller/poller.ts  src/sidecar/{runtime,wire,remedy,guard,reasons,audiences}.ts
  src/tools/{drive,send,memory}.ts  src/agent/script.ts  src/cli/{start,agent,reset,drop,compare,drive-check,record-fixture}.ts
  test/**  (state/, logs/, runs/ are git-ignored; all npm commands run from clearance/; `.env` and `secrets/` stay at the repo root, and `config.ts` loads `../.env`)
.github/workflows/clearance-ci.yml   (all upstream workflows deleted)
```

## Key risks and how the plan handles them

1. **A narrowing is itself a block.** A Legal read returns `deny_call` with an Accept offer, and the remedy goes through MCP. Replay accepts it silently, so policy tests can't catch client bugs. T10.1 tests it against a live runtime, and T12.2 runs step 2 end to end in CI.
2. **Array recipients in a selector placeholder** are supported by the engine (`contract.rs` tests), but our identity source is unproven. T9.1 spikes this first; the fallback is above.
3. **Run 2 must match run 1.** The runtime DB keeps labels across restarts, so `reset` deletes `state/appa.db*`, memory and poller state, and refuses while the sidecar is up. Jev comes from the fixture. `compare` ignores timestamps, Drive ids and offer ids.
4. **External inputs** (TypeSafe key, OAuth client, folder ID) are only needed in wave 4 (T6.1, T3.3). CI needs none: it uses the fixture, the fake Drive and the real `appa`.
5. **Rust build cost.** `appa-runtime/build.rs` embeds git HEAD, so caching `target/` alone still rebuilds the crate on every commit. CI caches the binary, keyed on a hash of the Rust sources. Locally, `appa` is installed once before wave 1, so worktrees don't each compile the workspace.
6. **OpenAPPA is a preview.** Pin the fork at `7a3c42d` and don't merge upstream during the build. `/hook` is unauthenticated, so it listens on loopback only.
