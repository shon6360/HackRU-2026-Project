-- @description Monitoring visits from CTMS keyed to the master site.
-- @owner Clinical Operations
-- @grain one row per monitoring visit
-- @col visit_id: CTMS monitoring visit identifier
-- @col site_key: Master site key; null when CTMS's site number is not in the site master
-- @col visit_type: Site Initiation, Interim Monitoring or Remote Monitoring Visit
-- @col visit_date: Date of the visit
-- @col open_action_items: Action items still open from this visit
-- @col protocol_deviations: Protocol deviations noted at this visit
SELECT
    v.visit_id,
    x.site_key,
    v.visit_type,
    v.visit_date,
    v.monitor,
    v.open_action_items,
    v.protocol_deviations,
    v.report_status,
    v._src_system, v._src_file, v._src_row
FROM silver.ctms_monitoring_visits v
LEFT JOIN master.site_xwalk x ON x.system = 'ctms' AND x.native_id = v.site_number_src
