-- @description Vendor master from the ERP. Sites are paid as vendors under their legal names.
-- @owner R&D Finance
-- @grain one row per vendor
-- @col vendor_id: ERP vendor identifier
-- @col legal_name: Vendor legal name, upper-cased with a legal suffix
SELECT
    vendorid           AS vendor_id,
    vendor_legal_name  AS legal_name,
    city,
    state,
    payment_terms,
    _src_system, _src_file, _src_row
FROM bronze.finance_vendors
