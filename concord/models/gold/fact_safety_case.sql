-- @description Safety database cases keyed to the master subject and site. Re-transmissions of the same case are collapsed to the latest version. The site comes from the fuzzy name match, falling back to the subject's own site.
-- @owner Global Patient Safety
-- @tags patient_level
-- @grain one row per case (latest version)
-- @col case_id: Safety report identifier
-- @col company_number: Manufacturer control number
-- @col subject_key: Master subject key; null when the case's subject number matches nobody in EDC
-- @col site_key: Master site key
-- @col reaction_pt: MedDRA preferred term of the reaction
-- @col is_serious: Seriousness flag
-- @col received_date: Date the sponsor received the report
-- @col onset_date: Reaction onset date
-- @col status: OPEN while follow-up is pending, otherwise CLOSED
-- @col followup_due_date: When follow-up is due for an open case
-- @col is_followup_overdue: True for open cases whose follow-up due date has passed as of the snapshot
-- @col reported_site_name: Site name exactly as written in the case
WITH latest AS (
    SELECT * FROM silver.safety_cases
    QUALIFY row_number() OVER (PARTITION BY company_number ORDER BY report_version DESC, case_id DESC) = 1
)
SELECT
    c.case_id,
    c.company_number,
    sx.subject_key,
    COALESCE(tx.site_key, s.site_key) AS site_key,
    c.reaction_pt,
    c.is_serious,
    c.received_date,
    c.onset_date,
    c.status,
    c.followup_due_date,
    COALESCE(c.status = 'OPEN' AND c.followup_due_date < snap.as_of, FALSE) AS is_followup_overdue,
    c.patient_sex,
    c.patient_age,
    c.site_name_src AS reported_site_name,
    c._src_system, c._src_file, c._src_row
FROM latest c
CROSS JOIN gold.snapshot snap
LEFT JOIN master.subject_xwalk sx ON sx.system = 'safety' AND sx.native_id = c.subject_number_src
LEFT JOIN master.subject s        ON s.subject_key = sx.subject_key
LEFT JOIN master.site_xwalk tx    ON tx.system = 'safety' AND tx.native_id = c.site_name_src
