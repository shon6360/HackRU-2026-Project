# concord package

Read `../CLAUDE.md` first for commands and the rules that must not be broken.

## Modules

| Module | Role |
|---|---|
| `__main__.py` | CLI: `build`, `serve`, `ask`. Imports lazily so `build` does not need FastAPI |
| `config.py` | Paths, `LAYERS`, `LINEAGE_COLUMNS`, `ID_MAPS`, `snapshot_date()`, `platform_now()`, `role_db()` |
| `models.py` | Loads `models/**/*.sql`: parses the `-- @` header, reads dependencies out of the SQL with sqlglot, orders topologically |
| `pipeline.py` | `build()`: bronze load, run models, quality, catalog (`meta.*`), role databases |
| `quality.py` | `RULES`, `FEED_RULES`, `run()`, `score_answer_key()` |
| `policy.py` | `TAGS`, `ROLES`, and four small functions. The whole access policy |
| `engine.py` | `catalog()`, `preflight()`, `execute()`, `upstream_graph()`, `answer_context()`, `trace()` |
| `ask.py` | `VETTED` questions, matching, the Claude call, `ask()` |
| `server.py` | FastAPI app: a thin JSON API over the engine, plus the static front end |

Imports point one way. `pipeline` uses `config`, `policy`, `quality` and `models`; `engine`
uses `config` and `policy`; `ask` uses `engine`; `server` uses `ask`, `engine`, `policy` and
`quality`. `pipeline` and `engine` do not import each other: the write side and the read side
meet only through the files in `build/`.

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

## engine.py

`execute(sql, role)` never raises for bad input. It always returns the same result dict, with
problems in `error` and policy outcomes in `decisions` and `denied`. Callers and the front end
rely on that shape.

`preflight` (sqlglot, DuckDB dialect) rejects anything that is not exactly one `SELECT`-like
statement, any DML/DDL/`COPY`/`ATTACH`/command node, table functions such as `read_csv`, and
tables not in the catalog (with a did-you-mean). An unqualified table name is taken to be in
`gold`. It then records a `deny` decision per withheld table and a `mask` decision per withheld
column the query touches (`SELECT *` touches all of them).

If anything is denied, nothing is executed. Otherwise the query runs as
`SELECT * FROM (<sql>) AS answer LIMIT 501` in the role's database, opened read-only with
`enable_external_access=false` and `lock_configuration=true`, with a 15-second interrupt.
`ROW_LIMIT` is 500; row 501 only sets `truncated`.

`answer_context(tables)` is what makes an answer trustworthy: the upstream graph, the feeds it
depends on, a `stale` warning per feed past its SLA, and a `quality` warning listing failing
rules on upstream datasets. Two details matter:

- The data path does not follow `config.ID_MAPS` (the two crosswalks). They read every system
  to map ids, so following them would make every answer depend on every feed. The lineage graph
  still shows them.
- Rules with severity `info` do not raise warnings.

`TRACEABLE` maps a result column name to how it is traced: `entity` keys (`site_key`,
`subject_key`, `dispensed_subject_key`) show the crosswalk rows plus source rows from every gold
table that has the key and `_src_row`; `record` keys (`case_id`, `doc_no`, `kit_id`, `visit_id`,
`ae_key`, `edc_ae_key`, `rand_no`) show the one gold table's source rows. A column is clickable
in the UI only if its name is in this dict. `trace` runs in the role's database and reports
withheld blocks instead of hiding them.

## ask.py

`ask(question, role)` resolves in this order and always reports `mode`:

1. Closest `VETTED` question by token overlap (Jaccard, over the question and its `ALSO`
   phrasings). Score >= 0.85: run its reviewed SQL. `mode: "vetted"`.
2. Else, if a key is set: Claude writes the SQL. `mode: "model"`. One retry if the SQL errors.
   The model may decline (`can_answer: false`), which returns `declined: true`.
3. Else, or if the model call raised: score >= 0.34 runs the closest reviewed question, with a
   `note`. `mode: "vetted"`.
4. Else `mode: "none"` with `suggestions`.

The system prompt (`_schema_prompt`) is built from the catalog as the role sees it: only gold
and master tables, masked columns marked, withheld tables listed by name and description
without their columns, sample values omitted for masked columns, and every `VETTED` pair as an
example. It is sent with `cache_control`. Output is parsed into the `SqlAnswer` pydantic model.
Whatever the model returns goes through `engine.execute` like anyone else's SQL.

`VETTED` is used in three places: answering, the model's examples, and the chips on the Ask
page (`/api/meta`). A new entry needs `id`, `question`, `systems`, `explanation`, `sql`. Write
the SQL against gold tables with schema-qualified names, include a traceable key, and use the
snapshot date, never `current_date`.

## server.py

| Route | Returns |
|---|---|
| `GET /api/meta` | snapshot date, roles, tags, feeds, layer counts, model availability, reviewed questions |
| `POST /api/ask` `{question, role}` | `ask.ask()` result |
| `POST /api/sql` `{sql, role}` | `engine.execute()` result, `mode: "sql"` |
| `GET /api/trace?role&column&value` | `engine.trace()` |
| `GET /api/catalog?role` | dataset summaries with access and FAIR score |
| `GET /api/dataset/{fqn}?role` | one dataset: columns, preview, lineage, rules, SQL |
| `GET /api/lineage` | the whole graph |
| `GET /api/crosswalk?role` | site crosswalk, subject match counts |
| `GET /api/quality?role` | rules, failures, answer-key score |
| `GET /api/access` | every tagged table and what each role gets |
| `GET /`, `/static/*` | the front end from `web/` |

Catalog metadata is deliberately visible to every role, including for tables whose data is
withheld. What is hidden for a withheld table or masked column is the data and anything derived
from it: preview rows, sample values, min and max, failure records.

Handlers that use `engine.warehouse()` instead of `engine.role_connection(role)` are reading
unfiltered data and must filter by policy before returning it. Prefer `role_connection`.

`_fair()` scores each dataset on eight fixed checks (two per FAIR letter). Two of them are
always true by construction; the others depend on the description coverage, owner and steward,
master keys or a `@standard`, layer, lineage columns, and upstream feed freshness.
