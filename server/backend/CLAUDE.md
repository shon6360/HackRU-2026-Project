# Back end

The read side: answers questions from what the harmonizer left in `build/`, knows who is signed
in, and serves the JSON API and the web app that `client/` builds. Read
`../../CLAUDE.md` first for commands and the rules that must not be broken. Commands run in `server/`, and
paths here are relative to it.

```bash
python -m backend build                         # the warehouse, then the web app
python -m backend serve [--host H --port P]     # default 127.0.0.1:8040. --host 0.0.0.0 lets other computers open it
python -m backend ask "Which sites are we late paying?" --role finance
```

## Modules

| Module | Role |
|---|---|
| `__main__.py` | CLI: `build`, `serve`, `ask`. `build` runs the harmonizer's pipeline, then npm in `../client/`. The other two run the pipeline first when there is no warehouse. `serve` prints where it is listening and, when that is beyond this computer, the address to open from another one |
| `engine.py` | `catalog()`, `preflight()`, `execute()`, `upstream_graph()`, `data_path()`, `source_files()`, `answer_context()`, `trace()` |
| `ask.py` | The Gemini call, the `EXAMPLES` it is shown, `ask()` |
| `filters.py` | The filter form: `CATEGORIES`, `options()` (what a role can pick from), `build()` (picks to SQL), `run()` |
| `accounts.py` | Roles, accounts, passwords, sessions and each account's own Gemini key in `state/accounts.db` (SQLite). Says which role a request runs as and which grants that role holds |
| `server.py` | FastAPI app: sign-in, a thin JSON API over the engine, plus the built web app as static files |

Imports point one way. `accounts` uses `config` and `policy` from the harmonizer and nothing
else here; `engine` uses those and `accounts` (for a role's grants); `ask` uses `engine` and
`accounts`; `filters` uses `engine`; `server` uses all four, and the harmonizer's `policy` and `quality`. The back
end imports `harmonizer.config`, `harmonizer.policy` and `harmonizer.quality` and nothing else
from there, and it never writes to `build/`: the two sides meet only through those files. The
one exception is `__main__.py`, which calls `harmonizer.pipeline.build()` for `build` and on first
use.

## engine.py

`execute(sql, role)` never raises for bad input. It always returns the same result dict, with
problems in `error` and policy outcomes in `decisions` and `denied`. Callers and the client
rely on that shape.

`preflight` (sqlglot, DuckDB dialect) rejects anything that is not exactly one `SELECT`-like
statement, any DML/DDL/`COPY`/`ATTACH`/command node, table functions such as `read_csv`, and
tables not in the catalog (with a did-you-mean). An unqualified table name is taken to be in
`gold`. It then records a `deny` decision per withheld table and a `mask` decision per withheld
column the query touches (`SELECT *` touches all of them).

If anything is denied, nothing is executed. Otherwise the query runs as
`SELECT * FROM (<sql>) AS answer LIMIT 501` in the mart for the role's grants, opened read-only with
`enable_external_access=false` and `lock_configuration=true`, with a 15-second interrupt.
`ROW_LIMIT` is 500; row 501 only sets `truncated`.

`answer_context(tables)` is what makes an answer trustworthy: the upstream graph, the feeds it
depends on, a `stale` warning per feed past its SLA, and a `quality` warning listing failing
rules on upstream datasets. Two details matter:

- The data path (`data_path()`) does not follow `config.ID_MAPS` (the two crosswalks). They read
  every system to map ids, so following them would make every answer depend on every feed. The
  lineage graph still shows them.
- Rules with severity `info` do not raise warnings.

`source_files(fqn)` names the feed files behind one table, in the same two groups: `files`, on
the data path, are the ones its rows are built from, and `id_files` are the ones reached only
through the crosswalks. It is table-level, like the lineage it is read from: it does not say which
file one column comes from.

`TRACEABLE` maps a result column name to how it is traced: `entity` keys (`site_key`,
`subject_key`, `dispensed_subject_key`) show the crosswalk rows plus source rows from every gold
table that has the key and `_src_row`; `record` keys (`case_id`, `doc_no`, `kit_id`, `visit_id`,
`ae_key`, `edc_ae_key`, `rand_no`) show the one gold table's source rows. A column is clickable
in the UI only if its name is in this dict. `trace` runs in the role's mart and reports
withheld blocks instead of hiding them.

## ask.py

There are two keys a question can be asked with. The server's (`GEMINI_API_KEY`) and the model id
(`CONCORD_MODEL`) come from the environment, which `harmonizer/config.py` fills from `.env` before
this module is imported; `MODEL` is read once at import and `model_available()`, which is about
the server's key only, on every call. The other is the asking account's own, which `server.py`
reads with `accounts.gemini_key()` and passes in as `api_key`. An account's key wins over the
server's and is never used for anyone else's question. It decides who the model call is charged
to and nothing else: the role still decides what the answer may contain.

`ask(question, role, api_key=None)` always reports `mode`. "A key is set" means `api_key` or the
server's:

1. No key is set: nothing is run. `mode: "none"`, and `explanation` says free-form asking is not
   enabled and that Filter and Write SQL need no key.
2. Gemini writes the SQL. `mode: "model"`. One retry if the SQL errors. The model may decline
   (`can_answer: false`), which returns `declined: true` and no SQL.
3. The model call raised (network, rate limit, a key Google refuses): nothing is run.
   `mode: "none"` with `model_error`.

There is no fallback that answers without the model. A question that must work with no key is
asked with the filter form or in SQL.

The system prompt (`_schema_prompt`) is built from the catalog as the role sees it: only gold
and master tables, masked columns marked, withheld tables listed by name and description
without their columns, sample values omitted for masked columns, and every `EXAMPLES` pair as an
example. It is sent as the `system_instruction` of one `client.interactions.create` call (the
`google-genai` SDK, `genai.Client(api_key=...)`, where None means the server's key from the
environment), with the `SqlAnswer` JSON schema as the response format, low thinking and
`store=False`. The reply is validated into the `SqlAnswer` pydantic model.
Whatever the model returns goes through `engine.execute` like anyone else's SQL.

`EXAMPLES` is used in one place: the model's prompt. Nothing answers from it and the web app never
sees it. An entry is a `question` and the `sql` a person has checked for it. Write the SQL against
gold tables with schema-qualified names, include a traceable key, and use the snapshot date, never
`current_date`.

## filters.py

The filter form: a site, a subject, a category of data and limits on its fields. No language
model. `build()` writes one `SELECT` by rule, so the same picks always give the same SQL, and
`run()` hands it to `engine.execute()` like anyone else's. Nothing here is the access control.

- **`CATEGORIES`** is the one hand-written list: an `id`, a `label`, a gold `table` and the
  `order` its rows come back in. Everything else is read from the catalog. A field is every column
  of the table but `_src_*`, `site_key` and the table's subject column (`subject_key`, or
  `dispensed_subject_key` for kits), which are the two pickers at the top of the form. Its label is
  the column name made readable (`_label`), its hint is the column's description from the model
  header, and its kind follows from its type: `flag` (BOOLEAN), `date`, `number`, and for text
  `choice` up to `MAX_CHOICES` distinct values, else `text` (a search).
- **`options(role)`** is `GET /api/filters`. The sites, the subjects, the values of each choice
  field and the two ends of each range are read from the mart for the role's grants (`_picks`,
  kept per build and per set of grants), never from the warehouse, so a withheld table offers no
  fields and a masked column no values. A withheld category, a masked field and a withheld
  subject list are still listed, each with the reason: withheld things are named, not left out.
- **`build(spec)`** depends on the catalog and not on the role. It refuses (`FilterError`, with a
  message for the person) a category or field that does not exist, a subject on a table kept per
  site, and a limit that says nothing or is not a number or a date. Field names are only ever
  taken from the catalog and values only ever become quoted literals, numbers or `DATE '...'`.
  It selects every column but `_src_*`, so the result keeps its traceable keys, and it returns
  the SQL with a sentence that says the picks back (`question` on the answer).
- **`run(spec, role)`** is `POST /api/filter`. Like `execute()` it never raises for bad input: a
  `FilterError` comes back as `error` with no `sql`. Otherwise it is the `execute()` result with
  `mode: "filter"`.

A condition carries the keys its kind uses: `any_of` (choice), `contains` (text), `min` and/or
`max` (number, date), `equals` (flag). Several conditions are joined with AND; several values of
one choice with OR.

Every function in the engine still takes a role id (`"clinops"`). `engine.grants(role)` turns it
into the grants the role holds at that moment, `engine.access` and `engine.reason` use it, and
`engine.role_connection(role)` opens `mart_connection(grants)`. Nothing keeps a role's grants
between calls, which is what makes an edited role apply on the next request.

## accounts.py

An account is a username, a display name, one role, a password hash, whether it is active, and
optionally its own Gemini API key.
A role is an id, a name, a description, a list of grants (tags from `policy.TAGS`) and
`manages_accounts`. The role is the only thing that connects an account to data, and
`accounts` never opens the warehouse or a mart: it says which grants, the engine opens the
database.

- **Roles.** `roles()` returns every role by id and is what the rest of the back end asks; there
  is no fixed list in code. It is called many times per request, so it re-reads the table only
  when the database file has changed or this process has just written to it (the same idea as
  the catalog cache). `create_role` makes the id from the name (`Safety Reviewer` becomes
  `safety_reviewer`) and the id never changes, so renaming a role does not disturb the accounts
  that hold it. `update_role` signs nobody out. `delete_role` refuses while any account holds
  the role. `STARTER_ROLES` and `STARTERS` are only what an empty database is filled with.

- **Storage.** `state/accounts.db`, SQLite from the standard library, three tables (`roles`,
  `accounts`, `sessions`). Not DuckDB and not `build/`: a build deletes `build/`, and DuckDB lets one process
  write a file, which a server and a test run at the same time would break. `init()` creates the
  tables and, when there are no accounts at all, the four in `STARTERS`. Every function opens
  its own connection through `_db()`; `_db(write=True)` takes the write lock first, so a check
  and the change that depends on it are one transaction.
- **Passwords.** PBKDF2-SHA256, 600,000 rounds, a salt per account, stored as
  `pbkdf2_sha256$rounds$salt$hash`. 8 to 200 characters. Never returned: `_public()` is the only
  way an account leaves the module and it has no hash in it.
- **Gemini keys.** `set_gemini_key(account_id, key)` keeps an account's own key (None removes
  it) and `gemini_key(account_id)` hands it to the model call. It cannot be hashed, because it
  has to be sent to Google, so it is stored as typed in a file that is `chmod 600`. It never
  leaves the module any other way: `_public()` reports `has_gemini_key` and nothing more, to the
  owner and to an administrator alike. An administrator cannot read or set another account's key.
- **Sessions.** `sign_in` returns a random token and stores only its SHA-256, with an expiry 12
  hours on. `account_for(token)` is called on every request, so a changed role, a deactivation
  or a deletion applies to sessions that are already open. A new password or a deactivation
  deletes the account's sessions; changing your own password keeps the session that did it.
- **Sign-in failures.** An unknown username, a wrong password and a deactivated account get the
  same message and take the same time (a decoy hash is checked when there is no account). Five
  failures for one username lock it for five minutes; the count is in memory, so a restart
  clears it.
- **There is always an administrator.** `update`, `delete` and `update_role` make their change
  and then call `_keep_an_administrator`, which raises, and so undoes it, when no active account
  is left whose role has `manages_accounts`.
- `AccountError(message, status)` is raised for anything that cannot be done. The message is
  written for the person and is shown as it is; `server.py` turns it into a JSON error.
- This is the one module that uses the real clock (`time.time()`), for `created_at`,
  `last_login_at` and session expiry.

## server.py

Routes are declared on `api`, an `APIRouter` whose dependency `_account` refuses any request
without a live session (401). Only `/api/login`, `/api/logout` and the generated docs sit on
`app` itself. Put a new route on `api`; a test fails if one that starts with `/api/` is not.

A route that needs the role declares `role: str = Depends(_role)`, which is the signed-in
account's role. Because that is a default, the route stays a plain function and the tests call
`server.quality_view("finance")` directly. A route for administrators declares
`Depends(_admin)` (403 for anyone whose role lacks `manages_accounts`). No route reads a role
from the query string or the body; a `role` a client sends is ignored.

The session token travels in the `concord_session` cookie: `HttpOnly`, `SameSite=Strict`, and
`Secure` when the request came over HTTPS.

The pages and the API come from this one app on one address, so every request the web app makes
is same-origin and there is no CORS middleware: do not add one, because `SameSite=Strict` and the
absence of CORS are what stop another site from using a signed-in browser. That is also what makes
hosting simple: `--host 0.0.0.0`, and another computer needs only a browser. `npm run dev` in
`client/` forwards `/api/...` and nothing else, so anything the web app needs must live under
`/api`, which is why the OpenAPI schema is at `/api/openapi.json`.

| Route | Returns |
|---|---|
| `POST /api/login` `{username, password}` | the account, and sets the session cookie. Public |
| `POST /api/logout` | ends the session and clears the cookie. Public |
| `GET /api/me` | the signed-in account |
| `PATCH /api/me` `{name}` | changes your own name, and nothing else |
| `POST /api/me/password` `{current, new}` | changes your own password |
| `POST /api/me/gemini-key` `{key}` | keeps your own Gemini API key. Returns the account, which says `has_gemini_key` and never the key |
| `DELETE /api/me/gemini-key` | removes it |
| `GET /api/accounts` | every account. Administrators only, like the next three |
| `POST /api/accounts` `{username, name, role, password}` | the new account |
| `PATCH /api/accounts/{id}` `{username?, name?, role?, active?, password?}` | the changed account. Fields left out stay as they are |
| `DELETE /api/accounts/{id}` | removes the account and its sessions |
| `POST /api/roles` `{name, blurb?, grants?, manages_accounts?}` | the new role, with its id. Administrators only, like the next two. Everyone reads the roles from `/api/meta` |
| `PATCH /api/roles/{id}` `{name?, blurb?, grants?, manages_accounts?}` | the changed role. Fields left out stay as they are |
| `DELETE /api/roles/{id}` | removes a role no account holds |
| `GET /api/meta` | snapshot date, roles, tags, feeds, layer counts, the model id and whether the server has a key of its own |
| `POST /api/ask` `{question}` | `ask.ask()` result, asked with the account's own key when it has one |
| `GET /api/filters` | the filter form for the signed-in role: sites, subjects, and each category with its fields and what there is to pick (`filters.options()`) |
| `POST /api/filter` `{category, site_key?, subject_key?, conditions?}` | `filters.run()` result, `mode: "filter"` |
| `POST /api/sql` `{sql}` | `engine.execute()` result, `mode: "sql"` |
| `POST /api/compare` `{sql}` | what the policy decides about the query for each role (`preflight` only). Nothing is run, so no row counts and no data |
| `GET /api/trace?column&value` | `engine.trace()` |
| `GET /api/catalog` | dataset summaries with access and FAIR score |
| `GET /api/dataset/{fqn}` | one dataset: columns, preview, lineage, rules, SQL |
| `GET /api/lineage` | the whole graph, and `gold`: each gold table with its description, its column names and its `source_files()`, which the search on the Lineage page reads |
| `GET /api/crosswalk` | site crosswalk, subject match counts |
| `GET /api/quality` | rules, failures, answer-key score |
| `GET /api/access` | every tagged table and what each role gets |
| `GET /api/docs`, `GET /api/openapi.json` | the interactive API docs and the schema they load. Public |
| everything else | the built web app from `../client/out/` (`server.WEB`), mounted last. `/ask/` serves `ask/index.html`. If the folder is missing at start-up, `/` explains how to build it |

Catalog metadata is deliberately visible to every signed-in role, including for tables whose data is
withheld. What is hidden for a withheld table or masked column is the data and anything derived
from it: preview rows, sample values, min and max, failure records, and the record keys in the
answer key for rules whose findings are withheld.

Handlers that use `engine.warehouse()` instead of `engine.role_connection(role)` are reading
unfiltered data and must filter by policy before returning it. Prefer `role_connection`.

`_fair()` scores each dataset on eight fixed checks (two per FAIR letter). Two of them are
always true by construction; the others depend on the description coverage, owner and steward,
master keys or a `@standard`, layer, lineage columns, and upstream feed freshness.
