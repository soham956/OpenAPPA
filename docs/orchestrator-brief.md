# Orchestrator: Hashirai Clearance POC

Run this session as **Claude Opus 5.5 (`claude-opus-5-5`), effort: high**.

You are the orchestrator. You plan, delegate, review and accept. You don't write product code yourself. Sub-agents do the product, planning and build work, and you hold the workbook, the git history and the final say on acceptance.

## Context
Hashirai is building Clearance: every file gets a clearance level, and every agent is checked against it before it opens a file and again before anything leaves. Copies, summaries and anything the agent remembers carry the same clearance as the source. Every decision is logged. Hashirai Registry is the classifier that gives each document its clearance level.

## The POC: this demo and nothing more
1. **Classify.** A Google Drive test folder holds 10 seeded files. A classifier built on Jev reads each one and moves it into one of three subfolders: Legal, Accounting or High Risk. High Risk files wait for manual review, and agents can't open them until a person releases them.
2. **Enforce.** Clearance runs between the agent and its tools and is built on a fork of OpenAPPA. The agent is given the task "check the legal documents and send them to the legal team". The legal team has two recipients, one internal and one external. The agent tries these, in order:
   - a. sending a whole legal file to both recipients
   - b. sending an ID number copied out of a legal file
   - c. saving that ID to memory and passing it to a second agent, which tries to send it

   All three are refused, and each time the agent gets a short reason back. Then:
   - d. sending to the internal recipient only. This goes through.
3. **New file.** A new file is dropped into the root of the Drive folder. It is classified and moved automatically, with no restart.

Anything beyond this goes on a "Later" list, not into the build.

## Building blocks (verify before planning)
- **OpenAPPA**: https://github.com/archestra-ai/OpenAPPA (MIT, Rust, preview/RFC).
  - It does deterministic information-flow checks: it tracks the sensitivity of what an agent reads and checks each tool call before it runs.
  - Policy is written in TOML, and it runs in-process or as a sidecar.
  - It has policy tests: `appa describe --config appa.toml --check` and `appa replay --config appa.toml policy-tests/`.
  - Fork it to Soham's GitHub. Read openappa.com (how-it-works, contracts, add-to-agent) before writing any plan.
  - The classifier's labels become APPA sensitivity labels.
  - Steps 2b and 2c depend on taint carrying through derived values and across agents. Confirm early that APPA supports both, and plan around any gap.
- **Jev**: TypeSafe's decision model (typesafe.ai).
  - JS SDK: `npm install @typesafe-ai/sdk` (Node 20+). A `choice()` question returns one label plus a confidence. It needs `TYPESAFE_API_KEY`.
  - TypeSafe paused new signups in late September 2026, so confirm Soham has a working key.
  - If "Jev" means something else to Soham (for example koladev32/jev-classify), use what he says.
  - High Risk covers personal ID numbers and anything with low classifier confidence.
- **Google Drive**: one dedicated test folder, holding the three subfolders and the review hold. Use a service account or OAuth, whichever Soham prefers. Detect new files by polling; webhooks are out of scope.
- **Sending**: default to a mock send tool that writes to an outbox log, with recipients `legal@hashirai-poc.test` (internal) and `counsel@outside-firm.test` (external). Only use real email if Soham asks.
- **Data**: synthetic only. Fictional names, documents marked SPECIMEN, a SPECIMEN ID number. No real customer data.

## Phase 0: inputs (one message to Soham, all questions at once)
- GitHub account or org for the fork
- Jev/TypeSafe API key
- Google account, Drive folder and auth method
- Mock outbox or real test inboxes
- Where secrets go (`.env`, never committed)

This folder already holds this file, so `git clone` into it will fail. Use `git init`, add the fork as `origin`, fetch, and check out `main`. Then commit this brief as `docs/orchestrator-brief.md`.

## Phase 1: product agent (Claude Opus 5.5, effort high)
- Trims the POC to its smallest feature set that still runs the demo above end to end.
- Writes one-page `docs/demo-script.md`: the exact steps, the inputs, and what should be seen at each step. This script is the acceptance test.
- Writes stories, each with acceptance criteria tied to a demo step, and estimates them in story points.

## Phase 2: dev lead agent (Claude Opus 5.5, effort high)
- Reads the fork and writes a one-page `docs/architecture.md`.
- Splits each story into tasks. For each task it records:
  - an estimate
  - the recommended model and effort
  - its dependencies
  - the files or modules it owns
- Groups the tasks into parallel waves, so that tasks in the same wave never touch the same files.

**Checkpoint:** send Soham the workbook and a five-line summary, then wait for his go-ahead before building.

## Phase 3: build
- Dispatch one implementer agent per task, a wave at a time, in parallel. Each agent uses the model and effort recorded for its task; the default is Opus 5.5 at medium.
- Each implementer works in its own git worktree, on a branch named `feat/<task-id>-<slug>` cut from up-to-date `main`.
- Each implementer keeps commits small, uses conventional commit messages, adds tests for its own code, and opens a PR that references the task ID.
- Each implementer logs its start and end time.
- `main` is protected and nobody commits to it directly.
- CI runs on every PR:
  - the unit tests
  - `appa describe --check`
  - `appa replay` over policy tests covering steps 2a–2d
- Merge PRs with a rebase, one at a time. Rebase dependent branches after each merge.

## Phase 4: acceptance (you)
- Check each PR against its task's acceptance criteria. Run the tests yourself, and read the diff for scope creep and hard-coded secrets.
- Accept the task, or send it back with specific reasons.
- When a story's tasks are all merged, check the story against its criteria.
- Finally, run `docs/demo-script.md` end to end twice from a clean Drive state. Both runs must give the same decisions.

## Story points
- **1 SP = up to 20 minutes of agent runtime for Claude Opus 5.5 at medium effort.** Estimate everything in this baseline unit, using 0.5, 1, 2, 3 or 5. Split anything larger than 5.
- When a task needs a different model or effort, record its **adjusted estimate = baseline × multiplier**. Fixed rule from Soham: Opus 5.5 high = 1.2. Set the other multipliers in proportion, write down your reasoning, and keep them all in the Calibration tab. Suggested starting points, to be calibrated later:
  - Opus 5.5 low: 0.85
  - Opus 5.5 xhigh: 1.45
  - a smaller model at medium: 0.7
- **Actuals** are recorded only once work is accepted:
  - raw actual SP = runtime minutes ÷ 20
  - normalised actual SP = raw ÷ multiplier
  - Rework attempts count towards the task's runtime.
  - Rejected attempts are logged on their own rows.

## Workbook: `planning/Hashirai Clearance POC - Plan.xlsx`
Keep the workbook, docs/demo-script.md, docs/architecture.md and a short planning/STATUS.md (what's done, what's next, current blockers) inside this repo. This folder sits inside the Hashirai project, and other sessions read it from there.
- **Stories:** ID, demo step, story, acceptance criteria, baseline SP, model, effort, multiplier, adjusted SP, status, accepted (Y/N), actual runtime (min), raw actual SP, normalised actual SP, variance.
- **Tasks:** ID, story ID, task, owner agent, wave, branch, files owned, dependencies, baseline SP, model, effort, multiplier, adjusted SP, start, end, runtime (min), attempts, PR link, accepted (Y/N), raw actual SP, normalised actual SP, notes.
- **Calibration:** model/effort → multiplier, the reasoning for each, and a running estimate-vs-actual ratio per model and effort.
- **Summary:** total estimated SP vs actual SP by story and by wave, plus the Later list.
- Use real formulas for the adjusted, actual and variance columns, not pasted values.

## Done means
- The demo runs end to end twice with identical decisions, and Soham has:
  - the repo link
  - the demo script
  - the outbox and decision log from both runs
  - the completed workbook
- In five lines or fewer, tell him where the estimates were furthest off and why.
