-- @description Monitoring visit log from CTMS, typed.
-- @owner Clinical Operations
-- @grain one row per monitoring visit
-- @col visit_id: CTMS monitoring visit identifier
-- @col site_number_src: Site number exactly as CTMS writes it
-- @col visit_date: Date of the monitoring visit (source format MM/DD/YYYY)
-- @col open_action_items: Action items still open from this visit
-- @col protocol_deviations: Protocol deviations noted at this visit
SELECT
    visit_id,
    site_number                                        AS site_number_src,
    visit_type,
    CAST(TRY_STRPTIME(visit_date, '%m/%d/%Y') AS DATE) AS visit_date,
    monitor,
    TRY_CAST(open_action_items AS INTEGER)             AS open_action_items,
    TRY_CAST(protocol_deviations_noted AS INTEGER)     AS protocol_deviations,
    report_status,
    _src_system, _src_file, _src_row
FROM bronze.ctms_monitoring_visits
