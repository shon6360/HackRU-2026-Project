"""Data-quality rules. Each rule is a query that returns the records that FAIL it.

A failing record always carries a key, a plain-language detail and, where it exists, the
source file and row it came from, so a finding can be traced back and fixed at the source.

Rules run against silver (before gold collapses duplicates) or against the reconciliation
tables in gold. Two rules about the feeds themselves (freshness, row counts) are evaluated
from the manifests.

Severity is critical, high, medium or low for an error, in that order. `warning` is for something
a reader should know that is not wrong at the source, such as a date collected only to the month:
it is listed and said on an answer like any finding, and drawn as a warning. `info` is listed and
never said on an answer.
"""
from __future__ import annotations

import json

from . import config

AS_OF = "(SELECT as_of FROM gold.snapshot)"
NO_SRC = "CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS BIGINT)"

RULES = [
    # ------------------------------------------------------------------ uniqueness
    dict(id="uniq_ctms_site_number", title="A site number appears once in the CTMS site list",
         dimension="Uniqueness", severity="high", dataset="silver.ctms_sites",
         total="SELECT count(DISTINCT site_number_src) FROM silver.ctms_sites",
         sql="""SELECT site_number_src, 'listed ' || count(*) || ' times: ' || string_agg(site_name, ' | ' ORDER BY _src_row),
                       any_value(_src_system), any_value(_src_file), max(_src_row)
                FROM silver.ctms_sites GROUP BY 1 HAVING count(*) > 1"""),
    dict(id="uniq_safety_company_number", title="A safety case is transmitted under one report id",
         dimension="Uniqueness", severity="medium", dataset="silver.safety_cases",
         total="SELECT count(DISTINCT company_number) FROM silver.safety_cases",
         sql="""SELECT company_number, 'report ids ' || string_agg(case_id, ', ' ORDER BY case_id) || ' are the same case',
                       any_value(_src_system), any_value(_src_file), max(_src_row)
                FROM silver.safety_cases GROUP BY 1 HAVING count(*) > 1"""),
    dict(id="uniq_payment_document", title="A payment document appears once in the ledger extract",
         dimension="Uniqueness", severity="high", dataset="silver.finance_payments",
         total="SELECT count(DISTINCT doc_no) FROM silver.finance_payments",
         sql="""SELECT doc_no, 'appears ' || count(*) || ' times for ' || any_value(payee) || '; would be double counted',
                       any_value(_src_system), any_value(_src_file), max(_src_row)
                FROM silver.finance_payments GROUP BY 1 HAVING count(*) > 1"""),
    # ------------------------------------------------------------------ referential integrity
    dict(id="fk_monitoring_site", title="Every monitoring visit belongs to a site in the site master",
         dimension="Integrity", severity="high", dataset="silver.ctms_monitoring_visits",
         total="SELECT count(*) FROM silver.ctms_monitoring_visits",
         sql="""SELECT v.visit_id, 'site number ' || v.site_number_src || ' is not in the site master',
                       v._src_system, v._src_file, v._src_row
                FROM silver.ctms_monitoring_visits v
                LEFT JOIN master.site_xwalk x ON x.system = 'ctms' AND x.native_id = v.site_number_src
                WHERE x.site_key IS NULL"""),
    dict(id="fk_randomization_subject", title="Every IRT randomization belongs to a subject in EDC",
         dimension="Integrity", severity="critical", dataset="silver.irt_randomizations",
         total="SELECT count(*) FROM silver.irt_randomizations",
         sql="""SELECT r.subject_no_src, 'randomized ' || r.randomization_date || ' at ' || r.site_code_src || ' but no such subject in EDC',
                       r._src_system, r._src_file, r._src_row
                FROM silver.irt_randomizations r
                LEFT JOIN master.subject_xwalk x ON x.system = 'irt' AND x.native_id = r.subject_no_src
                WHERE x.subject_key IS NULL"""),
    dict(id="fk_kit_site", title="Every kit is held by a site in the site master",
         dimension="Integrity", severity="high", dataset="silver.irt_kits",
         total="SELECT count(*) FROM silver.irt_kits",
         sql="""SELECT k.kit_id, 'site code ' || k.site_code_src || ' is not in the site master',
                       k._src_system, k._src_file, k._src_row
                FROM silver.irt_kits k
                LEFT JOIN master.site_xwalk x ON x.system = 'irt' AND x.native_id = k.site_code_src
                WHERE x.site_key IS NULL"""),
    dict(id="fk_case_subject", title="Every safety case belongs to a subject in EDC",
         dimension="Integrity", severity="critical", dataset="silver.safety_cases",
         total="SELECT count(*) FROM silver.safety_cases",
         sql="""SELECT c.case_id, 'subject number ' || c.subject_number_src || ' (' || c.site_name_src || ') does not exist in EDC',
                       c._src_system, c._src_file, c._src_row
                FROM silver.safety_cases c
                LEFT JOIN master.subject_xwalk x ON x.system = 'safety' AND x.native_id = c.subject_number_src
                WHERE x.subject_key IS NULL"""),
    dict(id="fk_payment_site", title="Every site payment goes to a vendor that is a study site",
         dimension="Integrity", severity="high", dataset="silver.finance_payments",
         total="SELECT count(*) FROM silver.finance_payments",
         sql="""SELECT p.doc_no, 'paid to ' || p.payee || ' (' || p.vendor_id || '), which matches no study site',
                       p._src_system, p._src_file, p._src_row
                FROM silver.finance_payments p
                LEFT JOIN master.site_xwalk x ON x.system = 'finance' AND x.native_id = p.vendor_id
                WHERE x.site_key IS NULL"""),
    dict(id="xwalk_site_unresolved", title="Every site identifier resolves to a master site",
         dimension="Integrity", severity="high", dataset="master.site_xwalk",
         total="SELECT count(*) FROM master.site_xwalk",
         sql=f"""SELECT native_id, system || ' identifier could not be matched: ' || evidence, system, {NO_SRC.split(',', 1)[1]}
                 FROM master.site_xwalk WHERE status = 'unresolved'"""),
    dict(id="xwalk_site_needs_review", title="Fuzzy site matches are unambiguous",
         dimension="Integrity", severity="low", dataset="master.site_xwalk",
         total="SELECT count(*) FROM master.site_xwalk WHERE method <> 'id_pattern'",
         sql=f"""SELECT native_id, 'matched to ' || site_key || ' at ' || confidence || ' but needs a steward: ' || evidence, system, {NO_SRC.split(',', 1)[1]}
                 FROM master.site_xwalk WHERE status = 'review'"""),
    # ------------------------------------------------------------------ validity
    dict(id="valid_monitoring_date_not_future", title="Monitoring visits are not dated in the future",
         dimension="Validity", severity="medium", dataset="silver.ctms_monitoring_visits",
         total="SELECT count(*) FROM silver.ctms_monitoring_visits",
         sql=f"""SELECT visit_id, 'visit dated ' || visit_date || ', after the snapshot date', _src_system, _src_file, _src_row
                 FROM silver.ctms_monitoring_visits WHERE visit_date > {AS_OF}"""),
    dict(id="valid_kit_dispensed_before_expiry", title="No kit is dispensed after it expired",
         dimension="Validity", severity="critical", dataset="silver.irt_kits",
         total="SELECT count(*) FROM silver.irt_kits WHERE dispensed_date IS NOT NULL",
         sql="""SELECT kit_id, 'dispensed ' || dispensed_date || ', expired ' || expiry_date
                           || ' (' || date_diff('day', expiry_date, dispensed_date) || ' days earlier)',
                       _src_system, _src_file, _src_row
                FROM silver.irt_kits WHERE dispensed_date > expiry_date"""),
    dict(id="valid_kit_status_domain", title="Kit status is one of the known values",
         dimension="Validity", severity="low", dataset="silver.irt_kits",
         total="SELECT count(*) FROM silver.irt_kits",
         sql="""SELECT kit_id, 'unknown status ' || COALESCE(status, 'NULL'), _src_system, _src_file, _src_row
                FROM silver.irt_kits WHERE status NOT IN ('AVAILABLE', 'DISPENSED', 'EXPIRED', 'IN_TRANSIT') OR status IS NULL"""),
    dict(id="valid_case_onset_not_future", title="Safety case onset is not in the future",
         dimension="Validity", severity="medium", dataset="silver.safety_cases",
         total="SELECT count(*) FROM silver.safety_cases",
         sql=f"""SELECT case_id, 'onset dated ' || onset_date, _src_system, _src_file, _src_row
                 FROM silver.safety_cases WHERE onset_date > {AS_OF}"""),
    dict(id="valid_payment_amount_positive", title="Payment amounts are positive",
         dimension="Validity", severity="medium", dataset="silver.finance_payments",
         total="SELECT count(*) FROM silver.finance_payments",
         sql="""SELECT doc_no, 'amount ' || COALESCE(CAST(amount_usd AS VARCHAR), 'unparseable') || ' for ' || payee,
                       _src_system, _src_file, _src_row
                FROM silver.finance_payments WHERE amount_usd IS NULL OR amount_usd <= 0"""),
    # a partial onset ('2013-06', '1977') is how the site collected it, not a defect in the feed: the models date it to
    # the first day it can mean. That is a warning, not an error: the reader should know the day is not exact
    dict(id="valid_ae_onset_complete", title="Adverse event onset is a complete date",
         dimension="Validity", severity="warning", dataset="silver.edc_adverse_events",
         total="SELECT count(*) FROM silver.edc_adverse_events",
         sql="""SELECT substr(usubjid, 4) || '#' || ae_seq,
                       'onset collected as "' || COALESCE(onset_date_raw, '') || '" for ' || preferred_term
                           || COALESCE(', dated ' || onset_date, ': not a date'),
                       _src_system, _src_file, _src_row
                FROM silver.edc_adverse_events WHERE onset_date_precision IS DISTINCT FROM 'day'"""),
    # ------------------------------------------------------------------ completeness
    dict(id="complete_payment_due_date", title="Every payment document has a due date",
         dimension="Completeness", severity="medium", dataset="silver.finance_payments",
         total="SELECT count(*) FROM silver.finance_payments",
         sql="""SELECT doc_no, 'no due date for ' || payee || '; cannot tell whether it is overdue',
                       _src_system, _src_file, _src_row
                FROM silver.finance_payments WHERE due_date IS NULL"""),
    dict(id="complete_subject_demographics", title="Every subject has age and sex",
         dimension="Completeness", severity="medium", dataset="silver.edc_subjects",
         total="SELECT count(*) FROM silver.edc_subjects",
         sql="""SELECT usubjid, 'age or sex missing', _src_system, _src_file, _src_row
                FROM silver.edc_subjects WHERE age IS NULL OR sex IS NULL"""),
    # ------------------------------------------------------------------ cross-system consistency
    dict(id="seq_randomized_after_screening", title="Randomization (IRT) is not before screening (EDC)",
         dimension="Consistency", severity="critical", dataset="silver.irt_randomizations",
         total="SELECT count(*) FROM silver.irt_randomizations",
         sql="""SELECT r.subject_no_src, 'IRT says randomized ' || r.randomization_date || ', EDC says screened ' || d.screening_date,
                       r._src_system, r._src_file, r._src_row
                FROM silver.irt_randomizations r
                JOIN master.subject_xwalk x ON x.system = 'irt' AND x.native_id = r.subject_no_src
                JOIN gold.dim_subject d ON d.subject_key = x.subject_key
                WHERE r.randomization_date < d.screening_date"""),
    dict(id="consist_randomized_edc_vs_irt", title="Every subject dosed in EDC has a randomization in IRT",
         dimension="Consistency", severity="critical", dataset="gold.dim_subject",
         total="SELECT count(*) FROM gold.dim_subject WHERE is_randomized",
         sql="""SELECT subject_key, 'first dose ' || first_dose_date || ' in EDC but no randomization in IRT',
                       _src_system, _src_file, _src_row
                FROM gold.dim_subject WHERE is_randomized AND randomization_date IS NULL"""),
    dict(id="seq_paid_after_invoice", title="Payments are not dated before their invoice",
         dimension="Consistency", severity="medium", dataset="silver.finance_payments",
         total="SELECT count(*) FROM silver.finance_payments WHERE paid_date IS NOT NULL",
         sql="""SELECT doc_no, 'paid ' || paid_date || ', invoiced ' || invoice_date, _src_system, _src_file, _src_row
                FROM silver.finance_payments WHERE paid_date < invoice_date"""),
    dict(id="consist_sex_edc_vs_safety", title="Patient sex agrees between EDC and the safety database",
         dimension="Consistency", severity="high", dataset="silver.safety_cases",
         total="SELECT count(*) FROM silver.safety_cases",
         sql="""SELECT c.case_id, 'safety says ' || c.patient_sex || ', EDC says ' || e.sex || ' for subject ' || s.subject_key,
                       c._src_system, c._src_file, c._src_row
                FROM silver.safety_cases c
                JOIN master.subject_xwalk x ON x.system = 'safety' AND x.native_id = c.subject_number_src
                JOIN master.subject s ON s.subject_key = x.subject_key
                JOIN silver.edc_subjects e ON e.usubjid = s.usubjid
                WHERE c.patient_sex <> e.sex"""),
    dict(id="recon_sae_missing_in_safety", title="Every reportable event in EDC has a case in the safety database",
         dimension="Consistency", severity="critical", dataset="gold.fact_sae_reconciliation",
         total="SELECT count(*) FROM gold.fact_sae_reconciliation WHERE edc_ae_key IS NOT NULL",
         sql="""SELECT r.recon_key, a.severity || CASE WHEN a.is_serious THEN ' SERIOUS ' ELSE ' ' END || a.preferred_term
                           || ', onset ' || a.onset_date_raw || ': no case in the safety database',
                       a._src_system, a._src_file, a._src_row
                FROM gold.fact_sae_reconciliation r JOIN gold.fact_adverse_event a ON a.ae_key = r.edc_ae_key
                WHERE r.recon_status = 'missing_in_safety'"""),
    dict(id="recon_sae_missing_in_edc", title="Every safety case has a matching reportable event in EDC",
         dimension="Consistency", severity="high", dataset="gold.fact_sae_reconciliation",
         total="SELECT count(*) FROM gold.fact_sae_reconciliation WHERE case_id IS NOT NULL",
         sql="""SELECT r.case_id, c.reaction_pt || ' for subject ' || r.subject_key || ': no matching reportable event in EDC',
                       c._src_system, c._src_file, c._src_row
                FROM gold.fact_sae_reconciliation r JOIN gold.fact_safety_case c USING (case_id)
                WHERE r.recon_status = 'missing_in_edc'"""),
    dict(id="recon_sae_onset_mismatch", title="Onset dates agree between EDC and the safety database",
         dimension="Consistency", severity="high", dataset="gold.fact_sae_reconciliation",
         total="SELECT count(*) FROM gold.fact_sae_reconciliation WHERE edc_ae_key IS NOT NULL AND case_id IS NOT NULL",
         sql="""SELECT r.case_id, r.preferred_term || ' for subject ' || r.subject_key || ': EDC onset ' || r.edc_onset_date
                           || ', safety onset ' || r.case_onset_date || ' (' || r.onset_day_diff || ' days apart)',
                       c._src_system, c._src_file, c._src_row
                FROM gold.fact_sae_reconciliation r JOIN gold.fact_safety_case c USING (case_id)
                WHERE r.recon_status = 'onset_mismatch'"""),
]

FEED_RULES = [
    dict(id="fresh_feed_within_sla", title="Every feed was extracted within its freshness SLA",
         dimension="Timeliness", severity="high", dataset="meta.feeds"),
    dict(id="complete_feed_rowcount", title="Every file holds the row count its manifest declares",
         dimension="Completeness", severity="high", dataset="meta.feeds"),
]


def run(con, feeds: list[dict], bronze_rows: dict[str, tuple[str, int, int]]) -> dict:
    """Evaluate every rule, store dq.rules and dq.failures, and return a small summary.

    feeds: one dict per source system (from the manifests, with age_hours / is_stale added).
    bronze_rows: file path -> (bronze table, rows declared in the manifest, rows loaded).
    """
    con.execute("CREATE SCHEMA IF NOT EXISTS dq")
    con.execute("""CREATE OR REPLACE TABLE dq.failures (rule_id VARCHAR, record_key VARCHAR, detail VARCHAR,
                   src_system VARCHAR, src_file VARCHAR, src_row BIGINT)""")
    con.execute("""CREATE OR REPLACE TABLE dq.rules (rule_id VARCHAR, title VARCHAR, dimension VARCHAR, severity VARCHAR,
                   dataset VARCHAR, n_checked BIGINT, n_failed BIGINT, sql VARCHAR)""")

    for rule in RULES:
        con.execute(f"INSERT INTO dq.failures SELECT '{rule['id']}', * FROM ({rule['sql']})")
        n_checked = con.execute(rule["total"]).fetchone()[0]
        n_failed = con.execute("SELECT count(*) FROM dq.failures WHERE rule_id = ?", [rule["id"]]).fetchone()[0]
        con.execute("INSERT INTO dq.rules VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [rule["id"], rule["title"], rule["dimension"], rule["severity"], rule["dataset"],
                     n_checked, n_failed, " ".join(rule["sql"].split())])

    stale = [f for f in feeds if f["is_stale"]]
    for f in stale:
        sla_days = round(f["freshness_sla_hours"] / 24)
        con.execute("INSERT INTO dq.failures VALUES (?, ?, ?, ?, NULL, NULL)",
                    ["fresh_feed_within_sla", f["system"],
                     f"extracted {f['extracted_at']}, {f['age_hours'] / 24:.0f} days before the snapshot; "
                     f"SLA is {sla_days} day{'' if sla_days == 1 else 's'}", f["system"]])
    short = [(path, t) for path, t in bronze_rows.items() if t[1] != t[2]]
    for path, (_, declared, loaded) in short:
        con.execute("INSERT INTO dq.failures VALUES (?, ?, ?, ?, ?, NULL)",
                    ["complete_feed_rowcount", path, f"manifest declares {declared} rows, file holds {loaded}",
                     path.split("/")[1], path])
    for rule, n_checked, n_failed in ((FEED_RULES[0], len(feeds), len(stale)), (FEED_RULES[1], len(bronze_rows), len(short))):
        con.execute("INSERT INTO dq.rules VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                    [rule["id"], rule["title"], rule["dimension"], rule["severity"], rule["dataset"], n_checked, n_failed])

    n_rules, n_failing, n_findings = con.execute(
        "SELECT count(*), count(*) FILTER (WHERE n_failed > 0), sum(n_failed) FROM dq.rules").fetchone()
    return {"rules": n_rules, "rules_failing": n_failing, "findings": int(n_findings)}


def score_answer_key(con) -> dict:
    """Compare findings with the planted problems in feeds/ANSWER_KEY.json."""
    key = json.loads((config.FEEDS / "ANSWER_KEY.json").read_text())
    found = set(con.execute("SELECT rule_id, record_key FROM dq.failures").fetchall())
    planted = []
    for p in key["planted"]:
        planted.append({**p, "caught": (p["rule_id"], p["record_key"]) in found})
    planted_keys = {(p["rule_id"], p["record_key"]) for p in key["planted"]}
    return {
        "planted": planted,
        "n_planted": len(planted),
        "n_caught": sum(p["caught"] for p in planted),
        "n_additional": len(found - planted_keys),
    }
