-- @description Site payment documents from the ERP ledger, typed. Amounts parsed from '12,450.00' strings.
-- @owner R&D Finance
-- @tags financial
-- @grain one row per payment document line in the extract
-- @col doc_no: ERP document number
-- @col vendor_id: ERP vendor identifier of the payee
-- @col invoice_date: Invoice date (source format DD.MM.YYYY)
-- @col due_date: Payment due date
-- @col paid_date: Date paid; null while the document is open
-- @col amount_usd: Document amount in US dollars
-- @col status: PAID / OPEN
SELECT
    doc_no,
    vendorid                                             AS vendor_id,
    payee,
    project                                              AS project_src,
    description,
    CAST(TRY_STRPTIME(invoice_date, '%d.%m.%Y') AS DATE) AS invoice_date,
    CAST(TRY_STRPTIME(NULLIF(due_date, ''), '%d.%m.%Y') AS DATE)  AS due_date,
    CAST(TRY_STRPTIME(NULLIF(paid_date, ''), '%d.%m.%Y') AS DATE) AS paid_date,
    TRY_CAST(replace(amount, ',', '') AS DOUBLE)         AS amount_usd,
    currency,
    status,
    _src_system, _src_file, _src_row
FROM bronze.finance_site_payments
