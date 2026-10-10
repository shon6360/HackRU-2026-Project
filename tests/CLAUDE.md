# tests

One file, nine end-to-end checks. They assert what a judge or an auditor would want to be true,
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
| `test_sandbox_rejects_everything_but_select_on_cataloged_tables` | Pre-flight refuses DDL, multiple statements, table functions, COPY, ATTACH; the role database itself also refuses file access and reconfiguration |
| `test_trace_reaches_source_rows_and_respects_policy` | A site traces to all five systems with raw rows, and withheld blocks are reported as withheld |
| `test_lineage_reaches_a_source_file_for_every_table` | Every table except `gold.snapshot` has a source file upstream |

## Writing a test

- A plain function named `test_*` with bare `assert` and a message that names what failed.
  No fixtures, parametrization or classes, so it keeps working under the plain runner.
- Go through the public surface: `ask.ask`, `engine.execute`, `engine.trace`, `engine.catalog`,
  `engine.role_connection`. Close any connection you open.
- Test the policy at both levels when it matters: what `engine.execute` reports, and what is
  physically in the role database.
- When a model gains a column that reveals the treatment arm, or a new route to patient-level
  or financial data, add that route to the matching test here. The existing tests check a fixed
  list of routes and will not notice a new leak on their own.
