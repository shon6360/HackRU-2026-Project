# tests

One file, thirteen end-to-end checks. They assert what a judge or an auditor would want to be true,
not implementation details.

```bash
python tests/test_concord.py                                  # all of them, no runner needed
python -m pytest tests/test_concord.py -q                     # same, if pytest is installed
python -m pytest tests/test_concord.py -k headline -q         # one test
```

`pytest` is not in `requirements.txt`. Run from the repository root.

## How they work

- Importing the module calls `build(verbose=False)`. Every test run rebuilds `build/` from the
  committed feeds, so the tests always see the current models, rules and policy. A server that
  is running will pick up the rebuilt warehouse.
- No fixtures, no mocks, no network. The real feeds are the test data.
- Importing the module also points `config.ACCOUNTS` at a new temporary file, so the tests get
  the four starter accounts and never read or change `state/accounts.db`.
- The three account tests go over HTTP with FastAPI's `TestClient`, because the session cookie
  and the refusals are part of what they check. `signed_in(username)` returns a client that is
  signed in. `TestClient` needs `httpx`, which `google-genai` already installs.
- Expected values come from `feeds/ANSWER_KEY.json`, not from literals, so the tests survive a
  regenerated simulation as long as the system still behaves correctly.
- The model path is not exercised: the questions asked match a reviewed question exactly, so
  no API call is made even when a key is set.
- The plain runner at the bottom calls every `test_*` function in alphabetical order and stops
  at the first failure.

## What each test protects

| Test | Guarantee |
|---|---|
| `test_every_planted_problem_is_caught` | Every entry in the answer key is found by a rule, and at least 20 are planted |
| `test_headline_question_matches_the_documented_story` | The challenge question returns exactly the two story sites, and the stale finance feed is flagged on the answer |
| `test_every_reviewed_question_runs_or_is_refused_for_every_role` | No `VETTED` query errors for any role, and each runs for at least one |
| `test_role_databases_hold_nothing_the_policy_withholds` | In each role database, withheld tables are absent and masked columns hold no values |
| `test_blinded_role_cannot_learn_the_arm_by_any_route` | Clinops gets NULL for the arm through bronze, silver and gold, including kit type |
| `test_finance_role_sees_no_patient_rows_and_statistician_no_money` | The other two roles' boundaries, and that site-level aggregates stay available to finance |
| `test_pages_that_read_the_full_warehouse_withhold_what_the_role_may_not_see` | The Quality and Crosswalk routes read the unfiltered warehouse: findings, answer-key record keys and subject examples are withheld from a role exactly where the underlying table is, while the counts stay visible |
| `test_sandbox_rejects_everything_but_select_on_cataloged_tables` | Pre-flight refuses an empty query, DDL, multiple statements, table functions, COPY, ATTACH; the role database itself also refuses file access and reconfiguration |
| `test_nothing_is_served_without_a_session` | Every route on the `api` router answers 401 without a session, no other `/api/` route exists outside it, a failed sign-in starts no session, and signing out ends one |
| `test_the_role_comes_from_the_account_and_never_from_the_request` | A `role` sent in the body or the query string is ignored by ask, SQL, catalog, dataset and trace; comparing roles returns policy decisions only; the administrator holds every grant |
| `test_only_an_administrator_manages_accounts_and_changes_take_effect_at_once` | Other roles are refused the account routes and cannot change their own role; a new role reaches a session that is already open; deactivation ends sessions; the last administrator cannot be removed; passwords and session tokens are stored only as hashes |
| `test_trace_reaches_source_rows_and_respects_policy` | A site traces to all five systems with raw rows, and withheld blocks are reported as withheld |
| `test_lineage_reaches_a_source_file_for_every_table` | Every table except `gold.snapshot` has a source file upstream |

## Writing a test

- A plain function named `test_*` with bare `assert` and a message that names what failed.
  No fixtures, parametrization or classes, so it keeps working under the plain runner.
- Go through the public surface of the back end: `ask.ask`, `engine.execute`, `engine.trace`,
  `engine.catalog`, `engine.role_connection`, and the route functions in `server` (they are plain functions that
  take the role as an argument; no HTTP client is needed). Use `signed_in()` only when the session itself is
  what is being tested. Close any connection you open.
- Keep failed sign-ins under five per username in a run: the sixth is locked out for five minutes.
- Test the policy at both levels when it matters: what `engine.execute` reports, and what is
  physically in the role database.
- When a model gains a column that reveals the treatment arm, or a new route to patient-level
  or financial data, add that route to the matching test here. The existing tests check a fixed
  list of routes and will not notice a new leak on their own.
