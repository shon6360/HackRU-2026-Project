-- @description Subject visits recorded in EDC (SDTM SV), typed.
-- @owner Clinical Data Management
-- @tags patient_level
-- @grain one row per subject visit
-- @standard CDISC SDTM SV
-- @col usubjid: EDC unique subject identifier
-- @col visit_num: Protocol visit number
-- @col visit_name: Protocol visit name, e.g. WEEK 12
-- @col visit_date: Date the visit took place (SDTM SVSTDTC)
SELECT
    usubjid,
    TRY_CAST(visitnum AS DOUBLE) AS visit_num,
    visit                        AS visit_name,
    TRY_CAST(svstdtc AS DATE)    AS visit_date,
    _src_system, _src_file, _src_row
FROM bronze.edc_sv
