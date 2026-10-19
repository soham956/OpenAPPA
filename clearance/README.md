# Clearance (Hashirai POC)

Node 22 + TypeScript package for the Hashirai Clearance POC. It classifies files in a Google Drive test folder (Legal, Accounting, High Risk) and runs a scripted agent whose tool calls are checked by an `appa runtime` sidecar (OpenAPPA). The acceptance test is [`../docs/demo-script.md`](../docs/demo-script.md); the design is [`../docs/architecture.md`](../docs/architecture.md).

## Setup

1. Node 22 or later, and the `appa` CLI on PATH (or set `APPA_BIN`).
2. From `clearance/`: `npm ci`.
3. Copy the env template to the **repo root** (one level up), then fill it in:
   `cp .env.example ../.env`
   `.env` and `secrets/` live at the repo root and are git-ignored. `src/config.ts` loads `../.env`; real environment variables win.
4. Drive auth: see [`docs/drive-setup.md`](docs/drive-setup.md).
5. Policy and policy tests: see [`policy/README.md`](policy/README.md).

## Commands (run from `clearance/`)

| Command | What it does |
|---|---|
| `npm start` | Start the `appa runtime` sidecar and the Drive poller |
| `npm run agent -- "<task>"` | Run the scripted agent (step 2) |
| `npm run reset` | Reset Drive, logs and state to step 0 |
| `npm run drop` | Upload `seed/new/11-*` to the Drive root (step 3) |
| `npm run compare <runA> <runB>` | Compare two runs (or `--expected`) |
| `npm run drive:check` | List the Drive root and ensure the subfolders |
| `npm run fixture:record` | Record the Jev fixture live |
| `npm test` | Unit tests (no `appa`, Drive or API key needed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run policy:check` | `appa describe --check` and `appa replay` over `policy-tests/` |

## Layout

- `src/config.ts`: config loader (`loadConfig`, `getConfig`, `requireDrive()`, `requireTypesafeKey()`) and every path.
- `src/util/jsonl.ts`: JSONL read/append/write.
- `src/log/schema.ts`: `classify`, `enforce` and outbox line types and guards.
- `src/cli/*.ts`: npm entry points.
- `state/`, `logs/`, `runs/` are created at runtime and git-ignored.
