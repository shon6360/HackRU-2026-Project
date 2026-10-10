# Harmonizer

The write side: turns `feeds/` into `build/warehouse.duckdb` and one `build/role_<role>.duckdb`
per role. Read `../CLAUDE.md` first for commands and the rules that must not be broken.

```bash
python -m harmonizer build
```

## Modules

| Module | Role |
|---|---|
| `__main__.py` | CLI: `build` |
| `config.py` | Loads `.env` on import, then paths, `LAYERS`, `LINEAGE_COLUMNS`, `ID_MAPS`, `snapshot_date()`, `platform_now()`, `role_db()` |
| `models.py` | Loads `models/**/*.sql`: parses the `-- @` header, reads dependencies out of the SQL with sqlglot, orders topologically |
| `pipeline.py` | `build()`: bronze load, run models, quality, catalog (`meta.*`), role databases |
| `quality.py` | `RULES`, `FEED_RULES`, `run()`, `score_answer_key()` |
| `policy.py` | `TAGS`, `ROLES`, and four small functions. The whole access policy |
| `models/` | One `.sql` file per table (see `models/CLAUDE.md`) |

`pipeline` uses `config`, `policy`, `quality` and `models`. Nothing here imports the back end,
and nothing here needs FastAPI or a model key: the harmonizer runs on DuckDB, sqlglot and
`python-dotenv` alone.

## What the other parts rely on

The back end never calls `build()` logic or reads `feeds/`. It depends on exactly this:

- The files in `build/`: the warehouse (including the `meta` and `dq` schemas) and the role
  databases. Changing a table or column name in `meta.*` or `dq.*` breaks `backend/engine.py`
  and `backend/server.py`.
- `config` (paths, snapshot date, `ID_MAPS`, `role_db()`), `policy` (tags, roles and the four
  functions) and `quality.score_answer_key()`, which the back end imports from this package.

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
6. `_build_role_marts`: for each role, a fresh database with the four layer schemas. Denied
   tables are skipped; masked columns are written as `CAST(NULL AS <type>)`.

`meta` and `dq` exist only in the warehouse, never in a role database.

A model's steward and source system come from the feed whose `owner` string equals the model's
`@owner` exactly. No match means steward "Data Stewardship".

`gold.snapshot` is created and cataloged in Python, not by a model file.

## policy.py

```
table  carries a tag the role lacks -> the table does not exist for that role
column carries a tag the role lacks -> the column is NULL for that role
```

Tags: `patient_level`, `unblinded`, `financial`. Roles and grants: `clinops` (Maya:
patient_level, financial), `biostat` (Arjun: patient_level, unblinded), `finance` (Dana:
financial). There are no other rules, no row filters and no special cases. Keep it that way:
the policy is meant to be explainable in one sentence.

Policy is applied when the role databases are built, so a policy change needs `build`.
