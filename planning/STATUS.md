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

## In progress
- `gh auth login --web` is running in the background via a device code. The terminal-tab version stopped responding to input after the shell reconnected.

## Next
1. Soham logs in to GitHub (`gh auth login --web`, signing in via SSO in the browser). Then check whether the account is enterprise-managed, since that may block forking.
2. Fork OpenAPPA, then in this folder: `git init`, add the fork as `origin`, fetch, check out `main`. Commit the brief as `docs/orchestrator-brief.md`.
3. Soham creates the OAuth client (Internal, Drive scope) in a Workspace GCP project and saves the JSON to `secrets/gdrive-oauth-client.json`. He also creates the test folder and gives us its ID.
4. Phase 2: dev lead agent (architecture.md, tasks, waves), then build the workbook and run the checkpoint with Soham.

## Blockers
- GitHub login: password login fails, but SSO works in the browser.
- Drive auth method and OAuth client JSON.
- TypeSafe key (only needed for the build).

## Environment note
Soham may continue from the Claude Code desktop app instead of the terminal. `gh` is at `~/.local/bin/gh`, which may not be on that app's PATH, so call it by its full path.
