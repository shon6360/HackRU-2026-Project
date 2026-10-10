-- @description Subject visits from EDC keyed to the master subject and site.
-- @owner Clinical Data Management
-- @tags patient_level
-- @grain one row per subject visit
-- @col subject_key: Master subject key
-- @col site_key: Master site key
-- @col visit_num: Protocol visit number
-- @col visit_name: Protocol visit name
-- @col visit_date: Date the visit took place
SELECT
    m.subject_key,
    m.site_key,
    v.visit_num,
    v.visit_name,
    v.visit_date,
    v._src_system, v._src_file, v._src_row
FROM silver.edc_visits v
JOIN master.subject m USING (usubjid)
