-- @description Study master record from CTMS, flattened from JSON. Registry fields come from ClinicalTrials.gov.
-- @owner Clinical Operations
-- @grain one row per study
-- @col protocol_number: Protocol number as CTMS writes it
-- @col registry_id: ClinicalTrials.gov identifier
SELECT
    raw::JSON ->> '$.protocol_number'  AS protocol_number,
    raw::JSON ->> '$.registry_id'      AS registry_id,
    raw::JSON ->> '$.brief_title'      AS brief_title,
    raw::JSON ->> '$.phase'            AS phase,
    raw::JSON ->> '$.lead_sponsor'     AS registry_lead_sponsor,
    raw::JSON ->> '$.overall_status'   AS registry_status,
    TRY_CAST(raw::JSON ->> '$.planned_sites' AS INTEGER) AS planned_sites,
    _src_system, _src_file, _src_row
FROM bronze.ctms_study
