# Status: Hashirai Clearance POC

_Last updated 2026-10-19_

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
- OpenAPPA checked (v0.35.1, commit `7a3c42d`). Steps 2a–2d can be built on it:
  - **Taint is per session.** 2b is caught natively, but it over-blocks: every external send after a Legal read is refused.
  - **2c:** no per-record memory labels. Use scoped-memory audiences (`@mem:scope/$scope`).
  - **2d:** recipients match exact reader IDs, so stub an `internal` member list.
  - **Refusals:** the runtime writes the deny text. Rewrite it in the TS hook client.
  - **Node:** no binding. Use the `appa runtime` HTTP sidecar (see `integrations/opencode/appencode.ts`).
  - **Rust:** 1.96.

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

## In progress
- Phase 2 dev lead agent (background): `docs/architecture.md` and `planning/tasks.md`.

## Next
1. Review Phase 2. Build `planning/Hashirai Clearance POC - Plan.xlsx` (Stories, Tasks, Calibration, Summary).
2. Checkpoint: send Soham the workbook and a five-line summary, then wait for his go-ahead.
3. Soham (before the build): creates the OAuth client (Internal, Drive scope) and saves it to `secrets/gdrive-oauth-client.json`; creates the Drive test folder and shares its ID; puts `TYPESAFE_API_KEY` in `.env`.
4. Phase 3: protect `main`, then dispatch wave 1.

## Blockers
- OAuth client JSON and the Drive test folder ID (auth method decided: OAuth, Internal). Needed for the build only.
- TypeSafe key (only needed for the build).

## Environment note
Soham may continue from the Claude Code desktop app instead of the terminal. `gh` is at `~/.local/bin/gh`, which may not be on that app's PATH, so call it by its full path.
