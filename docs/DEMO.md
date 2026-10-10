# Three-minute demo script

Record at 1440 × 900 or larger. In `server/`, build if you have not yet (`python -m backend build`)
and start the server (`python -m backend serve`), open
http://127.0.0.1:8040 and sign in as `maya` (password `concord-demo`). Each step has a link that reproduces
the screen, in case a click goes wrong while recording. A link opened without a session shows the sign-in
form first and then goes where it pointed.

## 0:00 The problem (20 seconds)

On the **Crosswalk** page, pointing at the "What each system calls things" table.

> A clinical trial runs on a dozen systems that don't talk to each other. This site is `SITE-0701` in trial
> management, `701` in the trial database, `US701` in drug supply, a free-text name in the safety database
> and a legal name in finance. So when a study lead asks which sites are in trouble, someone spends a week
> matching spreadsheets.

## 0:20 One question, five systems (40 seconds)

Go to **Ask**. Click the first question.
`http://127.0.0.1:8040/ask/?q=Which%20sites%20have%20open%20safety%20cases%2C%20low%20drug%20supply%20and%20overdue%20payments%3F`

> This is the question from the challenge sheet: which sites have open safety cases, low drug supply and
> overdue payments. Milliseconds. Two sites. It read all five systems.
>
> And it tells me what to be careful about. The finance feed is 24 days stale, so a payment made last week
> isn't in here. That warning is attached to the answer, not buried in a dashboard.

## 1:00 Where did that number come from (40 seconds)

Click `S718` in the result.

> Every key is clickable. This is how each system's id was matched to this site, with the evidence. The
> safety database has no site number at all, only a name, so it was matched on name similarity and
> confirmed by the investigator's surname.
>
> Finance is flagged. There are two sites in this city with almost the same name, so the match is used but
> queued for a data steward. And below are the raw rows, exactly as each system exported them, down to the
> file and row number.

## 1:40 Who is asking matters (45 seconds)

Close the drawer. Click *How many subjects and reportable adverse events are there in each treatment arm?*
then the **Compare roles** tab.
`http://127.0.0.1:8040/ask/?q=How%20many%20subjects%20and%20reportable%20adverse%20events%20are%20there%20in%20each%20treatment%20arm%3F&tab=roles`

> I'm signed in as Maya. She runs the study, so she has to stay blind to who got which treatment. She gets
> the count but the arm is withheld. This tab shows what the same SQL gets under each role: the unblinded
> statistician gets the full answer, and finance is refused, because this needs patient-level data.
>
> This isn't a filter in the app. The server takes the role from the account that signed in, and the role
> reads a database that physically doesn't contain what it isn't granted. So it holds whether a person wrote
> the SQL or the language model did.

## 2:25 Can you trust the data (25 seconds)

Go to **Quality**.

> We planted 25 data problems across the five feeds and kept an answer key: duplicate payments, a kit
> dispensed after it expired, serious adverse events that never reached the safety database. The rules catch
> 25 of 25. They also found 23 partial dates in the real CDISC data that we didn't plant.

Expand *Every reportable event in EDC has a case in the safety database*.

> Each finding names the record and the file and row it came from.

## 2:50 Close (10 seconds)

Flash the **Lineage** page, click `site_360`.

> Real CDISC trial data, real ClinicalTrials.gov sites, one command to run, MIT licensed. Concord: one
> question across every system.

## If there is time for questions

- **Accounts and roles**: sign out and sign in as `admin`. On **Roles**, create a role, tick its grants and
  give it to Dana on **Accounts**: her open session answers under it on her next question. Tick one more
  grant on the role and that reaches her too, with no rebuild, because a database for every combination of
  grants is already built. The **profile** page shows any account what its role is
  granted. Signing in as `arjun` or `dana` shows the other two answers from step 1:40 for real.
- **Free-form questions**: with a Gemini API key saved on the **profile** page (or `GEMINI_API_KEY` set in
  `server/.env`), type any question. The model is shown only the schema the current role can see, and the SQL it
  writes is shown under the **SQL** tab. **Open in Write SQL** carries it to the other half of the Ask page,
  where it can be changed and run again. Without a key, the page says free-form asking is not enabled.
- **Catalog**: search `overdue` or `onset`; open `gold.site_360` to show descriptions, owners, freshness,
  the FAIR checklist and the SQL that builds it.
- **Tests**: `python tests/test_concord.py`, run in `server/`, checks that no access database contains a single value its
  grants withhold.
