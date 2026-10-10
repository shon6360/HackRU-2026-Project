-- @description Conformed site dimension. Join any fact to it on site_key.
-- @owner Clinical Operations
-- @grain one row per site
-- @col site_key: Master site key, e.g. S701
-- @col site_number: Numeric site number
-- @col site_name: Reference site name
-- @col principal_investigator: Principal investigator
-- @col state: US state
-- @col site_status: Active or Enrollment Complete
-- @col activation_date: Date the site was activated
-- @col cra: Clinical research associate (monitor) assigned to the site
SELECT
    site_key, site_number, site_name, principal_investigator,
    city, state, postal_code, country, latitude, longitude,
    site_status, activation_date, cra,
    _src_system, _src_file, _src_row
FROM master.site
