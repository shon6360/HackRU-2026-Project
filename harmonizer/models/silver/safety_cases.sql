-- @description Individual case safety reports from the safety database, flattened from openFDA-shaped JSON.
-- @owner Global Patient Safety
-- @tags patient_level
-- @grain one row per transmitted case report
-- @standard openFDA drug/event (ICH E2B)
-- @col case_id: Safety report identifier (safetyreportid)
-- @col company_number: Manufacturer control number; stable across re-transmissions of the same case (companynumb)
-- @col is_serious: Seriousness flag (serious = 1)
-- @col received_date: Date the sponsor first received the report (source format YYYYMMDD)
-- @col patient_sex: M / F, decoded from E2B 1 / 2
-- @col reaction_pt: MedDRA preferred term of the first listed reaction
-- @col site_name_src: Reporting site as free text. The safety database holds no site number
-- @col subject_number_src: Bare subject number, e.g. 1015
-- @col onset_date: Reaction onset date
-- @col status: OPEN while follow-up is pending, otherwise CLOSED
-- @col followup_due_date: When the next follow-up is due for an open case
WITH j AS (
    SELECT raw::JSON AS c, _src_system, _src_file, _src_row FROM bronze.safety_cases
)
SELECT
    c ->> '$.safetyreportid'                                              AS case_id,
    TRY_CAST(c ->> '$.safetyreportversion' AS INTEGER)                    AS report_version,
    c ->> '$.companynumb'                                                 AS company_number,
    (c ->> '$.serious') = '1'                                             AS is_serious,
    (c ->> '$.seriousnessdeath') = '1'                                    AS resulted_in_death,
    (c ->> '$.seriousnesshospitalization') = '1'                          AS required_hospitalization,
    CAST(TRY_STRPTIME(c ->> '$.receivedate', '%Y%m%d') AS DATE)           AS received_date,
    TRY_CAST(c ->> '$.patient.patientonsetage' AS INTEGER)                AS patient_age,
    CASE c ->> '$.patient.patientsex' WHEN '1' THEN 'M' WHEN '2' THEN 'F' END AS patient_sex,
    c ->> '$.patient.reaction[0].reactionmeddrapt'                        AS reaction_pt,
    c ->> '$.study.protocol'                                              AS protocol_src,
    c ->> '$.study.site_name'                                             AS site_name_src,
    c ->> '$.study.investigator'                                          AS investigator,
    c ->> '$.study.subject_number'                                        AS subject_number_src,
    CAST(TRY_STRPTIME(c ->> '$.study.onset_date', '%Y%m%d') AS DATE)      AS onset_date,
    c ->> '$.case.status'                                                 AS status,
    CAST(TRY_STRPTIME(NULLIF(c ->> '$.case.followup_due', ''), '%Y%m%d') AS DATE) AS followup_due_date,
    c ->> '$.case.assessor'                                               AS assessor,
    _src_system, _src_file, _src_row
FROM j
