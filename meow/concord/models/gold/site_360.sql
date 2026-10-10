-- @description One row per site with the headline numbers from all five systems side by side: enrollment and safety from EDC, cases from the safety database, drug supply from IRT, payments from the ERP and oversight from CTMS. Start here for any cross-system site question.
-- @owner Clinical Data Engineering
-- @grain one row per site
-- @col site_key: Master site key
-- @col site_name: Reference site name
-- @col state: US state
-- @col n_screened: Subjects screened (EDC)
-- @col n_randomized: Subjects randomized and dosed (EDC)
-- @col n_active: Randomized subjects still on study as of the snapshot (EDC)
-- @col n_visits: Subject visits completed at the site (EDC)
-- @col n_adverse_events: Adverse events recorded (EDC)
-- @col n_reportable_ae: Serious or severe events with onset on or after screening (EDC)
-- @col open_safety_cases: Cases still OPEN in the safety database
-- @col overdue_followups: Open cases whose follow-up is past due (safety database)
-- @col sae_recon_gaps: Reportable events that do not reconcile between EDC and the safety database
-- @col kits_usable: Unexpired kits on the shelf (IRT)
-- @col kits_in_transit: Kits shipped but not yet received (IRT)
-- @col kits_needed_8w: Kits the site needs for the next 8 weeks: two dispensing visits per active subject
-- @col is_low_supply: True when the site has active subjects and fewer usable kits than it needs for 8 weeks
-- @col n_open_invoices [financial]: Unpaid payment documents (ERP)
-- @col n_overdue_invoices [financial]: Unpaid documents past their due date (ERP)
-- @col overdue_usd [financial]: Total amount past due, in US dollars (ERP)
-- @col max_days_overdue [financial]: Age of the oldest overdue document, in days (ERP)
-- @col paid_usd [financial]: Total paid to the site to date, in US dollars (ERP)
-- @col last_monitoring_date: Most recent monitoring visit (CTMS)
-- @col days_since_monitoring: Days from the last monitoring visit to the snapshot (CTMS)
-- @col open_action_items: Open action items from the last monitoring visit (CTMS)
WITH subj AS (
    SELECT site_key,
           count(*)                                   AS n_screened,
           count(*) FILTER (WHERE is_randomized)      AS n_randomized,
           count(*) FILTER (WHERE status = 'Active')  AS n_active
    FROM gold.dim_subject GROUP BY 1
),
vis AS (
    SELECT site_key, count(*) AS n_visits FROM gold.fact_subject_visit GROUP BY 1
),
ae AS (
    SELECT site_key, count(*) AS n_adverse_events, count(*) FILTER (WHERE is_reportable) AS n_reportable_ae
    FROM gold.fact_adverse_event GROUP BY 1
),
cases AS (
    SELECT site_key,
           count(*) FILTER (WHERE status = 'OPEN')    AS open_safety_cases,
           count(*) FILTER (WHERE is_followup_overdue) AS overdue_followups
    FROM gold.fact_safety_case GROUP BY 1
),
recon AS (
    SELECT site_key, count(*) FILTER (WHERE recon_status <> 'matched') AS sae_recon_gaps
    FROM gold.fact_sae_reconciliation GROUP BY 1
),
kits AS (
    SELECT site_key,
           count(*) FILTER (WHERE is_usable)              AS kits_usable,
           count(*) FILTER (WHERE status = 'IN_TRANSIT')  AS kits_in_transit
    FROM gold.fact_kit GROUP BY 1
),
pay AS (
    SELECT site_key,
           count(*) FILTER (WHERE status = 'OPEN')                    AS n_open_invoices,
           count(*) FILTER (WHERE is_overdue)                         AS n_overdue_invoices,
           COALESCE(sum(amount_usd) FILTER (WHERE is_overdue), 0)     AS overdue_usd,
           max(days_overdue)                                          AS max_days_overdue,
           COALESCE(sum(amount_usd) FILTER (WHERE status = 'PAID' AND amount_usd > 0), 0) AS paid_usd
    FROM gold.fact_payment GROUP BY 1
),
mon AS (
    SELECT v.site_key,
           max(v.visit_date)                       AS last_monitoring_date,
           arg_max(v.open_action_items, v.visit_date) AS open_action_items
    FROM gold.fact_monitoring_visit v
    CROSS JOIN gold.snapshot snap
    WHERE v.visit_date <= snap.as_of
    GROUP BY 1
)
SELECT
    s.site_key,
    s.site_name,
    s.state,
    COALESCE(subj.n_screened, 0)          AS n_screened,
    COALESCE(subj.n_randomized, 0)        AS n_randomized,
    COALESCE(subj.n_active, 0)            AS n_active,
    COALESCE(vis.n_visits, 0)             AS n_visits,
    COALESCE(ae.n_adverse_events, 0)      AS n_adverse_events,
    COALESCE(ae.n_reportable_ae, 0)       AS n_reportable_ae,
    COALESCE(cases.open_safety_cases, 0)  AS open_safety_cases,
    COALESCE(cases.overdue_followups, 0)  AS overdue_followups,
    COALESCE(recon.sae_recon_gaps, 0)     AS sae_recon_gaps,
    COALESCE(kits.kits_usable, 0)         AS kits_usable,
    COALESCE(kits.kits_in_transit, 0)     AS kits_in_transit,
    2 * COALESCE(subj.n_active, 0)        AS kits_needed_8w,
    (COALESCE(subj.n_active, 0) > 0 AND COALESCE(kits.kits_usable, 0) < 2 * COALESCE(subj.n_active, 0)) AS is_low_supply,
    COALESCE(pay.n_open_invoices, 0)      AS n_open_invoices,
    COALESCE(pay.n_overdue_invoices, 0)   AS n_overdue_invoices,
    COALESCE(pay.overdue_usd, 0)          AS overdue_usd,
    pay.max_days_overdue,
    COALESCE(pay.paid_usd, 0)             AS paid_usd,
    mon.last_monitoring_date,
    date_diff('day', mon.last_monitoring_date, snap.as_of) AS days_since_monitoring,
    COALESCE(mon.open_action_items, 0)    AS open_action_items
FROM gold.dim_site s
CROSS JOIN gold.snapshot snap
LEFT JOIN subj  USING (site_key)
LEFT JOIN vis   USING (site_key)
LEFT JOIN ae    USING (site_key)
LEFT JOIN cases USING (site_key)
LEFT JOIN recon USING (site_key)
LEFT JOIN kits  USING (site_key)
LEFT JOIN pay   USING (site_key)
LEFT JOIN mon   USING (site_key)
