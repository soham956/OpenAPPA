# Tasks: Hashirai Clearance POC

Source: `planning/stories.md` (S1–S12), `docs/architecture.md`, `docs/demo-script.md`. 1 SP = up to 20 min of Opus 5.5 at medium effort. Default model is Opus 5.5 medium. "Sonnet medium" means the smaller model (multiplier 0.7).
All paths are relative to the repo root. Every task also owns the `clearance/test/` files named in its row, and nothing else. **EXTERNAL** marks a task that needs inputs Soham has not provided yet.

## Before wave 1 (orchestrator, not counted in SP)
- P1. From the main checkout, run `cargo install --locked --path appa-runtime --force`. This puts `appa` on PATH from fork commit `7a3c42d`. Implementers use it through `APPA_BIN` and never build Rust in their worktrees.
- P2. Protect `main`, as the brief says.
- P3. External inputs. Done: the TypeSafe key, `GDRIVE_ROOT_FOLDER_ID` and `GDRIVE_AUTH=oauth` are in the repo-root `.env`. Still due before wave 4: the OAuth client JSON (Desktop app, Internal consent, scope `drive`) at `secrets/gdrive-oauth-client.json`.

## Agent roster (orchestrator, 2026-10-19)
Each agent is one named, persistent worker with a fixed model and effort. It keeps its lane across waves and is continued, not restarted, for its next task, cutting a fresh branch from up-to-date `main` in its own worktree. Every workbook row for its work, including rejected attempts, logs against its name (Tasks → Owner agent; totals on the Agents tab).

| Agent | Model / effort | Lane | Tasks (wave) |
|---|---|---|---|
| Quinn | Opus 5.5 high | Policy and sidecar | T9.1 (1), T10.1 (2), T10.2 (3) |
| Rowan | Opus 5.5 medium | Platform | T1.1 (1), T1.2 (2), T4.1 (3), T12.1 (4), T12.2 (5) |
| Sasha | Opus 5.5 medium | Drive | T3.1 (2), T3.2 (3), T3.3 (4) |
| Ellis | Opus 5.5 medium | Classifier | T5.1 (2), T5.2 (3) |
| Jules | Opus 5.5 medium | Poller | T7.1 (3) |
| Mika | Sonnet 5.5 medium | Seed data and decision log | T2.1 (1), T8.1 (2), T8.2 (3) |
| Remy | Sonnet 5.5 medium | Tools and `npm start` | T11.1 (2), T11.2 (3), T7.2 (4) |
| Noor | Opus 5.5 low | Fixture recording | T6.1 (4) |

## Shared-file rules
- **`clearance/package.json` and `package-lock.json`** are owned by T1.1 only. T1.1 declares every npm script up front, each pointing at a fixed entry file (`start`, `agent`, `reset`, `drop`, `compare`, `drive:check` → `tsx src/cli/<name>.ts`; `fixture:record`; `test`; `typecheck`; `policy:check`). It also creates a stub for each entry file that exits 1 with "not implemented: <task id>". Later tasks replace their own stub and never edit `package.json`. T1.1 pre-installs every known dependency: `googleapis`, `@typesafe-ai/sdk@0.7.0`, `@modelcontextprotocol/sdk`, `dotenv`, `tsx`, `typescript`, `vitest`, `@types/node`. If an implementer needs another dependency, they stop and report it, and the orchestrator lands it in a one-line `chore/deps-*` PR.
- **`.env.example`, `src/config.ts`, `src/util/jsonl.ts` and `src/log/schema.ts`** are created complete by T1.1 in wave 1. Later tasks import them but don't edit them. A needed change goes back to the orchestrator.
- **`clearance/appa.toml`** is owned by T9.1 only. **`.github/workflows/`** is owned by T1.2 only. **Root `.gitignore`** is owned by T1.1 only.
- **Merge order.** Wave 1: T1.1 first. Wave 2: T1.2 first, so every other open branch rebases onto a `main` that has CI and is checked before it merges.

## Wave 1: foundations (no dependencies)

**T1.1** · S1 · 2 SP · Opus 5.5 medium · `feat/T1.1-node-scaffold`
Task: Node 22 TS package in `clearance/` with all npm scripts, stub CLIs, config loader, JSONL util, log schema and ignore rules.
Owns: `clearance/package.json`, `clearance/package-lock.json`, `clearance/tsconfig.json`, `clearance/vitest.config.ts`, `clearance/.env.example`, `clearance/README.md`, `clearance/src/config.ts`, `clearance/src/util/jsonl.ts`, `clearance/src/log/schema.ts`, `clearance/src/cli/{start,agent,reset,drop,compare,drive-check,record-fixture}.ts` (stubs), `clearance/test/config.test.ts`, `clearance/test/jsonl.test.ts`, `.gitignore`.
Deps: none.
Accept (S1):
- `npm ci && npm test && npm run typecheck` pass on a fresh clone with Node 22, and `engines.node` is `>=22`.
- `git check-ignore .env secrets/x clearance/.env clearance/state/x clearance/logs/x clearance/node_modules/x` matches all of them.
- `config.ts` loads the repo-root `.env` (`../.env` from `clearance/`) and resolves `secrets/` from the repo root. `clearance/.env.example` says to copy it to the repo root.
- `.env.example` lists every demo-script key plus `APPA_BIN`, `APPA_PORT=8790` and `POLL_INTERVAL_MS`, with no secret values.
- `config.requireDrive()` throws a clear message when `GDRIVE_ROOT_FOLDER_ID` is unset (S3).
- `schema.ts` types match the demo-script `classify`, `enforce` (plus `"decision":"error"`) and outbox shapes.
- The README links to `docs/drive-setup.md` and `policy/README.md`.

**T2.1** · S2 · 1 SP · Sonnet medium · `feat/T2.1-seed-files`
Task: Write the 11 synthetic SPECIMEN seed files.
Owns: `clearance/seed/01-…10-*.txt`, `clearance/seed/new/11-vendor-invoice-0207.txt`, `clearance/test/seed.test.ts`.
Deps: none.
Accept (S2):
- All 11 files exist with the demo-script names, and each starts with `SPECIMEN`.
- Only 08 and 09 match `SPC-\d{4}-\d{4}`, and 01 contains `Matter Ref: LM-2026-0417`.
- All names are fictional.
- File 10 is half settlement terms, half instalment ledger.
- `seed.test.ts` asserts all of this. It runs once T1.1 has merged.

**T9.1** · S9 · 3 SP · Opus 5.5 high · `feat/T9.1-appa-policy`
Task: Policy and policy tests. First, spike array recipients (`@rcpt:addr/$to` with the node identity source) and switch to the documented fallback if it fails.
Owns: `clearance/appa.toml`, `clearance/policy/rcpt-audience.mjs`, `clearance/policy/README.md`, `clearance/policy-tests/*.appa`.
Deps: none (needs P1).
Accept (S9):
- `appa describe --config clearance/appa.toml --check` exits 0.
- `appa replay --config clearance/appa.toml clearance/policy-tests/` exits 0 with these trace files:
  - `2a`: Legal read allow, then send to both recipients deny.
  - `2b`: Legal read allow, then send to counsel deny.
  - `2c-agent1`: Legal read allow, then save to `legal-handoff` allow, then save to another scope deny.
  - `2c-agent2`: load `legal-handoff` allow, then send to counsel deny.
  - `2d`: Legal read allow, then send to legal@ allow.
  - `high-risk-read`: deny.
  - `unclassified-read`: root read deny.
  - `control`: send to counsel before any read allow.
- `policy/README.md` records the spike result and the exact argument schema for each tool.

Wave 1 total: **6 SP** (3 tasks).

## Wave 2: core modules

**T1.2** · S1 · 2 SP · Opus 5.5 medium · `feat/T1.2-ci` (merge first in this wave)
Task: One CI workflow. Delete the upstream workflows, build `appa` with caching, and run the tests and policy checks.
Owns: `.github/workflows/clearance-ci.yml`. Deletes the 13 upstream `.github/workflows/*.yml` files and `.github/dependabot.yml`.
Deps: T1.1, T9.1.
Accept (S1):
- Only `clearance-ci` runs on the PR.
- It restores the `appa` binary from `actions/cache`, keyed on the hash of `Cargo.lock`, `Cargo.toml`, `appa-*/**` and Rust 1.96. On a miss it runs `cargo build --locked -p appa`.
- It runs Node 22 `npm ci`, `npm run typecheck`, and `npm test` with `APPA_BIN` and `CLEARANCE_REQUIRE_APPA=1`.
- It runs `appa describe --config clearance/appa.toml --check` and `appa replay --config clearance/appa.toml clearance/policy-tests/`.
- It fails if a tracked file holds a secret value: `GOCSPX-` (Google client secret), a `"refresh_token": "1//` value, or a non-empty `TYPESAFE_API_KEY=`. Key names such as `client_secret` in code are fine.
- CI is green on the PR, and a re-run shows a cache hit.

**T3.1** · S3 · 2 SP · Opus 5.5 medium · `feat/T3.1-drive-client`
Task: `DriveClient` interface, the googleapis implementation and an in-memory fake.
Owns: `clearance/src/drive/{types,google,fake}.ts`, `clearance/test/drive-google.test.ts`, `clearance/test/drive-contract.test.ts`.
Deps: T1.1.
Accept (S3, S4):
- The Google implementation is tested with a stubbed `drive_v3`, with no network.
- Every query is scoped to the root folder or its 3 subfolders, with `supportsAllDrives` set.
- Listing the root excludes folders, and `ensureSubfolders` is idempotent.
- `folderOf` returns `root`, `legal`, `accounting`, `high-risk` or `other`.
- The fake passes the same contract suite and records every id it is asked about.

**T5.1** · S5 · 2 SP · Opus 5.5 medium · `feat/T5.1-classifier-core`
Task: ID rule, threshold decision and fixture store (replay, or record on a miss) keyed by sha256(content).
Owns: `clearance/src/classifier/{types,specimen,decide,fixture-store}.ts`, `clearance/test/classifier.test.ts`, `clearance/test/fixtures/classifications.sample.json`.
Deps: T1.1, T2.1.
Accept (S5):
- The ID rule runs first and skips Jev (08 and 09 → High Risk, `specimen-id`).
- A Jev answer below `CONFIDENCE_THRESHOLD` (read from env) → High Risk, `low-confidence`.
- A fixture hit → `"source":"fixture"`. A miss calls the injected Jev, records the answer and → `"source":"live"`.
- A miss with no key fails with a clear error.
- Jev never receives the file name.

**T8.1** · S8 · 1 SP · Sonnet medium · `feat/T8.1-decision-log`
Task: Decision log writer and reader on top of `schema.ts`.
Owns: `clearance/src/log/decision-log.ts`, `clearance/test/decision-log.test.ts`.
Deps: T1.1.
Accept (S8): Writes one line per call with `ts`, keeping demo-script field order, and reads lines back typed. Tests round-trip every demo-script example line.

**T10.1** · S10 · 3 SP · Opus 5.5 high · `feat/T10.1-sidecar-wire`
Task: Sidecar launcher, typed `/hook` client and remedy executor over MCP.
Owns: `clearance/src/sidecar/{runtime,wire,remedy}.ts`, `clearance/test/sidecar-wire.test.ts`, `clearance/test/sidecar-live.test.ts`, `clearance/test/fixtures/runtime/*.json`.
Deps: T1.1, T9.1.
Accept (S10):
- The launcher starts `appa runtime --adapter amp` on loopback with `state/appa.db` and waits for `/health`.
- A live test (temp DB; skipped only when `APPA_BIN` is absent and `CLEARANCE_REQUIRE_APPA` is unset) checks this sequence:
  - a Legal read gets `deny_call` with an Accept offer;
  - the remedy (`pass_control` → MCP `execute_remedy_plan` → `tool_result`) succeeds;
  - the retried read gets `allow_call`, then `ack`;
  - a send to counsel gets `deny_call` with no offers.
- The responses are recorded as fixtures.
- A timeout, non-JSON reply, `refuse` or a stopped runtime fails closed.

**T11.1** · S11 · 1 SP · Sonnet medium · `feat/T11.1-send-memory-tools`
Task: Mock `send` (outbox) and the memory save/load tools.
Owns: `clearance/src/tools/{send,memory}.ts`, `clearance/test/tools-send.test.ts`, `clearance/test/tools-memory.test.ts`.
Deps: T1.1.
Accept (S11):
- `send` appends exactly one outbox line `{to, subject, attachments, session}` per call and nothing when it throws.
- Memory is local JSON at `state/memory.json`, keyed by scope, with entries `{value, origin}`.
- Neither tool calls APPA.

Wave 2 total: **11 SP** (6 tasks).

## Wave 3: integration modules

**T3.2** · S3 · 2 SP · Opus 5.5 medium · `feat/T3.2-drive-auth`
Task: `GDRIVE_AUTH` switch (oauth or service-account), OAuth loopback consent with a token cache, factory, `npm run drive:check`, setup doc.
Owns: `clearance/src/drive/{auth,factory}.ts`, `clearance/src/cli/drive-check.ts`, `clearance/docs/drive-setup.md`, `clearance/test/drive-auth.test.ts`.
Deps: T1.1, T3.1.
Accept (S3):
- Switching `GDRIVE_AUTH` needs no code change (both branches unit-tested with stubs).
- The token is cached at `secrets/gdrive-token.json` (repo root), and the scope is `drive`.
- It refuses clearly if the folder ID or the client JSON is missing.
- `drive:check` lists the root and ensures the subfolders, tested against the fake.
- The live run is T3.3.

**T4.1** · S4 · 1 SP · Opus 5.5 medium · `feat/T4.1-reset-drop`
Task: `npm run reset` and `npm run drop`.
Owns: `clearance/src/reset/reset.ts`, `clearance/src/cli/{reset,drop}.ts`, `clearance/test/reset.test.ts`.
Deps: T1.1, T3.1.
Accept (S4):
- Against the fake: it trashes everything under the root tree, ensures the subfolders and uploads seed 01–10.
- It archives `logs/` to `runs/<stamp>/` and deletes `state/appa.db*`, `state/memory.json` and `state/poller.json`.
- It refuses while the sidecar answers `/health`.
- Two resets in a row give the same state.
- The fake shows no call on any id outside the root tree.
- `drop` uploads `seed/new/11-*` to the root.

**T5.2** · S5 · 1 SP · Opus 5.5 medium · `feat/T5.2-jev-adapter`
Task: TypeSafe `choice()` adapter and the `npm run fixture:record` CLI.
Owns: `clearance/src/classifier/jev.ts`, `clearance/src/cli/record-fixture.ts`, `clearance/test/jev.test.ts`.
Deps: T5.1.
Accept (S5, S6):
- The SDK is mocked in tests. Only content is sent, as a {Legal, Accounting} choice.
- A missing key errors only when a live call is needed.
- The CLI records all 11 seeds into `fixtures/classifications.json`, sorted by hash with the file name kept as a note field.

**T7.1** · S7 · 2 SP · Opus 5.5 medium · `feat/T7.1-poller`
Task: Root poller: classify, move, log.
Owns: `clearance/src/poller/poller.ts`, `clearance/test/poller.test.ts`.
Deps: T3.1, T5.1, T8.1.
Accept (S7), tested with the fake Drive and a stub classifier:
- 10 root files are moved and logged in one tick.
- A file added later is moved on the next tick without a restart.
- Subfolder files are never touched.
- Seen ids persist in `state/poller.json`, so a restart doesn't log a file twice.
- A failed file stays in the root and is retried on the next tick.

**T8.2** · S8 · 1 SP · Sonnet medium · `feat/T8.2-compare`
Task: `npm run compare` and `expected-decisions.json`.
Owns: `clearance/src/log/compare.ts`, `clearance/src/cli/compare.ts`, `clearance/expected-decisions.json`, `clearance/test/compare.test.ts`.
Deps: T8.1, T2.1.
Accept (S8):
- It ignores `ts`, Drive ids and offer ids, and sorts `classify` lines by file.
- It prints `identical`, or the first differing line and exits 1.
- `--expected` checks one run against the expected file: 11 classify lines, 4 read allows, the `2a`/`2b`/`2c-save`/`2c-load`/`2c`/`2d` lines and the one outbox line.

**T10.2** · S10 · 3 SP · Opus 5.5 high · `feat/T10.2-guard`
Task: The guard: sessions, trusted args, narrowing acceptance, tool run and `tool_result`, reason rewrite, `enforce` lines.
Owns: `clearance/src/sidecar/{guard,reasons,audiences}.ts`, `clearance/test/guard.test.ts`, `clearance/test/reasons.test.ts`, `clearance/test/fixtures/runtime/guard/*.json`.
Deps: T10.1, T8.1, T9.1, T11.1, T3.1.
Accept (S10):
- The exact 2a, 2b and 2c reason strings from the demo script, checked on recorded responses.
- A denied call never invokes its tool (spy).
- A runtime error refuses the call and logs `"decision":"error"`.
- A `folder` supplied by the agent is overwritten from Drive.
- Narrowing is accepted only for `drive_read` and `memory_load`.
- A test checks that `audiences.ts` matches `appa.toml`.

**T11.2** · S11 · 1 SP · Sonnet medium · `feat/T11.2-drive-tools`
Task: `drive_list` and `drive_read` tools.
Owns: `clearance/src/tools/drive.ts`, `clearance/test/tools-drive.test.ts`.
Deps: T3.1.
Accept (S11): `drive_list(folder)` returns names and ids. `drive_read(fileId)` returns `{name, content, folder}`. Both work alone on the fake, with no APPA calls.

Wave 3 total: **11 SP** (7 tasks).

## Wave 4: entry points

**T7.2** · S7 · 1 SP · Sonnet medium · `feat/T7.2-start`
Task: `npm start`: start the sidecar, then the poller. Ctrl-C stops both.
Owns: `clearance/src/cli/start.ts`, `clearance/test/start.test.ts`.
Deps: T7.1, T10.1, T3.2.
Accept (S7, S10): Waits for `/health` before the first poll, refuses without the folder ID, and shuts down cleanly. Tested with an injected fake Drive and a stub sidecar.

**T12.1** · S12 · 2 SP · Opus 5.5 medium · `feat/T12.1-scripted-agent`
Task: The scripted agent and `npm run agent`.
Owns: `clearance/src/agent/script.ts`, `clearance/src/cli/agent.ts`, `clearance/test/agent.test.ts`.
Deps: T10.2, T11.1, T11.2, T3.2.
Accept (S12):
- agent-1 lists Legal, reads 01–04, runs 2a, then 2b (with `LM-2026-0417` taken from 01 by regex), then 2c-save.
- agent-2 runs 2c-load, then the 2c send.
- agent-1 runs 2d.
- The agent prints each decision and reason. Session ids are fixed.
- A stub-guard test checks the exact call sequence and arguments.

Wave 4 also runs T6.1 and T3.3 (listed below; moved up from wave 5 by the orchestrator, as the inputs arrived early). They own no file that T7.2 or T12.1 own.

Wave 4 total: **5 SP** (4 tasks).

## Wave 5: end to end (T6.1 and T3.3 below run in wave 4)

**T12.2** · S12 · 2 SP · Opus 5.5 medium · `feat/T12.2-e2e-step2`
Task: CI end-to-end test of step 2 with the real `appa` sidecar and a fake Drive.
Owns: `clearance/test/e2e/step2.test.ts`, `clearance/test/e2e/helpers.ts`.
Deps: T12.1, T8.2.
Accept (S12): The fake Drive is seeded with 01–10 already classified. The `enforce` lines and outbox pass `compare --expected`. The outbox holds exactly the 2d line. A second run on a fresh DB gives identical lines. The test runs in CI.

**T6.1** · S6 · 1 SP · Opus 5.5 low · `feat/T6.1-record-fixture` · **EXTERNAL: TypeSafe key**
Task: Record the Jev fixture live for all 11 files, commit it, and add the full-fixture classifier test.
Owns: `clearance/fixtures/classifications.json`, `clearance/test/classifier-fixture.test.ts`. It may edit `clearance/seed/10-settlement-payment-schedule.txt` only to re-record.
Deps: T5.2, T2.1.
Accept (S6, S5):
- File 10 records below 0.70. The other files outside the ID rule record ≥ 0.70 with the expected label.
- The fixture is never hand-edited.
- With no key, the test gives the demo label and rule for all 11 files, all `"source":"fixture"`.

**T3.3** · S3 · 1 SP · Opus 5.5 medium · `feat/T3.3-live-drive` · **EXTERNAL: OAuth client JSON + Drive folder ID; Soham at a browser for the first consent**
Task: Live Drive check against the real folder. Fix any Workspace or Shared Drive quirks.
Owns (fixes only): `clearance/src/drive/{google,auth}.ts`, `clearance/docs/drive-setup.md`.
Deps: T3.2, T4.1.
Accept (S3, S4):
- `npm run drive:check` lists the root and creates the subfolders.
- A second run needs no browser (token cached in `secrets/`).
- `npm run reset` twice gives the step 0 state. `npm run drop` uploads file 11.
- `git grep` finds no secret.

Wave 5 total: **2 SP** (1 task: T12.2).

## Wave table

| Wave | Tasks | Baseline SP |
|---|---|---|
| 1 | T1.1, T2.1, T9.1 | 6 |
| 2 | T1.2, T3.1, T5.1, T8.1, T10.1, T11.1 | 11 |
| 3 | T3.2, T4.1, T5.2, T7.1, T8.2, T10.2, T11.2 | 11 |
| 4 | T7.2, T12.1, T6.1, T3.3 | 5 |
| 5 | T12.2 | 2 |
| **Total** | **21 tasks** | **35** |

**Why 35 and not 24.**
- S10 (+3): a read that narrows the label is blocked until an Accept remedy runs over MCP `/mcp`. The stories didn't know this, so the wire and remedy work (T10.1) is split from the guard (T10.2).
- S12 (+2): T12.2 adds a CI end-to-end test against the real sidecar, so step 2 is checked on every PR without secrets.
- S3 (+2): the live Drive check (T3.3) is split out so the code can land before the OAuth client exists.
- S1 (+2): CI, with the cached cargo build and the workflow removal, is its own task.
- S7 (+1) and S8 (+1): `npm start` and the compare/expected file had no owner in the stories.
