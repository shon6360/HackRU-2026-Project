-- @description Adverse events from EDC (SDTM AE), typed. A partial onset date is kept as collected and dated to the first day it can mean.
-- @owner Clinical Data Management
-- @tags patient_level
-- @grain one row per adverse event record
-- @standard CDISC SDTM AE
-- @col usubjid: EDC unique subject identifier
-- @col ae_seq: Sequence number of the event within the subject (SDTM AESEQ)
-- @col preferred_term: MedDRA preferred term (SDTM AEDECOD)
-- @col body_system: MedDRA system organ class (SDTM AEBODSYS)
-- @col severity: MILD / MODERATE / SEVERE (SDTM AESEV)
-- @col is_serious: Serious adverse event flag (SDTM AESER = 'Y')
-- @col onset_date_raw: Onset exactly as collected; may be partial such as '2013-06' (SDTM AESTDTC)
-- @col onset_date: Onset as a date. When only a month or a year was collected, the first day of it; null when the value is not a date at all
-- @col onset_date_precision: How much of the onset date was collected: day, month or year
-- @col end_date: Resolution date; null while ongoing
SELECT
    usubjid,
    CAST(aeseq AS INTEGER)       AS ae_seq,
    aeterm                       AS reported_term,
    aedecod                      AS preferred_term,
    aebodsys                     AS body_system,
    aesev                        AS severity,
    aeser = 'Y'                  AS is_serious,
    aerel                        AS relatedness,
    aeout                        AS outcome,
    aestdtc                      AS onset_date_raw,
    iso_date_start(aestdtc)      AS onset_date,
    iso_date_precision(aestdtc)  AS onset_date_precision,
    TRY_CAST(aeendtc AS DATE)    AS end_date,
    aesdth = 'Y'                 AS resulted_in_death,
    aeshosp = 'Y'                AS required_hospitalization,
    _src_system, _src_file, _src_row
FROM bronze.edc_ae
