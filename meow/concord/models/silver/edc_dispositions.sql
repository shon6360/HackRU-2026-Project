-- @description Disposition events from EDC (SDTM DS): completion, discontinuation and its reason.
-- @owner Clinical Data Management
-- @tags patient_level
-- @grain one row per disposition record
-- @standard CDISC SDTM DS
-- @col usubjid: EDC unique subject identifier
-- @col event: Standardized disposition term, e.g. COMPLETED, ADVERSE EVENT (SDTM DSDECOD)
-- @col category: DISPOSITION EVENT for the end-of-study record, OTHER EVENT otherwise (SDTM DSCAT)
-- @col event_date: Date of the disposition event (SDTM DSSTDTC)
SELECT
    usubjid,
    dsdecod                                  AS event,
    dscat                                    AS category,
    dsterm                                   AS reported_term,
    TRY_CAST(substr(dsstdtc, 1, 10) AS DATE) AS event_date,
    _src_system, _src_file, _src_row
FROM bronze.edc_ds
