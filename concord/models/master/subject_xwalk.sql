-- @description Subject crosswalk: every identifier a source system uses for a subject, mapped to the master subject key. IRT runs site and subject number together; the safety database holds only a bare subject number, so its match is corroborated by site, sex and age.
-- @owner Data Stewardship
-- @tags patient_level
-- @grain one row per (source system, native subject identifier)
-- @col subject_key: Master subject key the identifier resolves to; null when unresolved
-- @col system: Source system the identifier comes from
-- @col native_id: Identifier exactly as the source system writes it
-- @col method: id_pattern or subject_number+corroboration
-- @col confidence: 1.0 for identifier matches; 0.7 plus 0.1 each for agreeing site, sex and age otherwise
-- @col status: auto, review or unresolved
-- @col evidence: Plain-language explanation of why this match was made
WITH edc AS (
    SELECT subject_key, 'edc' AS system, usubjid AS native_id, 'id_pattern' AS method, 1.0 AS confidence,
           'USUBJID is study-site-subject; site ' || split_part(usubjid, '-', 2) || ', subject ' || subject_number AS evidence
    FROM master.subject
),
irt_ids AS (
    SELECT subject_no_src AS native_id FROM silver.irt_randomizations
    UNION
    SELECT dispensed_subject_no_src FROM silver.irt_kits WHERE dispensed_subject_no_src IS NOT NULL
),
irt AS (
    SELECT s.subject_key, 'irt' AS system, i.native_id, 'id_pattern' AS method,
           CASE WHEN s.subject_key IS NULL THEN 0.0 ELSE 1.0 END AS confidence,
           'first 3 digits are the site, the rest the subject number -> ' || substr(i.native_id, 1, 3) || '-' || substr(i.native_id, 4)
               || CASE WHEN s.subject_key IS NULL THEN ', which does not exist in EDC' ELSE '' END AS evidence
    FROM irt_ids i
    LEFT JOIN master.subject s ON s.subject_key = substr(i.native_id, 1, 3) || '-' || substr(i.native_id, 4)
),
safety_obs AS (
    SELECT
        c.subject_number_src AS native_id,
        s.subject_key,
        bool_and(COALESCE(sx.site_key = s.site_key, FALSE))   AS site_ok,
        bool_and(COALESCE(c.patient_sex = e.sex, FALSE))      AS sex_ok,
        bool_and(COALESCE(abs(c.patient_age - e.age) <= 1, FALSE)) AS age_ok,
        count(*)                                              AS n_cases
    FROM silver.safety_cases c
    LEFT JOIN master.subject s       ON s.subject_number = c.subject_number_src
    LEFT JOIN silver.edc_subjects e  ON e.usubjid = s.usubjid
    LEFT JOIN master.site_xwalk sx   ON sx.system = 'safety' AND sx.native_id = c.site_name_src
    GROUP BY 1, 2
),
safety AS (
    SELECT subject_key, 'safety' AS system, native_id, 'subject_number+corroboration' AS method,
           CASE WHEN subject_key IS NULL THEN 0.0
                ELSE round(0.7 + 0.1 * site_ok::INT + 0.1 * sex_ok::INT + 0.1 * age_ok::INT, 2) END AS confidence,
           CASE WHEN subject_key IS NULL THEN 'subject number ' || native_id || ' does not exist in EDC'
                ELSE 'subject number is unique in the study; across ' || n_cases || ' case(s): site '
                     || CASE WHEN site_ok THEN 'agrees' ELSE 'DISAGREES' END || ', sex '
                     || CASE WHEN sex_ok THEN 'agrees' ELSE 'DISAGREES' END || ', age '
                     || CASE WHEN age_ok THEN 'agrees' ELSE 'DISAGREES' END END AS evidence
    FROM safety_obs
),
unioned AS (
    SELECT * FROM edc UNION ALL SELECT * FROM irt UNION ALL SELECT * FROM safety
)
SELECT
    subject_key, system, native_id, method, confidence,
    CASE WHEN subject_key IS NULL THEN 'unresolved'
         WHEN confidence >= 0.85 THEN 'auto'
         ELSE 'review' END AS status,
    evidence
FROM unioned
