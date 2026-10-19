# Clearance POC: code and architecture review

Scope: `clearance/` at `37b78fb9`. `src/` was read line by line and `test/` was sampled. Baseline: `npm ci && npm test` gives 229 passed and 13 skipped (the skipped tests need `appa`; CI runs them), and `tsc --noEmit` is clean. Paths are relative to `clearance/`. Shortcuts already listed in `docs/architecture.md` or the Later list in `planning/stories.md` are not repeated.

**Verdict: build on the boundaries, not on the current code.** `DriveClient`, the guard as the checkpoint, and policy as code with replay tests are worth keeping. Two of these boundaries are weaker than they look. First, the guard is a checkpoint only by convention: it runs in the agent's process and takes the trajectory (session) from the caller. Second, it is not the only path to file content: the classifier, and anyone who can write to a Drive folder, also decide what a file's clearance is.

## 1. Correctness risks

*Repro* marks findings reproduced with a scratch script that used `FakeDriveClient` and a stub runtime.

| # | Finding | Where |
|---|---|---|
| C1 | **The caller picks the trajectory.** `Guard.call(session, …)` takes the session as an argument, and the session name is the runtime root id. Agent code holding a value read under `agent-1` can propose the `send` under `agent-2`. That label is still public, so APPA allows it. This bypasses the guard; only the honest script prevents it. Fixed root names also make concurrent runs share one label. | `src/sidecar/guard.ts:151`, `:301-303` |
| C2 | **Check-then-read race.** The guard resolves the folder, APPA decides, and the tool then reads. `driveRead` returns the folder after the read, but the guard never compares it with the folder it proposed. *Repro:* a file moved from Legal to High Risk between the check and the read came back as `allow`, with its content and `folder: "high-risk"`. | `guard.ts:255`, `:200-207`; `src/tools/drive.ts:29-33` |
| C3 | **Folder write access grants clearance.** The poller lists only the root. A file that a Drive editor puts straight into `Legal/` is never classified, so an ID-bearing file there can be read and sent to `legal@`. Subfolders are found by name, so a renamed or duplicate folder changes what "Legal" means. | `src/poller/poller.ts:127`; `src/drive/google.ts:157-176` |
| C4 | **The classifier is an unguarded egress.** The poller sends the content of every new root file to TypeSafe without an APPA check. On a miss, it writes the answer into the committed fixture. The demo avoids this only because it replays the fixture. | `poller.ts:131`; `src/classifier/jev.ts:38-42`; `src/classifier/fixture-store.ts:133-134` |
| C5 | **Attachments are names the agent supplies**, not file ids read through the guard. The mock carries no content, so nothing leaks today. A real mail tool that resolves names to Drive files would let a fresh session attach a High Risk file without a `drive_read`. | `src/agent/script.ts:87`; `src/tools/send.ts:41` |
| C6 | **`Guard.call` can throw.** Its comment says "Never throws". The log validator rejects arguments that APPA also rejects, for example a numeric `scope`. `finish` throws on the deny path, and the catch calls `finish` again. *Repro:* `call()` rejects with `invalid decision line`. No tool runs, but the decision is not logged. | `guard.ts:150`, `:222-225`; `src/log/schema.ts:138-154` |
| C7 | **A side effect is logged as `error`.** If `tool_result` fails after `send` has run, the line says `error` but the outbox line exists. An agent that retries then sends twice. | `guard.ts:209`, `:222-225` |
| C8 | **Control flow matches runtime text.** Narrowing offers are found by the phrase "Accept narrower readers". Source failures and recipient denies are found by regexes. Each fails closed when the runtime's text changes. A narrowing then becomes a deny, and a source failure is logged as a deny, not an error. | `src/sidecar/remedy.ts:16,34`; `src/sidecar/reasons.ts:23-25` |
| C9 | **Full `drive` scope on the user's token.** Only `GoogleDriveClient.locate` keeps calls inside the tree. A corrupt token file throws inside the `tokens` event listener, which crashes the process. The consent flow itself (PKCE, `state` check, loopback only) is sound. | `src/drive/auth.ts:15`, `:101-104`; `google.ts:200-205` |

The rest of the remedy flow, the wire client and reset hold up. `executeRemedy` closes the control dispatch on every failure, and the guard retries once and then fails closed. `parseDecision` (`src/sidecar/wire.ts:94-144`) allows each event only its own decisions. Reset refuses to run while the sidecar answers, and it moves files to the trash instead of deleting them.

## 2. Code quality

- **Q1. Three copies of the Drive tools.** The guard has default tools (`guard.ts:108-114`). Production replaces them with `src/tools/drive.ts` (`src/cli/agent.ts:31-34`), and the unit tests use a third copy (`test/guard.test.ts:66-71`). As a result, only the end-to-end test covers the production read path. There are also two `DriveReadResult` types (`guard.ts:40`, `tools/drive.ts:10`).
- **Q2. The policy is restated in TypeScript.** Readers are in `src/sidecar/audiences.ts:20-31`, the narrowing tools in `guard.ts:25`, and the argument schemas in `guard.ts:28-34` and `:249-271`. A test keeps them in sync by parsing `appa.toml` with regexes (`test/reasons.test.ts:79-94`). Generate them from `appa describe` instead.
- **Q3. Demo enums are in the core types.** The log, `send` and memory all enforce `STEPS` and `SESSIONS` (`src/log/schema.ts:26,36`; `send.ts:38`; `src/tools/memory.ts:40`). A new session or step fails after APPA has already allowed the call.
- **Q4. Dead or ignored code.** `Guard.labelSource` has no callers (`guard.ts:130`). The guard discards the `RemedyRun` that `executeRemedy` returns (`:180`). `logStep` is a useless alias (`:153`). `session_start` context is dropped (`:138`). `ALLOWED_READERS` is used only by a test (`audiences.ts:10`).
- **Q5. Repeated atomic-write code.** The same write appears in `memory.ts:46-49`, `poller.ts:72-78` and `fixture-store.ts:138-143`. `memory_save` reads, changes and writes the file with no lock (`memory.ts:43-49`).
- **Q6. Five or more Drive calls per read.** Each read calls `folderOf`, lists the whole folder to log the name (`guard.ts:275-283`), reads (`locate` plus download), and calls `folderOf` again.
- **Q7. Brittle tests.** The guard replay compares each request's JSON byte for byte, file contents included (`test/guard.test.ts:239`), so editing seeds 01–04 means re-recording against a live runtime. `guard.test.ts:180` pins runtime text that has a doubled `invalid call:` prefix. The demo reason text appears in four test files, which is acceptable as an acceptance pin.

## 3. Architecture

| Module | Verdict |
|---|---|
| `DriveClient` + fake + contract test (`src/drive/types.ts:41-64`) | **Keep.** Add a revision id to `folderOf` and `read` (C2). Pin subfolders by id in config (C3). |
| `HookClient` / `parseDecision` (`wire.ts`) | **Keep.** It uses a closed decision union and fails closed on every malformed reply. |
| `executeRemedy` (`remedy.ts:126-155`) | **Keep the flow.** Replace the text matching when the wire gets typed offers (upstream). |
| `Guard` | **Keep the sequence, move the boundary.** Run it as a separate MCP server that holds the Drive credential and binds each connection to one trajectory (C1). Generate its policy knowledge (Q2). |
| `appa.toml` + `policy-tests/` | **Keep.** The policy is short, pinned by replay, and the recipient source is 20 lines. |
| `classify()` with an injected `AnswerSource` (`src/classifier/decide.ts:28-35`) | **Keep the shape.** Replace the fixture writes with a cache store, and put Jev under policy (C4). |
| Decision log schema and `compare` | **Replace.** The demo enums are built in (Q3). |
| Poller, reset, drop, sidecar launcher | **POC only.** |

## 4. Priorities

**Must fix before building on this**

1. C1: bind each trajectory to an agent connection outside the agent's process, and give every trajectory a unique root id.
2. C2: fail closed when the folder after the read differs from the folder checked. Then bind reads to a revision.
3. C3: choose one source of truth for labels: either lock folder writes to the service identity, or store the label by file id and revision.
4. C4: put classifier egress under policy, and stop writing fixtures at run time.
5. C5: make attachments file ids that the guard reads and labels before a real mail tool exists.
6. C6: make `Guard.call` total. Validate arguments before logging.

**Should fix:** C7 (a distinct "ran, settle failed" outcome), C8, C9 (a service account shared only on the tree; catch errors in the token listener), Q1, Q2, Q3, Q5, Q6.

**Fine for a POC:** the deny reason uses the first label source only (`guard.ts:183`); a file moved back to the root stays unclassified and unreadable (`poller.ts:129`), which fails safe; a partial reset recovers when run again; Q4; and the pinned acceptance text in Q7.
