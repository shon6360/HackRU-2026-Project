# Slide outline (11 slides)

Judges asked for 10 to 12 slides and said they may not read more. One idea per slide. Screenshots are in
`docs/screenshots/`.

**1. Concord: one question across every clinical trial system**
Team name, HackRU Fall 2026, Regeneron challenge, starter sheet 40. Repo link.

**2. The same site has five names**
The table, from the real feeds: `SITE-0708` / `708` / `US708` / "Seattle Center for Cliical Trials" (sic) / "SEATTLE CENTER FOR CLINICAL TRIALS, LLC".
One line under it: every cross-system question starts with a week of matching.

**3. The question nobody can answer quickly**
"Which sites have open safety cases and low drug supply and overdue payments?"
Today: request five extracts, reconcile in spreadsheets, repeat for the next question.

**4. Concord answers it in milliseconds**
Screenshot `ask.png`. Two sites. Call out the stale-feed warning attached to the answer.

**5. Every number traces to a source row**
Screenshot `trace.png`. Crosswalk with method, confidence and evidence; raw rows with file and row number.

**6. Matching without guessing**
Site numbers match on digits. Names are normalized, scored, and corroborated by investigator or city.
Accept at 0.85 with a 0.05 margin; queue for a steward below that; never guess below 0.70.
Result: 78 automatic, 2 queued, 3 unmatched.

**7. Who is asking changes the answer**
Screenshot `roles.png`. Each person signs in to their own account. Maya (blinded) sees no treatment arm, Arjun sees everything clinical, Dana sees money and site counts only.

**8. The model is not the access control**
Tags on data, grants on roles, one role per account. An administrator edits roles; one read-only database per combination of grants physically lacks what those grants do not cover.
The language model gets only that role's schema; its SQL passes the same check as a person's.

**9. We planted 25 problems. The rules caught 25.**
Screenshot `quality.png`. Plus 23 partial dates in the real CDISC data nobody planted.
Each finding: the record, what is wrong, the file and row.

**10. Real data, documented simulation**
EDC is the real CDISC pilot study. Sites are real ClinicalTrials.gov locations. Safety follows the openFDA layout.
What is simulated is derived from the real data with a fixed seed and written down in `docs/DATA.md`.

**11. Run it yourself**
In `server/`: `pip install -r requirements.txt`, `python -m backend build`, then `python -m backend serve`. Hosted on one computer, opened in a browser from any other. No database server, no API key needed.
DuckDB, 28 SQL models, 27 quality rules, 18 end-to-end tests, MIT license.
What we would build next: a steward's approval screen, column-level lineage, single sign-on in place of our own passwords.
