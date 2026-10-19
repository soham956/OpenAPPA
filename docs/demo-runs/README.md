# Demo runs (Phase 4 acceptance, 2026-10-19)

Two full runs of `docs/demo-script.md` against the real Google Workspace Drive test folder, each from a clean Drive state (`npm run reset`).

| | Run 1 | Run 2 |
|---|---|---|
| Archived as | `clearance/runs/2026-10-19T14-04-18-398Z` | `clearance/runs/2026-10-19T14-05-55-711Z` |
| Step 1: 10 files classified and moved | 33 s after `npm start` (includes sidecar start) | 26 s |
| Step 2: enforce lines | 11 (1 list, 4 read, 2a, 2b, 2c-save, 2c-load, 2c, 2d) | 11 |
| Step 3: new file moved, no restart | 9 s after drop | 8 s |
| Outbox | 1 line (2d, to legal@ only) | 1 line |
| `compare --expected` | matches expected | matches expected |

`npm run compare run1 run2` → **identical**. All 9 Jev classify lines came from the recorded fixture (`"source":"fixture"`); 08 and 09 were caught by the ID rule and never sent to Jev.

Each folder holds `decisions.jsonl` (the decision log), `outbox.jsonl`, the agent's printed output and the run log. Drive file IDs (`fileId`) and runtime offer IDs (`offerId`) are stripped from these committed copies because this repo is public; `compare` ignores both fields. The raw logs stay local in `clearance/runs/` (git-ignored).
