-- @description Golden subject record: one row per screened subject, keyed by the master subject key. EDC is the system of record.
-- @owner Clinical Data Management
-- @tags patient_level
-- @grain one row per subject
-- @col subject_key: Master subject key: site number, dash, subject number, e.g. 701-1015
-- @col site_key: Master site key of the subject's site
-- @col usubjid: EDC unique subject identifier
-- @col subject_number: Subject number within the study
SELECT
    e.site_id_src || '-' || e.subject_number AS subject_key,
    x.site_key,
    e.usubjid,
    e.subject_number,
    e._src_system, e._src_file, e._src_row
FROM silver.edc_subjects e
LEFT JOIN master.site_xwalk x ON x.system = 'edc' AND x.native_id = e.site_id_src
