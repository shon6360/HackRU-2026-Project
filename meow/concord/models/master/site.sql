-- @description Golden site record: one row per real-world site, keyed by the master site key every system is mapped to. CTMS is the system of record; re-keyed duplicates are collapsed.
-- @owner Clinical Operations
-- @grain one row per site
-- @col site_key: Master site key, e.g. S701. Not the identifier of any single source system
-- @col site_number: Numeric site number shared, in different spellings, by CTMS, EDC and IRT
-- @col site_name: Reference site name (CTMS spelling)
-- @col pi_last_name: Investigator surname, used to corroborate fuzzy name matches
SELECT
    'S' || CAST(TRY_CAST(regexp_extract(site_number_src, '(\d+)$', 1) AS INTEGER) AS VARCHAR) AS site_key,
    TRY_CAST(regexp_extract(site_number_src, '(\d+)$', 1) AS INTEGER)                        AS site_number,
    site_name,
    principal_investigator,
    list_extract(string_split(principal_investigator, ' '), -1)                              AS pi_last_name,
    city, state, postal_code, country, latitude, longitude,
    site_status, activation_date, cra,
    _src_system, _src_file, _src_row
FROM silver.ctms_sites
QUALIFY row_number() OVER (PARTITION BY site_number_src ORDER BY _src_row) = 1
