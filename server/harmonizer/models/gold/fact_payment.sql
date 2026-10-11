-- @description Site payment documents from the ERP keyed to the master site through the fuzzy vendor match. Duplicate document lines are collapsed. Overdue is evaluated as of the snapshot date.
-- @owner R&D Finance
-- @tags financial
-- @grain one row per payment document
-- @col doc_no: ERP document number
-- @col site_key: Master site key the payee resolves to; null when the vendor is not a study site
-- @col vendor_id: ERP vendor identifier
-- @col payee: Vendor legal name
-- @col invoice_date: Invoice date
-- @col due_date: Payment due date
-- @col paid_date: Date paid; null while open
-- @col amount_usd: Amount in US dollars
-- @col status: PAID / OPEN
-- @col is_overdue: True when the document is open and past its due date as of the snapshot
-- @col days_overdue: Days past due as of the snapshot, for overdue documents
-- @col site_match_status: Whether the vendor-to-site match was automatic or is flagged
SELECT
    p.doc_no,
    x.site_key,
    p.vendor_id,
    p.payee,
    p.description,
    p.invoice_date,
    p.due_date,
    p.paid_date,
    p.amount_usd,
    p.status,
    COALESCE(p.status = 'OPEN' AND p.due_date < snap.as_of, FALSE) AS is_overdue,
    CASE WHEN p.status = 'OPEN' AND p.due_date < snap.as_of
         THEN date_diff('day', p.due_date, snap.as_of) END         AS days_overdue,
    x.status AS site_match_status,
    p._src_system, p._src_file, p._src_row
FROM (
    SELECT * FROM silver.finance_payments
    QUALIFY row_number() OVER (PARTITION BY doc_no ORDER BY _src_row) = 1
) p
CROSS JOIN gold.snapshot snap
LEFT JOIN master.site_xwalk x ON x.system = 'finance' AND x.native_id = p.vendor_id
