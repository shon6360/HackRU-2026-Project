# SQL models

One `.sql` file per table. The folder is the schema, the file stem is the table name. There is
no registry and no config: adding a file adds a table, a catalog entry and lineage edges.

`macros.sql` is not a model. It is executed once before the models and defines `norm_name()`.

## File format

```sql
-- @description One line saying what the table is.
-- @owner Clinical Operations
-- @tags patient_level, financial
-- @grain one row per ...
-- @standard CDISC SDTM AE
-- @col subject_key: Master subject key
-- @col arm [unblinded]: Treatment arm
SELECT ...
```

- Header lines start at column 0 with `-- @`. Each is a single line: no wrapping.
- Keys: `description`, `owner`, `tags`, `grain`, `standard`, `col`. Any other key raises at
  load. A malformed `@col` raises too.
- The body is a single `SELECT` (CTEs are fine). The pipeline wraps it in `CREATE TABLE AS`.
- DuckDB dialect. It must also parse with sqlglot, which is how dependencies are found.

## Dependencies and lineage

Dependencies are not declared. They are every **schema-qualified** table the SQL references.
Unqualified names are assumed to be CTEs and ignored, so always write `silver.edc_subjects`,
never `edc_subjects`. An unqualified real table would be built in the wrong order and be
missing from the lineage graph.

Layers and what they may read:

| Layer | Reads | Purpose |
|---|---|---|
| `silver` | one `bronze` table | type, rename, parse dates. No joins, no filtering, no deduplication |
| `master` | `silver`, `master` | golden records and crosswalks |
| `gold` | `silver`, `master`, `gold` | conformed facts and dimensions on master keys |

Silver keeps duplicates and bad rows on purpose: quality rules run against silver so they can
see them. Deduplicate in gold (`QUALIFY row_number() ...`), as `fact_payment` and
`fact_safety_case` do.

## Conventions

- **Native ids keep a `_src` suffix** in silver (`site_number_src`, `site_code_src`,
  `subject_no_src`, `site_name_src`). Gold exposes `site_key` / `subject_key` instead, joined
  through `master.site_xwalk` / `master.subject_xwalk` on `(system, native_id)` with a `LEFT JOIN`,
  so unmatched rows survive with a NULL key.
- **Pass the lineage columns through**: `_src_system, _src_file, _src_row` are the last three
  columns of every silver table, of `master.site` and `master.subject`, and of every gold table
  that is one row per source record. The crosswalks and the aggregates (`site_360`,
  `fact_sae_reconciliation`) do not have them, and so cannot be traced to source rows directly.
- **Parse defensively**: `TRY_CAST`, `TRY_STRPTIME`, `NULLIF(x, '')`. A value that will not parse
  becomes NULL and a quality rule reports it; the build never fails on bad data. Where the raw
  value matters, keep it alongside (`onset_date_raw` next to `onset_date`).
- **Snapshot date**: `CROSS JOIN gold.snapshot snap` and compare with `snap.as_of`. Never
  `current_date`.
- **Names**: booleans are usually `is_*`, counts usually `n_*`, money always ends in `_usd`
  (the front end formats dollars on that suffix).
- Columns are aligned with `AS` in a column. Keywords upper-case, functions lower-case.
- Document every column a person would query with `@col`. Undocumented columns show an empty
  description in the catalog and count against the FAIR check (90% of columns described).

## Tags: the part that can leak data

`@tags` on the header tags the whole table. `[tag]` after a column name tags that column.
A role lacking a table tag does not get the table. A role lacking a column tag gets NULLs.

**Tags are not inherited from upstream.** If a model selects a tagged column, or anything
derived from one, it must tag its own output column. Likewise a model built on patient-level
rows must carry `@tags patient_level` itself unless it only outputs site-level aggregates.

Currently tagged, as a guide:

- `patient_level` (table): every table with one row per subject, visit, event, case or
  randomization. `dispensed_subject_no_src` / `dispensed_subject_key` are tagged at column level
  so the kit tables stay usable for site-level supply questions.
- `unblinded` (column): `arm`, `arm_code`, `kit_type`, `lot`. Kit type and lot reveal the arm.
- `financial`: `fact_payment` and `silver.finance_payments` as tables; the five money columns of
  `site_360` as columns, so the rest of `site_360` stays visible to everyone; and `payment_terms`
  in the vendor master as a column, so vendor names stay available for matching sites.

A value derived from an unblinded column is unblinded unless you can argue otherwise in the
description, as `edc_subjects.is_screen_failure` does. `tests/test_concord.py` checks specific
known routes to the arm, not routes you add.

## The crosswalks

`master.site` is keyed `S<site number>` from CTMS, the system of record, with re-keyed
duplicates collapsed to the first row. `master.subject` is keyed `<site>-<subject>` from EDC.

`master.site_xwalk`, one row per `(system, native_id)`:

- CTMS, EDC, IRT: `id_pattern`. Trailing digits of the native id equal the site number.
  Confidence 1.0, or unresolved.
- Safety (free-text name) and finance (vendor legal name): each candidate site is scored
  `0.75 * jaro_winkler(norm_name(src), norm_name(master)) + 0.25 * corroboration`, where
  corroboration is 1 when the investigator surname (safety) or the city (finance) agrees.
  - best score < 0.70: `unresolved`, `site_key` NULL
  - score >= 0.85 and at least 0.05 above the runner-up: `auto`
  - otherwise: `review` (the match is used, and flagged)

`master.subject_xwalk`: EDC and IRT by `id_pattern`; safety has only a bare subject number,
scored `0.7 + 0.1` each for agreeing site, sex and age, `auto` at 0.85 or above.

Every row carries `method`, `confidence`, `status` and a plain-language `evidence` string. The
evidence is shown to users verbatim; keep it readable.

`norm_name()` lower-cases, expands the abbreviations each system uses, and drops legal
suffixes and punctuation. If a new source abbreviates differently, extend the macro rather than
lowering a threshold.

## Definitions baked into gold

Keep these consistent with `docs/DATA.md` if you change them.

- **Reportable event** (`fact_adverse_event.is_reportable`): serious or severe, onset on or
  after screening. Each must have a safety case.
- **Active subject** (`dim_subject.status = 'Active'`): randomized and dosed, no disposition event.
- **Low supply** (`site_360.is_low_supply`): active subjects, and fewer usable kits than two per
  active subject. Usable = `AVAILABLE` and not expired at the snapshot.
- **Overdue payment** (`fact_payment.is_overdue`): `OPEN` and due before the snapshot.
- **SAE reconciliation** (`fact_sae_reconciliation`): EDC reportable events and safety cases
  paired on subject and preferred term; identical onset dates first, then the rest in date order.

`gold.site_360` is the table most questions should start from. A new site-level measure is a
new CTE and a `LEFT JOIN ... USING (site_key)` there, wrapped in `COALESCE(..., 0)`.
