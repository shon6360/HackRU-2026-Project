-- @description Drug kit inventory and dispensing from IRT, typed. Kit type and lot reveal the treatment.
-- @owner Clinical Supply Chain
-- @grain one row per kit
-- @col kit_id: Kit identifier
-- @col site_code_src: Site exactly as IRT writes it, e.g. US701
-- @col kit_type [unblinded]: Kit contents; reveals the treatment arm of whoever receives it
-- @col lot [unblinded]: Manufacturing lot; the prefix identifies the kit type
-- @col expiry_date: Kit expiry date (source format DDMONYYYY)
-- @col status: AVAILABLE / DISPENSED / EXPIRED / IN_TRANSIT
-- @col dispensed_subject_no_src [patient_level]: Subject the kit was dispensed to, as IRT writes it
-- @col dispensed_date: Date the kit was dispensed
SELECT
    kit_id,
    site                                            AS site_code_src,
    kit_type,
    lot,
    CAST(TRY_STRPTIME(expiry, '%d%b%Y') AS DATE)    AS expiry_date,
    status,
    NULLIF(disp_subject, '')                        AS dispensed_subject_no_src,
    CAST(TRY_STRPTIME(disp_dt, '%d%b%Y') AS DATE)   AS dispensed_date,
    _src_system, _src_file, _src_row
FROM bronze.irt_kits
