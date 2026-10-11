# tests

One file, eighteen end-to-end checks. They assert what a judge or an auditor would want to be true,
not implementation details.

```bash
python tests/test_concord.py                                  # all of them, no runner needed
python -m pytest tests/test_concord.py -q                     # same, if pytest is installed
python -m pytest tests/test_concord.py -k headline -q         # one test
```

`pytest` is not in `requirements.txt`. Run from `server/`; paths here are relative to it. The tests cover the
server only. The client has none: `npm run build` in `client/` type-checks it.

## How they work

- Importing the module calls `build(verbose=False)`. Every test run rebuilds `build/` from the
  committed feeds, so the tests always see the current models, rules and policy. A server that
  is running will pick up the rebuilt warehouse.
- No fixtures and no network. The real feeds are the test data. There is one stand-in: the
  Gemini key test replaces `ask._call_model` for its own duration, because the thing it checks is
  which key reaches the model call, and puts it back in a `finally`.
- Importing the module also points `config.ACCOUNTS` at a new temporary file, so the tests get
  the four starter roles and accounts and never read or change `state/accounts.db`. The file is
  shared by every test in a run, so a test that adds a role or an account removes it again.
- The five account, role and key tests go over HTTP with FastAPI's `TestClient`, because the session cookie
  and the refusals are part of what they check. `signed_in(username)` returns a client that is
  signed in. `TestClient` needs `httpx`, which `google-genai` already installs.
- Expected values come from `feeds/ANSWER_KEY.json`, not from literals, so the tests survive a
  regenerated simulation as long as the system still behaves correctly.
- No call is made to Gemini, even when a key is set: questions are asked with `filters.run` or
  `engine.execute`, never `ask.ask`, except in the Gemini key test, which stands in for the model
  call and puts the server's key aside while it runs. A new test must not call `ask.ask` or
  `/api/ask` without that stand-in, or it reaches the network whenever `.env` holds a key.
- The plain runner at the bottom calls every `test_*` function in alphabetical order and stops
  at the first failure.

## What each test protects

| Test | Guarantee |
|---|---|
| `test_every_planted_problem_is_caught` | Every entry in the answer key is found by a rule, and at least 20 are planted |
| `test_headline_question_matches_the_documented_story` | The challenge question, asked with the filter form, returns exactly the two story sites, and the stale finance feed is flagged on the answer |
| `test_every_example_shown_to_the_model_runs_or_is_refused_for_every_role` | No `EXAMPLES` query errors for any role, and each runs for at least one |
| `test_the_filter_form_offers_and_returns_only_what_the_role_may_see` | For every role and category: a withheld category has no fields and is refused, an allowed one runs without the lineage columns, a masked field offers no values or range, and every value offered is in the role's own database; a blinded role filtering on the arm gets nothing |
| `test_a_filter_returns_the_rows_it_describes_and_is_checked_before_it_becomes_sql` | A subject, a date range and picked values return only matching rows, and the same picks give the same SQL; a quote in a value stays a value; an unknown category or field, a lineage column, SQL in a field name or a number, a backwards range and an empty limit are refused with no SQL written |
| `test_every_grant_database_holds_nothing_the_policy_withholds` | In the database for every combination of grants (all eight, whether or not a role holds it today), withheld tables are absent, allowed ones are present and masked columns hold no values; each role opens the database for its own grants |
| `test_blinded_role_cannot_learn_the_arm_by_any_route` | Clinops gets NULL for the arm through bronze, silver and gold, including kit type |
| `test_finance_role_sees_no_patient_rows_and_statistician_no_money` | The other two roles' boundaries, and that site-level aggregates stay available to finance |
| `test_pages_that_read_the_full_warehouse_withhold_what_the_role_may_not_see` | The Quality and Crosswalk routes read the unfiltered warehouse: findings, answer-key record keys and subject examples are withheld from a role exactly where the underlying table is, while the counts stay visible |
| `test_sandbox_rejects_everything_but_select_on_cataloged_tables` | Pre-flight refuses an empty query, DDL, multiple statements, table functions, COPY, ATTACH; the role database itself also refuses file access and reconfiguration |
| `test_nothing_is_served_without_a_session` | Every route on the `api` router answers 401 without a session, no other `/api/` route exists outside it but sign-in, sign-out and the API docs, a failed sign-in starts no session, and signing out ends one |
| `test_the_role_comes_from_the_account_and_never_from_the_request` | A `role` sent in the body or the query string is ignored by the filter form, SQL, catalog, dataset and trace; comparing roles returns policy decisions only; the administrator holds every grant |
| `test_only_an_administrator_manages_accounts_and_changes_take_effect_at_once` | Other roles are refused the account routes and cannot change their own role; a new role reaches a session that is already open; deactivation ends sessions; the last administrator cannot be removed; passwords and session tokens are stored only as hashes |
| `test_an_administrator_creates_and_edits_roles_and_the_grants_apply_at_once` | Other roles are refused the role routes; a new role sees exactly what it was granted; a grant added, or taken away, reaches a session that is already open; a role in use cannot be removed; the last role that manages accounts cannot give that up |
| `test_each_account_keeps_its_own_gemini_key_and_it_never_comes_back` | With no key anywhere no model is called; a saved key is used for its owner's questions and nobody else's; no route sends it back, to its owner or to an administrator; SQL written under a person's own key still meets their role's policy; removing the key turns free-form asking off again |
| `test_trace_reaches_source_rows_and_respects_policy` | A site traces to all five systems with raw rows, and withheld blocks are reported as withheld |
| `test_lineage_reaches_a_source_file_for_every_table` | Every table except `gold.snapshot` has a source file upstream |
| `test_a_site_found_by_name_shows_every_source_file_it_came_from_and_respects_policy` | A site's name leads to the one site; its lineage lists exactly the files its gold rows name, with the row counts the warehouse holds, and every arrow in a file's chain is a lineage edge; the vendor list is listed for the site's id only; the graph counts the site's rows; for a role without the grant a withheld table is named, appears in no chain and not in the graph, and a file only it reads is not listed; an unknown key is refused |
| `test_a_partial_onset_date_is_dated_to_the_start_of_what_was_collected` | Every adverse event has an `onset_date`: the day collected, or the first day of the month or year when only that was collected, with `onset_date_precision` saying which. A partial date is a warning, not an error: `valid_ae_onset_complete` reports it with severity `warning`, an answer that reads adverse events says so, and the filter form can pick the partial ones out |

## Writing a test

- A plain function named `test_*` with bare `assert` and a message that names what failed.
  No fixtures, parametrization or classes, so it keeps working under the plain runner.
- Go through the public surface of the back end: `filters.run`, `filters.options`, `engine.execute`, `engine.trace`,
  `engine.catalog`, `engine.role_connection`, and the route functions in `server` (they are plain functions that
  take the role as an argument; no HTTP client is needed). Use `signed_in()` only when the session itself is
  what is being tested. Close any connection you open.
- Keep failed sign-ins under five per username in a run: the sixth is locked out for five minutes.
- Test the policy at both levels when it matters: what `engine.execute` reports, and what is
  physically in the mart (`engine.mart_connection(grants)`).
- The starter roles (`clinops`, `biostat`, `finance`, `admin`) can be named in a test, because a
  run starts from a fresh accounts database. Loop over `accounts.roles()`, not over a list.
- When a model gains a column that reveals the treatment arm, or a new route to patient-level
  or financial data, add that route to the matching test here. The existing tests check a fixed
  list of routes and will not notice a new leak on their own.
