-- @description Site master as exported from CTMS, typed. May contain re-keyed duplicates; master.site resolves them.
-- @owner Clinical Operations
-- @grain one row per CTMS site record
-- @col site_number_src: Site number exactly as CTMS writes it, e.g. SITE-0701
-- @col site_name: Site name in CTMS, the reference spelling
-- @col principal_investigator: Principal investigator
-- @col activation_date: Date the site was activated for enrollment (source format MM/DD/YYYY)
-- @col latitude: Site latitude (from the ClinicalTrials.gov location record)
-- @col longitude: Site longitude (from the ClinicalTrials.gov location record)
SELECT
    site_number                                         AS site_number_src,
    site_name,
    principal_investigator,
    city,
    state_province                                      AS state,
    postal_code,
    country,
    TRY_CAST(latitude AS DOUBLE)                        AS latitude,
    TRY_CAST(longitude AS DOUBLE)                       AS longitude,
    site_status,
    CAST(TRY_STRPTIME(activation_date, '%m/%d/%Y') AS DATE) AS activation_date,
    cra,
    protocol                                            AS protocol_src,
    _src_system, _src_file, _src_row
FROM bronze.ctms_sites
