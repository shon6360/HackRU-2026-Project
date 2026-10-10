-- @description Randomizations from IRT keyed to the master subject and site. Holds the real treatment assignment.
-- @owner Clinical Supply Chain
-- @tags patient_level
-- @grain one row per randomization
-- @col rand_no: Randomization number
-- @col subject_key: Master subject key; null when IRT's subject does not exist in EDC
-- @col site_key: Master site key
-- @col randomization_date: Date of randomization
-- @col arm_code [unblinded]: Treatment code A / B / C
-- @col arm [unblinded]: Treatment description
-- @col stratum: Stratification factor
SELECT
    r.rand_no,
    x.subject_key,
    sx.site_key,
    r.randomization_date,
    r.arm_code,
    r.arm,
    r.stratum,
    r._src_system, r._src_file, r._src_row
FROM silver.irt_randomizations r
LEFT JOIN master.subject_xwalk x ON x.system = 'irt' AND x.native_id = r.subject_no_src
LEFT JOIN master.site_xwalk sx   ON sx.system = 'irt' AND sx.native_id = r.site_code_src
