# docs

Hackathon deliverables, written for judges. They sit beside `../README.md`, which is the
entry point and must stay runnable as written from a clean clone.

| File | What it is |
|---|---|
| `DATA.md` | What is real, what is simulated and how; the id conventions; the planted problems; the definitions (reportable event, active subject, low supply, overdue payment); data terms. The reference for anything about the data |
| `DEMO.md` | A three-minute demo script with timings, spoken lines, and a deep link for each screen |
| `DECK.md` | An 11-slide outline. The judges asked for 10 to 12 slides. One idea per slide |
| `screenshots/` | `ask`, `trace`, `roles`, `quality`, `catalog`, `lineage`, `crosswalk`, `access` (PNG). `ask.png` is embedded in the README; the deck uses the first four |

## Keeping them true

These files quote results by hand. Nothing checks them. After any change to the simulation, the
models, the quality rules or the thresholds, run `python -m harmonizer build` in `server/` and compare its
summary with what is written:

| Figure | Where it is quoted |
|---|---|
| 25 planted problems, 25 caught | README, DATA, DEMO, DECK |
| 29 further findings, 23 of them partial dates in the real CDISC data | README (29), DEMO and DECK (23) |
| 27 quality rules, 28 SQL models, 14 tests | README, DECK |
| Crosswalk: 78 automatic, 2 queued, 3 unmatched | DECK |
| Finance feed 24 days stale against a 7-day SLA | README, DATA, DEMO |
| Two sites with all three problems; `S718` used in the walkthrough | README, DEMO |
| 55 subjects active; feed row counts; 17 sites | DATA |
| Thresholds 0.85, 0.05 margin, 0.70 | README, DECK |
| Role table (what the four starter roles hold: `STARTER_ROLES` in `server/backend/accounts.py`) | README |
| Starter accounts and their password (`STARTERS` in `server/backend/accounts.py`) | README, DEMO |

The screenshots were taken before sign-in existed: they show a role switcher at the top right
where the account menu now is, `roles.png` shows the old Compare roles tab with row counts and
"View as" buttons, and `access.png` shows three roles. `ask.png` is also from before the Ask page was
split into Ask a question and Write SQL. Retake them before they are shown again.

`DEMO.md` links assume the server is at `http://127.0.0.1:8040` and depend on the link format
`/ask/?q=...&tab=...` (the older `#/ask?q=...` form still redirects to it). The run commands in the README, `DEMO.md` and slide 11 of
`DECK.md` are written out by hand too, and are run in `server/`. The slide-2 example in `DECK.md` quotes real strings from the feeds,
including a misspelling marked (sic); if the feeds are regenerated the strings change.

## Voice

Plain, short sentences. Concrete examples taken from the actual feeds rather than abstractions.
No marketing language. Say what the system does not do: the README has a "What this is not"
section and it is part of the pitch. Every data source is cited with a link, and anything
simulated is called simulated.
