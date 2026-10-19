# Stories: Hashirai Clearance POC

Acceptance test: `docs/demo-script.md` (steps 0–4). 1 SP = up to 20 min of Opus 5.5 at medium effort.

## Minimum feature set
- Plain `.txt` SPECIMEN seed files (10 plus 1 for step 3) and a recorded Jev fixture.
- Classifier: SPECIMEN ID regex first, then Jev `choice()` with a 0.70 confidence threshold. Below the threshold means High Risk.
- Drive: one test folder with `Legal/`, `Accounting/` and `High Risk/`. High Risk is the review hold. A person releases a file by moving it out in Drive, so there is no release code.
- A poller that watches the root only and keeps running. No webhooks.
- Enforcement through the `appa runtime` HTTP sidecar and a TS hook client. Policy is driven by folder:
  - Legal and Accounting reads narrow the audience to a stubbed `internal` list (`legal@hashirai-poc.test`).
  - High Risk reads are denied.
  - `send` requires its recipients to be in the audience.
  - Memory uses scoped audiences, so a second session inherits the label.
- A scripted agent, not an LLM, that runs 2a–2d in order. It has two sessions (agent-1 and agent-2) and three tools: Drive read, mock `send` to the outbox, and a local memory store.
- One JSONL decision log, `npm run reset` and `npm run compare`.

## Stories
| ID | Demo step | Story | Acceptance criteria | SP | Model / effort |
|---|---|---|---|---|---|
| S1 | all | Project scaffold in the fork: Node 22 TS package, npm scripts (`start`, `agent`, `reset`, `drop`, `compare`, `test`), `.env.example`, `.gitignore` for `.env` and `secrets/`, CI running unit tests, `appa describe --check` and `appa replay policy-tests/` | `npm test` passes on a fresh clone; CI is green on the first PR; `git check-ignore .env secrets/x` matches both; no secret in the repo | 2 | Opus 5.5 / medium |
| S2 | inputs, 1, 3 | Write the 11 synthetic seed files listed in the demo script | All 11 exist with the demo-script names; each starts with SPECIMEN; only 08 and 09 match `SPC-\d{4}-\d{4}`; 01 contains `Matter Ref: LM-2026-0417`; all names are fictional | 1 | Sonnet / medium |
| S3 | setup, 0, 1, 3 | Drive client: list root, read, move, upload, trash, ensure subfolders. Auth is chosen by one `GDRIVE_AUTH` line (oauth, TBD, or service-account). Setup steps go in the README | `npm run drive:check` lists the root and creates any missing subfolder; switching `GDRIVE_AUTH` needs no code change; the OAuth token is cached under `secrets/`; refuses to run if `GDRIVE_ROOT_FOLDER_ID` is unset | 3 | Opus 5.5 / medium |
| S4 | 0 | `npm run reset`: trash everything under the test folder, upload seed 01–10 to the root, archive `logs/` to `runs/<stamp>/`, clear the outbox, memory and poller state | Step 0 "See" holds; running reset twice in a row gives the same state; it touches nothing outside `GDRIVE_ROOT_FOLDER_ID` (unit test with a fake Drive) | 1 | Opus 5.5 / medium |
| S5 | 1, 3 | Classifier: ID rule, then Jev `choice()` over {Legal, Accounting}, then the threshold; fixture replay or record-on-miss keyed by sha256(content) | With the committed fixture and no API key, unit tests give the demo-script label and rule for all 11 files; a miss is logged `"source":"live"`; the threshold comes from `.env` | 3 | Opus 5.5 / medium |
| S6 | 1, 3 | Record the Jev fixture live for the 11 files and commit it (needs the TypeSafe key) | File 10 records < 0.70; the other non-ID files record ≥ 0.70 with the expected label. If not, edit the seed text and re-record; never hand-edit the fixture | 1 | Opus 5.5 / low |
| S7 | 1, 3 | Poller: every 10 s, classify new root files, move them, log `classify` lines; ignore subfolders | Step 1: 10 files moved within 30 s. Step 3: the new file moves within 30 s with no restart. A file already in a subfolder is never reclassified | 2 | Opus 5.5 / medium |
| S8 | 1–4 | Decision log writer (shared JSONL), plus `npm run compare` over two run folders, plus a check against `expected-decisions.json` built from this script | Lines match the demo-script shapes; `compare` ignores timestamps and Drive IDs and sorts `classify` lines by file; it prints `identical`, or the first differing line and exits 1 | 1 | Sonnet / medium |
| S9 | 1, 2a–2d | `appa.toml`: folder-labelled read tools, `send` with `contains = ["$to"]`, the `internal` list stub, memory save/load with scoped audiences, High Risk read denied. Plus `policy-tests/*.appa` | `appa describe --check` passes; `appa replay` passes files for 2a (deny), 2b (deny), 2c across two sessions (deny), 2d (allow) and a High Risk read (deny) | 3 | Opus 5.5 / high |
| S10 | 2a–2d | Sidecar and TS hook client: `npm start` launches `appa runtime`; every tool call is checked before it runs; a deny returns the short reason, rewritten from runtime text plus the session's label source (file or memory) | The exact 2a/2b/2c reason strings from the demo script are returned and logged; a denied call never runs its tool; unit tests use recorded runtime responses | 3 | Opus 5.5 / high |
| S11 | 2 | Tools: Drive read (returns content and folder label), mock `send` (appends to `logs/outbox.jsonl`), memory save/load (local JSON keyed by scope) | Each tool works alone in unit tests; `send` writes exactly one line per allowed call and none per denied call | 2 | Opus 5.5 / medium |
| S12 | 2 | Scripted agent: takes the task text, runs agent-1 (read Legal, 2a, 2b, memory save), then agent-2 (memory load, send), then agent-1 2d; prints each result | Step 2 "See" holds end to end against the live sidecar; outbox ends with exactly the 2d line; session IDs are fixed as `agent-1` and `agent-2` | 2 | Opus 5.5 / medium |

**Total: 12 stories, 24 SP baseline.**

## Estimates
- Most stories are 1–3 SP. Plain plumbing (Drive, tools, poller) is cheap because the patterns are well known.
- S9 and S10 are 3 SP at high effort. OpenAPPA is a preview with unusual semantics (session taint, scoped memory, `$to` matching), so expect replay-test iteration.
- S3 is 3 SP because of OAuth token caching and Workspace or Shared Drive quirks. If a service account is chosen, it drops to 2.
- S5 is 3 SP because record/replay and the miss path need careful tests. S6 is short but blocked on the TypeSafe key, and it may loop if file 10 comes out too confident.
- S2 and S8 are text and diff work, so a smaller model is enough.
- Not included: orchestrator acceptance runs, PR review and rebase time.

## Later
- Per-value taint, so external sends of unrelated values after a Legal read are allowed.
- Per-record memory labels, instead of scoped audiences.
- An LLM-driven agent instead of the scripted one.
- A release workflow or UI for the review hold, beyond moving the file in Drive.
- Real ID detectors (SSN, passport and so on) beyond the SPECIMEN format.
- Google Docs, PDF and OCR input.
- Per-team audiences (an Accounting list separate from `internal`).
- Copies and summaries carrying the source clearance, and sanitizers or redaction.
- Real email.
- Drive webhooks.
- Reclassifying a file when it is edited.
- Hashirai Registry integration.
- A decision-log viewer.
- Retries, rate limits and deployment.
- Poller durability: if the log write fails after a successful move, that classify line is lost. Persist pending lines and retry them.
- A wider confidence margin for seed 10. It records at 0.66 against the 0.70 threshold, so a live re-record could cross it.
- A faster reset on Workspace Drive (batch calls); today it takes 23–45 s.
