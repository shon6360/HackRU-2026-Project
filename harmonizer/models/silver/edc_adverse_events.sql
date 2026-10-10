-- @description Adverse events from EDC (SDTM AE), typed. Partial onset dates are kept raw and nulled in the typed column.
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
-- @col onset_date: Onset as a date; null when the collected value is partial
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
    TRY_CAST(aestdtc AS DATE)    AS onset_date,
    TRY_CAST(aeendtc AS DATE)    AS end_date,
    aesdth = 'Y'                 AS resulted_in_death,
    aeshosp = 'Y'                AS required_hospitalization,
    _src_system, _src_file, _src_row
FROM bronze.edc_ae
