-- @description Conformed subject dimension: demographics from EDC, randomization date from IRT, and a derived participation status as of the snapshot date.
-- @owner Clinical Data Management
-- @tags patient_level
-- @grain one row per screened subject
-- @col subject_key: Master subject key, e.g. 701-1015
-- @col site_key: Master site key of the subject's site
-- @col usubjid: EDC unique subject identifier
-- @col screening_date: Screening date (EDC)
-- @col randomization_date: Randomization date (IRT); null if never randomized
-- @col first_dose_date: First dose date (EDC)
-- @col arm [unblinded]: Treatment arm
-- @col is_randomized: True once the subject has been randomized and dosed
-- @col status: Screen failure, In screening, Active, Completed or Discontinued, as of the snapshot date
-- @col discontinuation_reason: Reason for early discontinuation, if any
WITH disp AS (
    SELECT usubjid, event, event_date
    FROM silver.edc_dispositions
    WHERE category = 'DISPOSITION EVENT'
    QUALIFY row_number() OVER (PARTITION BY usubjid ORDER BY event_date DESC) = 1
),
rnd AS (
    SELECT x.subject_key, min(r.randomization_date) AS randomization_date
    FROM silver.irt_randomizations r
    JOIN master.subject_xwalk x ON x.system = 'irt' AND x.native_id = r.subject_no_src
    WHERE x.subject_key IS NOT NULL
    GROUP BY 1
)
SELECT
    m.subject_key,
    m.site_key,
    e.usubjid,
    e.age, e.sex, e.race, e.ethnicity,
    e.screening_date,
    rnd.randomization_date,
    e.first_dose_date,
    e.arm,
    (NOT e.is_screen_failure AND e.first_dose_date IS NOT NULL) AS is_randomized,
    CASE WHEN e.is_screen_failure THEN 'Screen failure'
         WHEN e.first_dose_date IS NULL THEN 'In screening'
         WHEN d.event = 'COMPLETED' THEN 'Completed'
         WHEN d.event IS NOT NULL THEN 'Discontinued'
         ELSE 'Active' END AS status,
    CASE WHEN d.event NOT IN ('COMPLETED', 'SCREEN FAILURE') THEN d.event END AS discontinuation_reason,
    d.event_date AS disposition_date,
    e._src_system, e._src_file, e._src_row
FROM master.subject m
JOIN silver.edc_subjects e USING (usubjid)
LEFT JOIN disp d USING (usubjid)
LEFT JOIN rnd ON rnd.subject_key = m.subject_key
