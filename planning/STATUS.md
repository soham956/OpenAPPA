# Status: Hashirai Clearance POC

_Last updated 2026-10-19: **POC done.** All 21 tasks merged, Phase 4 accepted._

## Done
- Brief read (`ORCHESTRATOR.md`). Phase 0 questions sent.
- Answers from Soham:
  - **Fork:** personal GitHub.
  - **TypeSafe key:** he can get one; it goes in `.env` as `TYPESAFE_API_KEY`.
  - **Sending:** mock outbox is OK.
  - **Secrets:** git-ignored `.env` and `secrets/`.
  - **Drive:** his **company** Google Workspace Drive. Auth method not picked yet.
- Tools installed:
  - `gh` 2.102 at `~/.local/bin/gh` (Homebrew failed: it needs the Command Line Tools on Tahoe)
  - Rust via rustup (`~/.cargo/bin`, cargo 1.99)
  - Node 22.22 was already here. `@typesafe-ai/sdk` 0.7.0 needs Node 22 or later, not 20.
- OpenAPPA checked (v0.35.1, commit `7a3c42d`). Steps 2a–2d can be built on it. Re-verified against the code by the Phase 2 dev lead; corrections are marked:
  - **Taint is per session (one label per trajectory).** 2b is caught natively, but it over-blocks: every external send after a Legal read is refused.
  - **2c (corrected):** `@mem:scope/$scope` is not an existing feature. A `@provider:sel/$arg` placeholder needs our own audience-source command. The plan instead uses per-scope contracts, `memory_save(scope:legal-handoff)` and `memory_load(scope:legal-handoff)`, with a literal reader audience. Replay is one trajectory per file, so 2c needs two trace files.
  - **2d (corrected):** literal readers work in `delta.audience` with no member list (`examples/tests/secret-stays-inside`), so no `internal` stub resolver is needed. But `contains = ["$to"]` needs `to` to be a single string. Multi-recipient sends use `contains = ["@rcpt:addr/$to"]` with a small identity audience source (T9.1 spikes this; there is a per-recipient fallback).
  - **New: a narrowing is a block.** A read whose `delta` narrows the label returns `deny_call` with an Accept offer. The client must run it: `tool_call` for `mcp__appa__execute_remedy_plan` → `pass_control` → MCP `tools/call` on `/mcp` → `tool_result`. Then it retries. `appa replay` accepts this silently under `expect allow`.
  - **Refusals:** the runtime writes the deny text (`deny_call.feedback`, prefixed `[appa]`). There is no custom reason field, so the TS hook client rewrites it. Outright denial uses `requires.attention = ["blocked"]`.
  - **Node:** no binding. Use the `appa runtime` HTTP sidecar. The simpler model is `integrations/amp/amppa.ts` with `--adapter amp` (no inventory or child plumbing), rather than `appencode.ts`.
  - **New: labels persist** in the runtime's SQLite DB across restarts. `reset` must delete it, or run 2 diverges from run 1.
  - **Rust:** 1.96 (`mise.toml`). Build with `cargo build --locked -p appa` or `cargo install --locked --path appa-runtime`. `build.rs` embeds git HEAD, so CI caches the binary rather than `target/`.

## Phase 1 (product agent): accepted by orchestrator, 2026-10-19
- `docs/demo-script.md` (steps 0–4) and `planning/stories.md` (S1–S12, 24 baseline SP). Agent runtime ~3.9 min.
- Notes for the Phase 2 dev lead:
  - Put our code in a `clearance/` subfolder of the fork. The fork root is the upstream Rust workspace, with no `package.json`.
  - Disable or path-filter the upstream `.github/workflows` (vercel deploy, coreteam review, releases), so only our CI runs on PRs.
  - S1/CI must build the `appa` CLI from the fork (cargo), and cache it.
  - 2b reason text is the same as 2a because taint is per session. That's accepted for the POC; per-value taint is on the Later list.
- Soham's answers (2026-10-19):
  - Agent is **scripted**.
  - 2b/2c use the **matter reference** `LM-2026-0417`.
  - Jev uses a **recorded fixture**.
  - Drive uses **OAuth with an Internal consent screen**, client JSON at `secrets/gdrive-oauth-client.json`. S3 stays at 3 SP.

## Repo
- Fork: https://github.com/soham956/OpenAPPA (public, `gh` logged in as soham956). `origin` = fork, `upstream` = archestra-ai/OpenAPPA.
- Commits on `main`: `47b654e9` brief (`docs/orchestrator-brief.md`; root `ORCHESTRATOR.md` is a symlink to it) plus `.gitignore` for `secrets/` and `.env.*`; `b7135837` Phase 1 docs.
- GitHub Actions are enabled on the fork. S1 must disable the upstream workflows (`gh workflow disable` or delete them) so only our CI runs.
- `main` protection is deferred to the start of Phase 3, so the orchestrator can still commit the workbook and docs.

## Phase 2 (dev lead agent): accepted by orchestrator, 2026-10-19
- `docs/architecture.md` and `planning/tasks.md`: 21 tasks, 35 baseline SP (34.85 adjusted), 5 waves. Agent runtime ~11.6 min. The OpenAPPA findings above were corrected by it.
- Orchestrator edits on review:
  - `.env` stays at the repo root (`config.ts` loads `../.env`).
  - T6.1 and T3.3 moved to wave 4, because the inputs arrived early. Waves are now 6 / 11 / 11 / 5 / 2 SP.
  - The CI secret scan matches secret values (`GOCSPX-`, refresh tokens, a filled `TYPESAFE_API_KEY=`), not key names.
  - T1.1 moved to Opus 5.5 medium, since it owns the shared schema and config.
  - Demo-script setup line: run npm from `clearance/`; `.env` and `secrets/` are at the root.
- Workbook built: `planning/Hashirai Clearance POC - Plan.xlsx` (Stories, Tasks, Calibration, Summary). Formulas are live. Every formula was evaluated with no errors (pycel; LibreOffice isn't installed). Builder script: kept in the session scratchpad, not in the repo.

## External inputs: all in (2026-10-19)
- Repo-root `.env` (mode 600): `TYPESAFE_API_KEY` (not yet tested live), `GDRIVE_ROOT_FOLDER_ID`, `GDRIVE_AUTH=oauth`.
- `secrets/gdrive-oauth-client.json` (mode 600): Desktop app client from GCP project `hashirai-clearance-poc`, Internal consent screen. The first `drive:check` (T3.3) needs Soham at a browser for consent.
- Drive test folder: "Hashirai Clearance POC test" in Soham's company My Drive (empty).
- P1 done: `appa` 0.35.1 installed from the fork at `~/.cargo/bin/appa`.

## Phase 3 (build): started 2026-10-19 on Soham's go-ahead
- `main` protected: PR required (0 approvals), admins included, linear history, no force-push or delete. Merges are rebase-only and branches auto-delete. The required CI check is added after T1.2 merges.
- All 13 upstream workflows disabled in the fork (`disabled_manually`). T1.2 deletes the files.
- Named agent roster (Soham's request): see `planning/tasks.md` → Agent roster, and the workbook's Agents tab. Logs go per agent, not per task.
- Orchestrator changes to docs and the workbook now go through `chore/orchestrator-*` PRs.

## Wave 1: done, 2026-10-19 (all merged to `main`, which passes vitest 30/30, typecheck and replay 8/8)
| Task | Agent | PR | Runtime | Result |
|---|---|---|---|---|
| T1.1 scaffold | Rowan | #4 | 5.8 min | Accepted first time |
| T2.1 seed files | Mika | #2 | 2.3 + 0.5 min | Attempt 1 rejected (strict-tsc error, seen only in the combined check); accepted after rework |
| T9.1 policy | Quinn | #3 | 5.6 min | Accepted. Primary recipient approach works (no fallback) |
- Stories S1, S2 and S9 are done.
- **Estimate signal:** wave 1 ran at about 8–20% of its adjusted estimate. That's one wave, so no recalibration yet; see the Agents and Calibration tabs.
- Review practice: before merging, the orchestrator applies a wave's PRs together in a scratch worktree and runs everything. That's how T2.1's error was caught.
- Merging: Soham allowed `gh pr merge -R soham956/OpenAPPA --rebase <n>` in `.claude/settings.local.json` (git-ignored; `--admin` and `--auto` are denied).
- Notes for wave 2:
  - T1.2's secret scan must skip `planning/` and `docs/`, which describe the `TYPESAFE_API_KEY=` rule.
  - `drive_list` logs as step `read`.
  - Quinn's `clearance/policy/README.md` holds the tool argument schemas and the exact deny feedback.

## Wave 2: merged 2026-10-19 (CI-gated; main green)
| Task | Agent | PR | Runtime | Result |
|---|---|---|---|---|
| T8.1 decision log | Mika | #6 | 0.9 min | Accepted |
| T11.1 send and memory tools | Remy | #7 | 1.6 min | Accepted |
| T5.1 classifier core | Ellis | #8 | 2.9 min | Accepted. One commit doesn't typecheck alone; the tip is fine |
| T3.1 Drive client | Sasha | #9 | 4.5 min | Accepted. Trash is soft; nothing outside the tree is touched |
| T10.1 sidecar wire and remedy | Quinn | #10 | 6.3 min | Accepted. The live remedy flow works against the real `appa` |
| T1.2 CI | Rowan | #11 | 1.7 + 6.4 min (paused 9.7 min while blocked) | Accepted. Cold run 4m31s, cached run 19s. `clearance-ci` is now a required check on `main` |
- Combined wave 2 check (#6–#10 together): vitest 128/128 including the live APPA tests, typecheck ok, replay 8/8.
- For T10.2: the live deny feedback differs from replay (host tool names, no "Alternative" block). Match on Quinn's recorded fixtures in `clearance/test/fixtures/runtime/`.

## Wave 3: merged 2026-10-19 (combined check 220/220, including the live APPA tests)
| Task | Agent | PR | Runtime | Result |
|---|---|---|---|---|
| T11.2 Drive tools | Remy | #14 | 1.9 min | Accepted |
| T8.2 compare and expected | Mika | #15 | 3.1 min | Accepted |
| T7.1 poller | Jules | #16 | 2.6 min | Accepted |
| T4.1 reset and drop | Rowan | #17 | 3.2 min | Accepted. Factory wired later in #21 |
| T5.2 Jev adapter | Ellis | #18 | 3.8 min | Accepted. Ruling: the fixture holds 9 files (08 and 09 never reach Jev) |
| T3.2 Drive auth | Sasha | #19 | 4.1 min | Accepted |
| T10.2 guard | Quinn | #20 | 7.1 min | Accepted |

## Wave 4: merged 2026-10-19
| Task | Agent | PR | Result |
|---|---|---|---|
| T4.1 follow-up: wire the Drive factory | Rowan | #21 | Merged |
| T7.2 `npm start` | Remy | #22 | Accepted |
| T5.1 rework: tests independent of the seed text | Ellis | #23 | The original T5.1 attempt is logged as rejected (found by Noor) |
| T6.1 live Jev fixture | Noor | #25 | 3 recording runs. Seed 10 edited, now Legal **0.66** (thin margin against 0.70) |
| T12.1 scripted agent | Rowan | #24 | Attempt 1 rejected: an unguarded listing. Attempt 2 adds a guarded `drive_list` under the new `list` step |
| T10.2 follow-up: log the caller's step | Quinn | #27 | Merged |
| T8.2 follow-up: expected `list` line | Mika | #26 | Merged |
| T3.3 live Drive | Sasha | (no PR) | Passed with no fixes. Drive is in the step 0 state |
- Soham did the OAuth consent at 13:47Z; the token is in `secrets/` (mode 600).
- Reset takes 23–45 s on Workspace Drive, so do it before a run, not live. Reset trashes files (soft), so Soham may want to empty the Drive trash after the demo.
- Stories done: S1–S6, S9, S10, S11. S7, S8 and S12 wait for T12.2 and the demo runs.

## Wave 5 and Phase 4: done 2026-10-19
- T12.2 end-to-end step 2 test (Rowan, #29) runs in CI against the real `appa`. CI: 242 tests across 23 files.
- **Phase 4 acceptance:** two full runs of `docs/demo-script.md` against the real Workspace Drive, each from a clean state. `compare run1 run2` → **identical**, and both runs → **matches expected**. Logs are in `docs/demo-runs/` (Drive IDs stripped; the repo is public). Drive was left in the step 0 state.
- **All 12 stories done.** Agent runtime totalled 89.4 min (4.5 SP), against 34.85 adjusted task SP (13%) and 24.45 adjusted story SP (18%). Rework: T2.1, T5.1 and T12.1 each had one rejected attempt.
- **Calibration, implied multiplier (raw ÷ baseline):**
  - Opus medium 0.13 (11 tasks)
  - Opus high 0.12 (3 tasks)
  - Sonnet medium 0.11 (6 tasks)
  - Opus low 0.19 (1 task, noisy)

  1 SP = 20 min was about 7× too generous for well-specified tasks. High effort wasn't measurably slower than medium.

## After acceptance (2026-10-19)
- **Live stall during a recording rehearsal.** A Drive request hung for minutes, because the client had no timeout. Fixed as T3.1 rework by Sasha (#32): 20 s timeouts and safe retries.
- **Independent code review**, merged as `docs/poc-review.md` (#31). It found 6 must-fix items. Soham chose to fix C2 and C6 now: T10.2 rework by Quinn (#33), so the guard fails closed when a file's folder changes between check and read, and `Guard.call` never throws. The rest is on the Later list in `planning/stories.md`.
- **Re-checked live after both fixes:** identical to Phase 4 run 1, and matches expected.
- **Videos:** the explainer reel is in `media/reel/out/final.mp4`. Soham recorded the real-run screen video. Both are git-ignored, local only.
- **Separate sessions:** the story-point and process analysis, and the code review.

## Next
- The real build. Start from the Later list, beginning with the review's must-fix items, and from the build-on-or-bin notes.

## Blockers
- None.

## Environment note
Soham may continue from the Claude Code desktop app instead of the terminal. `gh` is at `~/.local/bin/gh`, which may not be on that app's PATH, so call it by its full path.
