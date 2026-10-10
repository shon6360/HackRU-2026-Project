-- @description The study, with the identifier each source system knows it by. Steward-maintained mapping.
-- @owner Data Stewardship
-- @grain one row per study
-- @col study_key: Master study key
-- @col registry_id: ClinicalTrials.gov identifier carried by the CTMS study record
-- @col edc_study_id: Study identifier in EDC
-- @col ctms_protocol: Protocol number in CTMS
-- @col irt_study_code: Study code in IRT
-- @col safety_protocol: Protocol label in the safety database
-- @col finance_project: Project code in the ERP
SELECT
    'CDISCPILOT01'      AS study_key,
    s.registry_id,
    s.brief_title       AS registry_title,
    s.phase,
    s.planned_sites,
    'CDISCPILOT01'      AS edc_study_id,
    s.protocol_number   AS ctms_protocol,
    'PILOT01'           AS irt_study_code,
    'CDISCPILOT-01'     AS safety_protocol,
    'PRJ-CDP01'         AS finance_project,
    s._src_system, s._src_file, s._src_row
FROM silver.ctms_study s
