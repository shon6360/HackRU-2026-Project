-- @description Drug kits from IRT keyed to the master site. Usability is evaluated as of the snapshot date.
-- @owner Clinical Supply Chain
-- @grain one row per kit
-- @col kit_id: Kit identifier
-- @col site_key: Master site key of the site holding the kit
-- @col kit_type [unblinded]: Kit contents; reveals the treatment arm
-- @col lot [unblinded]: Manufacturing lot; the prefix identifies the kit type
-- @col expiry_date: Kit expiry date
-- @col status: AVAILABLE / DISPENSED / EXPIRED / IN_TRANSIT
-- @col is_usable: True for kits on the shelf (AVAILABLE) that have not expired as of the snapshot
-- @col days_to_expiry: Days from the snapshot date to expiry
-- @col dispensed_subject_key [patient_level]: Master subject key the kit was dispensed to
-- @col dispensed_date: Date the kit was dispensed
SELECT
    k.kit_id,
    sx.site_key,
    k.kit_type,
    k.lot,
    k.expiry_date,
    k.status,
    (k.status = 'AVAILABLE' AND k.expiry_date > snap.as_of) AS is_usable,
    date_diff('day', snap.as_of, k.expiry_date)             AS days_to_expiry,
    x.subject_key                                           AS dispensed_subject_key,
    k.dispensed_date,
    k._src_system, k._src_file, k._src_row
FROM silver.irt_kits k
CROSS JOIN gold.snapshot snap
LEFT JOIN master.site_xwalk sx   ON sx.system = 'irt' AND sx.native_id = k.site_code_src
LEFT JOIN master.subject_xwalk x ON x.system = 'irt' AND x.native_id = k.dispensed_subject_no_src
