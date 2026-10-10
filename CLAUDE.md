# Concord

One question across every clinical trial system. Concord ingests exports from five mock source
systems (EDC, CTMS, IRT, safety, finance), works out which ids mean the same site and subject,
and answers cross-system questions with the SQL, lineage, source rows, freshness and
data-quality warnings attached, under role-based access control.

Python 3.10+, DuckDB, sqlglot and FastAPI, with a Next.js and Tailwind CSS front end that is built
once to static files (Node.js 20.9+). No database server, no Docker, no API key required.

The code is in three parts, each a folder at the repository root:

- **`harmonizer/`** turns the feeds into the warehouse and the per-role databases (the write side).
- **`backend/`** answers questions from what the harmonizer built and serves the JSON API (the read side).
- **`frontend/`** is the web app. It talks to the back end over `/api/...` and to nothing else.

Dependencies point one way: front end -> back end (HTTP only) -> harmonizer (the files in
`build/`, plus `config`, `policy` and `quality`). The harmonizer imports neither of the others.

## Commands

Run from the repository root, with the virtual environment active. `harmonizer` and `backend`
are not installed; they are imported from the cwd.

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt   # once
(cd frontend && npm install && npm run build)   # once, and after front-end changes: writes frontend/out
python -m harmonizer build                 # rebuild build/*.duckdb from feeds/ (about 1-2 s)
python -m backend serve [--host H --port P] # default 127.0.0.1:8040
python -m backend ask "Which sites are we late paying?" --role finance   # prints the result JSON
python tests/test_concord.py               # all 10 tests, no test runner needed
```

- A virtual environment does not survive its folder being moved or renamed: `activate` keeps
  the old path and `python` is then not found. Recreate it, or call `.venv/bin/python` directly.
- `serve` and `ask` build only when `build/warehouse.duckdb` is missing. After changing a model, a
  feed, a quality rule or the policy, run `python -m harmonizer build` yourself.
- The server serves the web app from `frontend/out`. If that folder is missing when it starts, `/`
  says how to build it and only the API is served; build, then restart. For front-end work, run
  `npm run dev` in `frontend/` beside the server: it serves on port 3000 and forwards `/api` to 8040.
- A running server picks up a rebuild without a restart (the catalog cache is keyed on the
  warehouse file's mtime). Changes to Python code need a restart; there is no `--reload`.
- `pytest` is not in `requirements.txt`. The tests are written to run under it, so install it
  if you want to run a single test: `python -m pytest tests/test_concord.py -k headline -q`.
- Roles are `clinops`, `biostat`, `finance`.
- Free-form questions need `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). They are written into SQL by
  Gemini through the `google-genai` SDK; `CONCORD_MODEL` overrides the model id (default
  `gemini-3.8-flash`).
- Both settings live in `.env` at the repository root (copy `.env.example`). `harmonizer/config.py`
  loads it on import; a variable already set in the shell wins. `.env` is gitignored: never
  commit it, print it or paste its contents anywhere. `.env.example` is committed and must only
  ever hold placeholders. A running server reads `.env` once, so restart it after a change.
  Without a key everything still works from the reviewed questions.
- API docs are served at `/api/docs`.

## Layout

```
harmonizer/         feeds -> warehouse: config, policy, pipeline, models, quality (see harmonizer/CLAUDE.md)
  models/           one .sql file per table: silver/, master/, gold/ (see harmonizer/models/CLAUDE.md)
backend/            warehouse -> answers: engine, ask, server (see backend/CLAUDE.md)
frontend/           the Next.js and Tailwind app: app/, components/, lib/; built to out/ (see frontend/CLAUDE.md)
feeds/              the five mock source systems. Generated and committed (see feeds/CLAUDE.md)
data/public/        snapshot of the real public data the feeds are derived from (see data/CLAUDE.md)
scripts/            fetch_public_data.py, simulate_feeds.py: regenerate the two folders above (see scripts/CLAUDE.md)
tests/              test_concord.py: end-to-end checks (see tests/CLAUDE.md)
docs/               DATA.md, DEMO.md, DECK.md, screenshots/ (see docs/CLAUDE.md)
build/              generated DuckDB files. Gitignored. Never edit, never commit
README.md           the project README, then the HackRU challenge brief from the line `# ONE SOURCE OF TRUTH` on
requirements.txt    the seven runtime dependencies. pytest and pandas are not in it
.env.example        template for .env (the Gemini key and model id). .env itself is gitignored
```

The top half of `README.md` is the entry point for judges and must stay runnable as written from
a clean clone. The bottom half is the organisers' brief (starter sheet 40), kept for reference:
its Good / Better / Best tiers and judging criteria are what the project is measured against.

## How data flows

```
data/public/ --simulate_feeds.py--> feeds/<system>/*.csv|json + _manifest.json
feeds/ --harmonizer: pipeline.build()--> build/warehouse.duckdb
    bronze   files as received: every value text, plus _src_system, _src_file, _src_row
    silver   typed, renamed, dates parsed; still one table per source object
    master   golden site and subject records, and the crosswalks that map every system's ids
    gold     conformed facts and dimensions on master keys; gold.site_360 is the headline table
    meta     the catalog: feeds, datasets, columns (with profiles), lineage
    dq       rules and failures
build/warehouse.duckdb --policy--> build/role_<role>.duckdb   (one read-only database per role)
build/ --backend: engine, ask, server--> /api/... --> frontend
```

Current build: 12 bronze, 12 silver, 4 master, 13 gold tables; 27 quality rules, 54 findings;
25 of 25 planted problems caught; site crosswalk 78 auto, 2 review, 3 unresolved. The thirteenth
gold table is `gold.snapshot`, which `pipeline.build()` creates directly; it has no `.sql` file.

## Rules that must not be broken

**Time is frozen at the snapshot date.** Everything is evaluated as of `feeds/_snapshot.json`
(2014-01-31). Never use `current_date`, `now()` or `datetime.now()`. In SQL use
`gold.snapshot` (`(SELECT as_of FROM gold.snapshot)`); in Python use `config.snapshot_date()`
or `config.platform_now()` (08:00 on the snapshot day, the reference for feed freshness).

**The role database is the access control, not the app.** A role's tables are physically
absent and its masked columns physically NULL in `build/role_<role>.duckdb`. User SQL and
model-written SQL must only ever run through `engine.execute()`, which uses that database.
`engine.warehouse()` opens the full, unfiltered warehouse: anything read through it and returned
to a client must apply `engine.access()` / `policy` by hand, as `/api/crosswalk` and
`/api/quality` do. The language model is a convenience and is never trusted with enforcement.

**Sensitivity tags do not propagate.** A tag on a bronze file or a silver model is not
inherited downstream. Every model that exposes a sensitive column must re-declare the tag in
its own header, or the value leaks into that role's database. See `harmonizer/models/CLAUDE.md`.

**Row-level provenance is carried everywhere.** Every bronze and silver table, the two golden
records (`master.site`, `master.subject`), and every gold table that is one row per source
record keeps `_src_system`, `_src_file`, `_src_row`. The crosswalks and the aggregates
(`site_360`, `fact_sae_reconciliation`) do not. Tracing an answer back to source rows depends
on these columns.

**Uncertain matches are never guessed.** The crosswalk accepts, queues for a steward, or leaves
unresolved by fixed thresholds. Unresolved ids keep a NULL master key and surface as quality
findings. Do not loosen a threshold to make a number look better.

**Feeds are generated, not edited.** Change `scripts/simulate_feeds.py` and regenerate. The
committed feeds are reproduced byte for byte by the script.

**Quality rules never read the answer key.** `feeds/ANSWER_KEY.json` is used only to score
the rules (build summary, Quality page, tests).

**Stay honest about the data.** Public or synthetic data only, every source cited, and what is
simulated says so. No real patient, site or payment is described; site names are invented.

## Changing things

| To do this | Touch this | Then |
|---|---|---|
| Add or change a table | a `.sql` file under `harmonizer/models/<layer>/` | `build`, run the tests |
| Add a quality rule | `RULES` in `harmonizer/quality.py` | `build`; if it is meant to catch a planted problem, plant it in `simulate_feeds.py` |
| Add a reviewed question | `VETTED` (and optionally `ALSO`) in `backend/ask.py` | run the tests: it must run or be refused cleanly for every role |
| Add a tag or a role | `TAGS` / `ROLES` in `harmonizer/policy.py`, plus tags in manifests and model headers | `build`; add the tag's colours to `TAG_TONE` in `frontend/components/ui.tsx` |
| Make a result column clickable for tracing | `TRACEABLE` in `backend/engine.py` | |
| Add or change an API route | `backend/server.py`, then its type in `frontend/lib/types.ts` and the page under `frontend/app/` that calls it | restart the server, rebuild the front end; update the route table in `backend/CLAUDE.md` |
| Change the simulation | `scripts/simulate_feeds.py` | regenerate, `build`, tests, then update the figures quoted in `README.md` and `docs/` |

The figures in `README.md`, `docs/DATA.md`, `docs/DEMO.md` and `docs/DECK.md` (25 planted, 29
more findings, 23 partial dates, 78/2/3 crosswalk, 55 active subjects, row counts) are written
out by hand. If the data or the rules change, they go stale silently, and so do the screenshots.

## Style

- Python: `from __future__ import annotations`, module docstring that explains the design,
  type hints, long lines (up to about 160 columns), section dividers of the form
  `# ---------------- name`. No classes where a dict or a function will do. No linter or
  formatter is configured.
- Comments explain why, not what, and are sparse.
- User-facing text (errors, explanations, evidence strings, docs) is plain English written for
  a study team member, not for an engineer.
- Dependencies are deliberately few. On the Python side do not add a framework or an ORM. The front
  end is Next.js, React and Tailwind CSS and nothing else: no component library, no state or
  data-fetching library.

## Limits that are known and stated

A hackathon prototype on one small study, nothing GxP. Roles come from a switcher, not from
sign-on, so the role is a parameter the client sends. The crosswalk queues uncertain matches but
has no approval screen. Lineage is table-level through the SQL and row-level to the source file;
column-level lineage is not derived. These are listed in `README.md`; keep that list truthful.
