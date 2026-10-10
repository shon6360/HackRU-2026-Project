-- @description Reconciliation of reportable adverse events in EDC against cases in the safety database. Events are paired on subject and preferred term: identical onset dates first, then whatever is left in date order. This is the check safety and data management teams do by hand in spreadsheets.
-- @owner Global Patient Safety
-- @tags patient_level
-- @grain one row per reportable EDC event or safety case
-- @col recon_key: The EDC event key, or 'case:' plus the case id when there is no EDC event
-- @col subject_key: Master subject key
-- @col site_key: Master site key
-- @col preferred_term: MedDRA preferred term
-- @col edc_ae_key: Key of the EDC adverse event; null when the case has no EDC counterpart
-- @col edc_onset_date: Onset date in EDC
-- @col case_id: Safety case id; null when the EDC event has no case
-- @col case_onset_date: Onset date in the safety case
-- @col recon_status: matched, onset_mismatch, missing_in_safety or missing_in_edc
-- @col onset_day_diff: Safety onset minus EDC onset, in days
WITH edc AS (
    SELECT ae_key, ae_seq, subject_key, site_key, upper(preferred_term) AS term, onset_date, onset_date_raw
    FROM gold.fact_adverse_event
    WHERE is_reportable
),
saf AS (
    SELECT case_id, subject_key, site_key, upper(reaction_pt) AS term, onset_date
    FROM gold.fact_safety_case
    WHERE subject_key IS NOT NULL
),
exact AS (
    SELECT e.ae_key, s.case_id
    FROM edc e
    JOIN saf s ON s.subject_key = e.subject_key AND s.term = e.term AND s.onset_date = e.onset_date
    QUALIFY row_number() OVER (PARTITION BY e.ae_key ORDER BY s.case_id) = 1
        AND row_number() OVER (PARTITION BY s.case_id ORDER BY e.ae_key) = 1
),
edc_rest AS (
    SELECT ae_key, subject_key, term,
           row_number() OVER (PARTITION BY subject_key, term ORDER BY onset_date_raw, ae_seq) AS rn
    FROM edc WHERE ae_key NOT IN (SELECT ae_key FROM exact)
),
saf_rest AS (
    SELECT case_id, subject_key, term,
           row_number() OVER (PARTITION BY subject_key, term ORDER BY onset_date, case_id) AS rn
    FROM saf WHERE case_id NOT IN (SELECT case_id FROM exact)
),
paired AS (
    SELECT ae_key, case_id FROM exact
    UNION ALL
    SELECT e.ae_key, s.case_id
    FROM edc_rest e
    FULL OUTER JOIN saf_rest s ON s.subject_key = e.subject_key AND s.term = e.term AND s.rn = e.rn
)
SELECT
    COALESCE(p.ae_key, 'case:' || p.case_id)   AS recon_key,
    COALESCE(e.subject_key, s.subject_key)     AS subject_key,
    COALESCE(e.site_key, s.site_key)           AS site_key,
    COALESCE(e.term, s.term)                   AS preferred_term,
    p.ae_key                                   AS edc_ae_key,
    e.onset_date                               AS edc_onset_date,
    p.case_id,
    s.onset_date                               AS case_onset_date,
    CASE WHEN p.case_id IS NULL THEN 'missing_in_safety'
         WHEN p.ae_key IS NULL THEN 'missing_in_edc'
         WHEN e.onset_date IS NOT NULL AND s.onset_date <> e.onset_date THEN 'onset_mismatch'
         ELSE 'matched' END                    AS recon_status,
    date_diff('day', e.onset_date, s.onset_date) AS onset_day_diff
FROM paired p
LEFT JOIN edc e ON e.ae_key = p.ae_key
LEFT JOIN saf s ON s.case_id = p.case_id
