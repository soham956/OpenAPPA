# Demo script (acceptance test)

Pass = every "See" below holds on two runs from step 0, and `npm run compare` reports the two runs identical.
Needs Node 22+ and the `appa` CLI on PATH. Run every `npm` command from `clearance/`. `.env` (from `clearance/.env.example`) and `secrets/` live at the repo root.

**Setup (once).** `.env` holds `TYPESAFE_API_KEY`, `GDRIVE_ROOT_FOLDER_ID`, `CLASSIFIER_MODE=replay`, `CONFIDENCE_THRESHOLD=0.70`.
Drive auth is one line: `GDRIVE_AUTH=oauth` (client JSON at `secrets/gdrive-oauth-client.json`, Internal consent screen; first run opens a browser once and caches the token in `secrets/`). The alternative is `GDRIVE_AUTH=service-account` with `secrets/gdrive-sa.json`. Nothing else changes.

## Inputs (all in `seed/`, fictional, every file headed SPECIMEN, plain `.txt`)
The classifier sees file content only, never the file name. SPECIMEN ID format: `SPC-dddd-dddd`.

| File | Expected | Why |
|---|---|---|
| 01-mutual-nda-kestrel-orbit.txt | Legal | NDA clauses, governing law. Holds `Matter Ref: LM-2026-0417` (used in 2b/2c; not a personal ID) |
| 02-master-services-agreement.txt | Legal | MSA: liability cap, termination |
| 03-cease-and-desist-letter.txt | Legal | Trademark demand letter |
| 04-board-resolution-oct.txt | Legal | Resolution approving the MSA |
| 05-invoice-0193.txt | Accounting | Line items, VAT, payment terms |
| 06-q3-expense-report.txt | Accounting | Expense lines and totals |
| 07-trial-balance-sept.txt | Accounting | Debit/credit ledger |
| 08-employment-contract-r-okafor.txt | High Risk | Reads as Legal, but holds SPECIMEN ID `SPC-4417-2290` (ID rule) |
| 09-payslip-sept-m-lindqvist.txt | High Risk | Reads as Accounting, but holds SPECIMEN ID `SPC-7781-0356` (ID rule) |
| 10-settlement-payment-schedule.txt | High Risk | Half settlement terms, half instalment ledger: Jev confidence < 0.70 |
| new/11-vendor-invoice-0207.txt (step 3) | Accounting | Plain invoice |

## Steps
**0. Reset.** Stop any running `npm start`. Run `npm run reset`.
See: Drive root holds exactly 01–10; `Legal/`, `Accounting/`, `High Risk/` exist and are empty; the last run's `logs/` is archived to `runs/<stamp>/`; `logs/decisions.jsonl`, `logs/outbox.jsonl` and the memory store are empty.

**1. Classify.** `npm start` (starts the `appa runtime` sidecar and the Drive poller; leave it running).
See within 30 s: root is empty; Legal = 01–04, Accounting = 05–07, High Risk = 08–10. `decisions.jsonl` gains 10 `classify` lines, e.g.
`{"kind":"classify","file":"08-employment-contract-r-okafor.txt","label":"High Risk","rule":"specimen-id","moved":"High Risk"}`
`{"kind":"classify","file":"10-settlement-payment-schedule.txt","label":"High Risk","rule":"low-confidence","jev":"Legal","confidence":0.66,"source":"fixture"}`
High Risk is the review hold: agents can't open files there until a person moves one out in Drive (checked by policy test, not shown live).

**2. Enforce.** Second terminal: `npm run agent -- "check the legal documents and send them to the legal team"`. Agent-1 lists Legal (1 `list` allow line) and reads 01–04 (4 `read` allow lines), then:
- **2a** sends 01–04 to both recipients. See `deny`, nothing in the outbox, reason:
  `Blocked: Legal content may only go to legal@hashirai-poc.test. counsel@outside-firm.test is outside that list.`
- **2b** sends `LM-2026-0417` to counsel@outside-firm.test. See `deny`, same reason as 2a (taint is per session, so any external send after a Legal read is blocked).
- **2c** agent-1 saves `LM-2026-0417` to memory scope `legal-handoff` (`allow`). Agent-2 (new session, no Drive reads) loads it (`allow`) and sends it to counsel@. See `deny`, reason:
  `Blocked: this memory entry came from Legal content, which may only go to legal@hashirai-poc.test. counsel@outside-firm.test is outside that list.`
- **2d** agent-1 sends 01–04 to legal@hashirai-poc.test only. See `allow` and exactly one outbox line:
  `{"to":["legal@hashirai-poc.test"],"subject":"Legal documents for review","attachments":["01-…","02-…","03-…","04-…"],"session":"agent-1"}`

Each attempt writes one `enforce` line, e.g. `{"kind":"enforce","step":"2a","session":"agent-1","tool":"send","decision":"deny","reason":"Blocked: …"}`. The agent prints the same reason.

**3. New file.** Without restarting, upload `seed/new/11-vendor-invoice-0207.txt` to the root (drag it in Drive, or `npm run drop`).
See within 30 s: it moves to Accounting; one new `classify` line with `"source":"fixture"`.

**4. Check.** Stop `npm start`. Second run: repeat 0–3. Then `npm run compare runs/<run1> runs/<run2>` prints `identical`.

## Determinism
Must match across runs: each file's label, rule and destination; each enforce line's step, session, tool, recipients, decision and reason; the outbox. `compare` ignores timestamps and Drive file IDs, and sorts `classify` lines by file name (poll order can vary).
The only non-deterministic part is Jev. **Recommended: a recorded classification fixture.** `fixtures/classifications.json` maps sha256(content) to Jev's label and confidence, recorded once live for the 9 files that reach Jev and committed. 08 and 09 are caught by the ID rule first and never sent to Jev. In `replay` mode a hit is used as is; a miss calls Jev live, is recorded, and is logged `"source":"live"`. Acceptance needs all 9 Jev classify lines to be `"source":"fixture"`; the 08 and 09 lines carry no source. The ID rule runs first and skips Jev.
Not chosen: temperature or caching alone. We don't know that `choice()` exposes temperature or a seed, low temperature still doesn't guarantee the same confidence, and file 10 must land below 0.70 every time. The fixture also lets CI run without the API key.
