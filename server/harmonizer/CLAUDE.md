# Harmonizer

The write side: turns `feeds/` into `build/warehouse.duckdb` and one `build/mart_<grants>.duckdb`
per combination of grants. Read `../../CLAUDE.md` first for commands and the rules that must not be broken.
Commands run in `server/`, and paths here are relative to it.

```bash
python -m harmonizer build
```

## Modules

| Module | Role |
|---|---|
| `__main__.py` | CLI: `build` |
| `config.py` | Loads `.env` on import, then paths (including `ACCOUNTS`, which only the back end uses), `LAYERS`, `LINEAGE_COLUMNS`, `ID_MAPS`, `snapshot_date()`, `platform_now()`, `mart_db()` |
| `models.py` | Loads `models/**/*.sql`: parses the `-- @` header, reads dependencies out of the SQL with sqlglot, orders topologically |
| `pipeline.py` | `build()`: bronze load, run models, quality, catalog (`meta.*`), marts |
| `quality.py` | `RULES`, `FEED_RULES`, `run()`, `score_answer_key()` |
| `policy.py` | `TAGS`, `grant_sets()`, and four small functions over a set of grants. The whole access policy |
| `models/` | One `.sql` file per table (see `models/CLAUDE.md`) |

`pipeline` uses `config`, `policy`, `quality` and `models`. Nothing here imports the back end,
and nothing here needs FastAPI or a model key: the harmonizer runs on DuckDB, sqlglot and
`python-dotenv` alone.

## What the other parts rely on

The back end never calls `build()` logic or reads `feeds/`. It depends on exactly this:

- The files in `build/`: the warehouse (including the `meta` and `dq` schemas) and the
  marts. Changing a table or column name in `meta.*` or `dq.*` breaks `backend/engine.py`
  and `backend/server.py`.
- `config` (paths, snapshot date, `ID_MAPS`, `mart_db()`), `policy` (tags, `grant_sets()` and the
  four functions) and `quality.score_answer_key()`, which the back end imports from this package.

## pipeline.py: the build

`build()` deletes `build/*.duckdb*` and recreates everything, in this order:

1. `gold.snapshot` (one row, the snapshot date).
2. `_load_bronze`: for every `feeds/*/_manifest.json`, every listed file becomes
   `bronze.<system>_<snake(file stem)>`. CSV columns are snake-cased from the header
   (`State/Province` -> `state_province`, `VendorID` -> `vendorid`, `Doc No` -> `doc_no`) and
   loaded as text with `parallel=false`, so `_src_row` is the line number in the file. A JSON
   file becomes one `raw` VARCHAR column: one row per element of `results` if the document has
   that key, otherwise one row for the whole document.
3. `_run_models`: executes `models/macros.sql`, then `CREATE TABLE <schema>.<name> AS <sql>`
   for each model in dependency order.
4. `quality.run`: fills `dq.rules` and `dq.failures`.
5. `_write_catalog`: `meta.feeds`, `meta.datasets`, `meta.columns` (null %, distinct count,
   min, max, four most common values per column), `meta.lineage` (src, dst edges).
6. `_build_marts`: for each combination of grants (`policy.grant_sets()`, eight for three tags), a
   fresh database with the four layer schemas. Denied tables are skipped; masked columns are
   written as `CAST(NULL AS <type>)`. All of them are built, whether or not a role holds that
   combination today, because roles are edited while the server runs and never trigger a build.

`meta` and `dq` exist only in the warehouse, never in a mart.

A model's steward and source system come from the feed whose `owner` string equals the model's
`@owner` exactly. No match means steward "Data Stewardship".

`gold.snapshot` is created and cataloged in Python, not by a model file.

## policy.py

```
table  carries a tag the role lacks -> the table does not exist for that role
column carries a tag the role lacks -> the column is NULL for that role
```

Tags: `patient_level`, `unblinded`, `financial`. There are no other rules, no row filters and no
special cases. Keep it that way: the policy is meant to be explainable in one sentence.

The harmonizer knows tags and sets of grants, and nothing about roles or people. The functions
take the grants (`table_denied(dataset, grants)`, `masked_columns(dataset, grants)`), and
`reason(tags, role_name)` only needs a name for its sentence. Roles and accounts belong to the
back end (`backend/accounts.py`), where an administrator edits them; a role is a name for one of
the sets of grants that already has a mart.

Tags are applied when the marts are built, so a new tag, or a tag added to a table or column,
needs `build`. A change to a role does not.
