# Concord

One question across every clinical trial system. Concord ingests exports from five mock source
systems (EDC, CTMS, IRT, safety, finance), works out which ids mean the same site and subject,
and answers cross-system questions with the SQL, lineage, source rows, freshness and
data-quality warnings attached, under role-based access control. People sign in to an account,
the account's role decides what they can see, and an administrator creates and edits both.

Concord is hosted on one computer and opened from any other with a browser. The **server**
(`server/`) is Python 3.10+, DuckDB, sqlglot and FastAPI: it holds the data, answers every question,
and serves the web app. The **client** (`client/`) is the source of that web app, Next.js and
Tailwind CSS, built once to static files (Node.js 20.9+). No database server, no Docker, no API key
required.

The code is in three parts:

- **`server/harmonizer/`** turns the feeds into the warehouse and one database per combination of grants (the write side).
- **`server/backend/`** answers questions from what the harmonizer built and serves the JSON API (the read side), and the built web app beside it.
- **`client/`** is the web app. It talks to the back end over `/api/...` and to nothing else.

Dependencies point one way: client -> back end (HTTP only) -> harmonizer (the files in
`server/build/`, plus `config`, `policy` and `quality`). The harmonizer imports neither of the others.
The one thing the server takes from `client/` is the folder of built files, `client/out`.

Paths in a CLAUDE.md under `server/` are relative to `server/`, which is also where its commands run.

## Commands

Run in `server/`, with the virtual environment active. `harmonizer` and `backend` are not
installed; they are imported from the cwd.

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt   # once
python -m backend build                    # everything: build/*.duckdb from feeds/, then ../client/out with npm
python -m harmonizer build                 # the warehouse half only (about 1-2 s)
python -m backend serve [--host H --port P] # default 127.0.0.1:8040, this computer only. --host 0.0.0.0 lets other computers open it
python -m backend ask "Which sites are we late paying?" --role finance   # prints the result JSON. Needs a Gemini key
python tests/test_concord.py               # all 18 tests, no test runner needed
```

- A virtual environment does not survive its folder being moved or renamed: `activate` keeps
  the old path and `python` is then not found. Recreate it, or call `.venv/bin/python` directly.
- `python -m backend build` is the one build command: it runs the harmonizer's pipeline, then
  `npm run build` in `client/` (and `npm install` first when `client/node_modules` is missing).
  Each half still runs alone: `python -m harmonizer build`, or `npm run build` in `client/`.
- `serve` and `ask` build only when `build/warehouse.duckdb` is missing, and never build the web
  app. After changing a model, a feed, a quality rule or the policy, run `python -m harmonizer build`
  yourself.
- The server serves the web app from `client/out`. If that folder is missing when it starts, `/`
  says how to build it and only the API is served; build, then restart.
- **Hosting.** `python -m backend serve --host 0.0.0.0` prints the address to open from another
  computer, which needs a browser and nothing else. One process on one address serves the pages
  and the API, so every request the web app makes is same-origin: that is why the session cookie
  can be `SameSite=Strict` and the server sets no CORS headers. Do not add them, and do not split
  the web app onto another address. The default host stays `127.0.0.1`, because the starter
  accounts' password is public. The host needs Node.js only for the build; `client/out` can also
  be built on another machine and copied over.
- For work on the web app, run `npm run dev` in `client/` beside the server: it serves on
  `127.0.0.1:3000` with hot reload and forwards `/api` to the server at `CONCORD_SERVER` (default
  `http://127.0.0.1:8040`; set it in the shell or in `client/.env` to work against a hosted server).
- A running server picks up a rebuild without a restart (the catalog cache is keyed on the
  warehouse file's mtime). Changes to Python code need a restart; there is no `--reload`.
- `pytest` is not in `requirements.txt`. The tests are written to run under it, so install it
  if you want to run a single test: `python -m pytest tests/test_concord.py -k headline -q`.
- Roles are data, not code. The first start creates `clinops`, `biostat`, `finance` and `admin`
  (every grant, and manages accounts and roles); after that an administrator adds and edits them
  on the Roles page, so never assume those four are the whole list or still hold their starter
  grants. Ask `accounts.roles()`.
- The web app needs a sign-in. The first start also creates four starter accounts, `maya`
  (clinops), `arjun` (biostat), `dana` (finance) and `admin`, all with the password
  `concord-demo`, or whatever `CONCORD_STARTER_PASSWORD` held at that moment. Roles and accounts
  are kept in `server/state/accounts.db` (SQLite, gitignored). Deleting that file brings the starter
  roles and accounts back, which is also the way out of a forgotten administrator password.
  `python -m backend ask --role <id>` needs no account: it is a local tool for whoever already
  has the files. It does create `state/accounts.db` if it is missing, because that is where the
  roles are.
- Free-form questions need a Gemini API key. They are written into SQL by Gemini through the
  `google-genai` SDK; `CONCORD_MODEL` overrides the model id (default `gemini-3.8-flash`). The key
  is the asking account's own, saved on its profile page, and otherwise the server's
  `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). With neither, **Ask a question** is grayed out
  on the Ask page with a line saying why, a typed question is not answered, and the page opens on Filter.
- The Ask page has three ways to ask, and each keeps its own answer: **Ask a question** (plain
  English, written into SQL by Gemini), **Filter** (a form: a site, a subject, a category of data and
  limits on its fields, from which `backend/filters.py` writes the query by rule) and **Write SQL**
  (the query itself). Only the first involves a language model. There is no library of reviewed
  questions that answers by itself: `EXAMPLES` in `backend/ask.py` is only what the model is shown.
- These settings, and `CONCORD_STARTER_PASSWORD`, live in `server/.env` (copy
  `server/.env.example`). `harmonizer/config.py` loads it on import; a variable already set in the
  shell wins. `.env` is gitignored: never commit it, print it or paste its contents anywhere.
  `.env.example` is committed and must only ever hold placeholders. A running server reads `.env`
  once, so restart it after a change. Without a key everything still works from Filter and from
  Write SQL.
- API docs are served at `/api/docs`.

## Layout

```
server/               everything that holds or builds data. Its commands run here
  harmonizer/         feeds -> warehouse: config, policy, pipeline, models, quality (see server/harmonizer/CLAUDE.md)
    models/           one .sql file per table: silver/, master/, gold/ (see server/harmonizer/models/CLAUDE.md)
  backend/            warehouse -> answers: engine, ask, filters, accounts, server (see server/backend/CLAUDE.md)
  feeds/              the five mock source systems. Generated and committed (see server/feeds/CLAUDE.md)
  data/public/        snapshot of the real public data the feeds are derived from (see server/data/CLAUDE.md)
  scripts/            fetch_public_data.py, simulate_feeds.py: regenerate the two folders above (see server/scripts/CLAUDE.md)
  tests/              test_concord.py: end-to-end checks (see server/tests/CLAUDE.md)
  build/              generated DuckDB files. Gitignored. Never edit, never commit
  state/              accounts.db: roles, accounts (with any Gemini key an account saved) and sessions. Gitignored. Created on first start, survives a build
  requirements.txt    the seven Python runtime dependencies. pytest and pandas are not in it
  .env.example        template for server/.env (the Gemini key, the model id, the starter password). .env itself is gitignored
client/               the Next.js and Tailwind app: app/, components/, lib/; built to out/, which the server serves (see client/CLAUDE.md). Its dependencies are in package.json
docs/                 DATA.md, DEMO.md, DECK.md, screenshots/ (see docs/CLAUDE.md)
README.md             the project README, then the HackRU challenge brief from the line `# ONE SOURCE OF TRUTH` on
```

The top half of `README.md` is the entry point for judges and must stay runnable as written from
a clean clone. The bottom half is the organisers' brief (starter sheet 40), kept for reference:
its Good / Better / Best tiers and judging criteria are what the project is measured against.

## How data flows

```
server/data/public/ --simulate_feeds.py--> server/feeds/<system>/*.csv|json + _manifest.json
server/feeds/ --harmonizer: pipeline.build()--> server/build/warehouse.duckdb
    bronze   files as received: every value text, plus _src_system, _src_file, _src_row
    silver   typed, renamed, dates parsed; still one table per source object
    master   golden site and subject records, and the crosswalks that map every system's ids
    gold     conformed facts and dimensions on master keys; gold.site_360 is the headline table
    meta     the catalog: feeds, datasets, columns (with profiles), lineage
    dq       rules and failures
server/build/warehouse.duckdb --policy--> server/build/mart_<grants>.duckdb   (one read-only database per combination of grants: 8)
server/build/ --backend: engine, ask, filters, server--> /api/... --> the web app, in a browser on any computer
server/state/accounts.db --backend: accounts--> which role a request runs as, and which grants that role holds
client/ --npm run build--> client/out --backend: server--> the pages, from the same address as /api
```

Current build: 12 bronze, 12 silver, 4 master, 13 gold tables; 27 quality rules, 54 findings;
25 of 25 planted problems caught; site crosswalk 78 auto, 2 review, 3 unresolved. The thirteenth
gold table is `gold.snapshot`, which `pipeline.build()` creates directly; it has no `.sql` file.

## Rules that must not be broken

**Time is frozen at the snapshot date.** Everything is evaluated as of `server/feeds/_snapshot.json`
(2014-01-31). Never use `current_date`, `now()` or `datetime.now()`. In SQL use
`gold.snapshot` (`(SELECT as_of FROM gold.snapshot)`); in Python use `config.snapshot_date()`
or `config.platform_now()` (08:00 on the snapshot day, the reference for feed freshness).
The one exception is `server/backend/accounts.py`: a sign-in happens today and a session has to end in
real hours, so it reads `time.time()`. Nothing about the study may depend on those times.

**The database is the access control, not the app.** The build makes one database (a mart) for
every combination of grants, `server/build/mart_<grants>.duckdb`, in which the tables those grants do
not cover are physically absent and the masked columns physically NULL. A role reads the mart
for the grants it holds at that moment. User SQL, model-written SQL and the SQL the filter form
writes must only ever run through `engine.execute()`, which uses that database. Editing a role
only changes which mart its holders read, so it needs no build; it never changes what a mart contains.
`engine.warehouse()` opens the full, unfiltered warehouse: anything read through it and returned
to a client must apply `engine.access()` / `policy` by hand, as `/api/crosswalk` and
`/api/quality` do. The language model is a convenience and is never trusted with enforcement.

**The role comes from the session, never from the request.** A route gets its role from
`Depends(_role)` in `server/backend/server.py`, which reads the signed-in account. No route takes a
role as a parameter, and routes are declared on the `api` router, which refuses a request with
no session. The client shows or hides things for convenience and decides nothing.

**Sensitivity tags do not propagate.** A tag on a bronze file or a silver model is not
inherited downstream. Every model that exposes a sensitive column must re-declare the tag in
its own header, or the value leaks into the marts of roles that lack the grant. See `server/harmonizer/models/CLAUDE.md`.

**Row-level provenance is carried everywhere.** Every bronze and silver table, the two golden
records (`master.site`, `master.subject`), and every gold table that is one row per source
record keeps `_src_system`, `_src_file`, `_src_row`. The crosswalks and the aggregates
(`site_360`, `fact_sae_reconciliation`) do not. Tracing an answer back to source rows depends
on these columns.

**Uncertain matches are never guessed.** The crosswalk accepts, queues for a steward, or leaves
unresolved by fixed thresholds. Unresolved ids keep a NULL master key and surface as quality
findings. Do not loosen a threshold to make a number look better.

**Feeds are generated, not edited.** Change `server/scripts/simulate_feeds.py` and regenerate. The
committed feeds are reproduced byte for byte by the script.

**Quality rules never read the answer key.** `server/feeds/ANSWER_KEY.json` is used only to score
the rules (build summary, Quality page, tests).

**Stay honest about the data.** Public or synthetic data only, every source cited, and what is
simulated says so. No real patient, site or payment is described; site names are invented.

## Changing things

| To do this | Touch this | Then |
|---|---|---|
| Add or change a table | a `.sql` file under `server/harmonizer/models/<layer>/` | `build`, run the tests |
| Add a quality rule | `RULES` in `server/harmonizer/quality.py` | `build`; if it is meant to catch a planted problem, plant it in `simulate_feeds.py` |
| Add an example for the model | `EXAMPLES` in `server/backend/ask.py` | run the tests: its SQL must run or be refused cleanly for every role |
| Add a category to the filter form | `CATEGORIES` in `server/backend/filters.py`: a gold table, a label and an order. Its fields come from the catalog | run the tests: it must run or be refused cleanly for every role |
| Add a tag | `TAGS` in `server/harmonizer/policy.py`, plus the tag in manifests and model headers | `build` (the number of marts doubles with each tag); add the tag's colours to `TAG_TONE` in `client/components/ui.tsx`. No role holds a new tag until an administrator grants it |
| Add or change a role | the Roles page, signed in as an administrator. No code and no build | `STARTER_ROLES` in `server/backend/accounts.py` only decides what a new, empty install starts with |
| Change what an account or a role holds, or how sign-in works | `server/backend/accounts.py` | run the tests. A new column needs a migration in `init()`, or `server/state/accounts.db` deleted |
| Make a result column clickable for tracing | `TRACEABLE` in `server/backend/engine.py` | |
| Add or change an API route | `server/backend/server.py` (on `api`, not `app`, and under `/api/`, which is all `npm run dev` forwards), then its type in `client/lib/types.ts` and the page under `client/app/` that calls it | restart the server, rebuild the client; update the route table in `server/backend/CLAUDE.md` |
| Change the simulation | `server/scripts/simulate_feeds.py` | regenerate, `build`, tests, then update the figures quoted in `README.md` and `docs/` |

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
- Dependencies are deliberately few. On the Python side do not add a framework or an ORM. The
  client is Next.js, React and Tailwind CSS and nothing else: no component library, no state or
  data-fetching library.

## Limits that are known and stated

A hackathon prototype on one small study, nothing GxP. Sign-in is a username and a password
kept by Concord itself, with starter accounts whose password is public: there is no single
sign-on, no second factor, no password reset by email and no audit trail of who asked what. A
Gemini key an account saves is kept unencrypted in `server/state/accounts.db`. The server speaks
plain HTTP, so on a network that is not trusted a password or a session token can be read on its
way; hosting it for real needs HTTPS in front. The
crosswalk queues uncertain matches but
has no approval screen. Lineage is table-level through the SQL and row-level to the source file;
column-level lineage is not derived. These are listed in `README.md`; keep that list truthful.
