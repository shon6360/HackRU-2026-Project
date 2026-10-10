# Concord

One question across every clinical trial system. Concord ingests exports from five mock source
systems (EDC, CTMS, IRT, safety, finance), works out which ids mean the same site and subject,
and answers cross-system questions with the SQL, lineage, source rows, freshness and
data-quality warnings attached, under role-based access control.

Python 3.10+, DuckDB, sqlglot, FastAPI, and a dependency-free front end. No database server,
no Docker, no build step, no API key required.

## Commands

Run from this directory (`meow/`). `concord` is not installed; it is imported from the cwd.

```bash
python -m concord build                    # rebuild build/*.duckdb from feeds/ (about 1-2 s)
python -m concord serve [--host H --port P] # default 127.0.0.1:8040
python -m concord ask "Which sites are we late paying?" --role finance   # prints the result JSON
python tests/test_concord.py               # all 9 tests, no test runner needed
```

- `serve` builds only when `build/warehouse.duckdb` is missing. After changing a model, a feed,
  a quality rule or the policy, run `build` yourself.
- A running server picks up a rebuild without a restart (the catalog cache is keyed on the
  warehouse file's mtime). Changes to Python code need a restart; there is no `--reload`.
- `pytest` is not in `requirements.txt`. The tests are written to run under it, so install it
  if you want to run a single test: `python -m pytest tests/test_concord.py -k headline -q`.
- Roles are `clinops`, `biostat`, `finance`.
- Free-form questions need `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`). `CONCORD_MODEL`
  overrides the model id. Without a key everything still works from the reviewed questions.
- API docs are served at `/api/docs`.

## Layout

```
concord/            the package (see concord/CLAUDE.md)
  models/           one .sql file per table: silver/, master/, gold/ (see concord/models/CLAUDE.md)
  web/              index.html, app.js, styles.css (see concord/web/CLAUDE.md)
feeds/              the five mock source systems. Generated and committed (see feeds/CLAUDE.md)
data/public/        snapshot of the real public data the feeds are derived from
scripts/            fetch_public_data.py, simulate_feeds.py: regenerate the two folders above
tests/              test_concord.py: end-to-end checks
docs/               DATA.md, DEMO.md, DECK.md, screenshots/
build/              generated DuckDB files. Gitignored. Never edit, never commit
```

## How data flows

```
data/public/ --simulate_feeds.py--> feeds/<system>/*.csv|json + _manifest.json
feeds/ --pipeline.build()--> build/warehouse.duckdb
    bronze   files as received: every value text, plus _src_system, _src_file, _src_row
    silver   typed, renamed, dates parsed; still one table per source object
    master   golden site and subject records, and the crosswalks that map every system's ids
    gold     conformed facts and dimensions on master keys; gold.site_360 is the headline table
    meta     the catalog: feeds, datasets, columns (with profiles), lineage
    dq       rules and failures
build/warehouse.duckdb --policy--> build/role_<role>.duckdb   (one read-only database per role)
```

Current build: 12 bronze, 12 silver, 4 master, 13 gold tables; 27 quality rules, 54 findings;
25 of 25 planted problems caught; site crosswalk 78 auto, 2 review, 3 unresolved.

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
its own header, or the value leaks into that role's database. See `concord/models/CLAUDE.md`.

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
| Add or change a table | a `.sql` file under `concord/models/<layer>/` | `build`, run the tests |
| Add a quality rule | `RULES` in `concord/quality.py` | `build`; if it is meant to catch a planted problem, plant it in `simulate_feeds.py` |
| Add a reviewed question | `VETTED` (and optionally `ALSO`) in `concord/ask.py` | run the tests: it must run or be refused cleanly for every role |
| Add a tag or a role | `TAGS` / `ROLES` in `concord/policy.py`, plus tags in manifests and model headers | `build`; add a `.pill.tag-<tag>` style in `web/styles.css` |
| Make a result column clickable for tracing | `TRACEABLE` in `concord/engine.py` | |
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
- Dependencies are deliberately few. Do not add a framework, an ORM or a front-end build.

## Limits that are known and stated

A hackathon prototype on one small study, nothing GxP. Roles come from a switcher, not from
sign-on, so the role is a parameter the client sends. The crosswalk queues uncertain matches but
has no approval screen. Lineage is table-level through the SQL and row-level to the source file;
column-level lineage is not derived. These are listed in `README.md`; keep that list truthful.
