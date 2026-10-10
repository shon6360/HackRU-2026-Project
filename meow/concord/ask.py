"""Turn a question in plain English into SQL, then hand it to the engine.

Two ways to get SQL, and the result always says which one was used:

  vetted   a library of cross-system questions with SQL a person has reviewed. Works with no
           API key, instantly and deterministically; this is also what the model is shown as examples.
  model    Claude writes the SQL from the catalog. It is given only the schema the current role
           may see, and its SQL goes through exactly the same policy check and sandbox as
           anybody else's. The model is a convenience, never the access control.

Set ANTHROPIC_API_KEY to enable the model. CONCORD_MODEL overrides the model id.
"""
from __future__ import annotations

import os
import re

from pydantic import BaseModel, Field

from . import config, engine, policy

MODEL = os.environ.get("CONCORD_MODEL", "claude-opus-5-5")

VETTED = [
    {
        "id": "triple-trouble",
        "question": "Which sites have open safety cases, low drug supply and overdue payments?",
        "systems": ["safety", "irt", "finance", "edc", "ctms"],
        "explanation": "Reads the site summary, which already lines up the safety database, IRT and the ERP on the master site key, "
                       "and keeps the sites that are in trouble on all three at once.",
        "sql": """SELECT site_key, site_name, open_safety_cases, n_active, kits_usable, kits_needed_8w,
       n_overdue_invoices, overdue_usd, max_days_overdue
FROM gold.site_360
WHERE open_safety_cases > 0 AND is_low_supply AND n_overdue_invoices > 0
ORDER BY overdue_usd DESC""",
    },
    {
        "id": "sae-recon",
        "question": "Where do EDC and the safety database disagree about serious or severe adverse events?",
        "systems": ["edc", "safety"],
        "explanation": "Pairs every reportable event in EDC with its case in the safety database on subject and preferred term, "
                       "and lists the ones that are missing on one side or carry different onset dates.",
        "sql": """SELECT r.recon_status, r.subject_key, d.site_name, r.preferred_term,
       r.edc_ae_key, r.edc_onset_date, r.case_id, r.case_onset_date, r.onset_day_diff
FROM gold.fact_sae_reconciliation r
JOIN gold.dim_site d USING (site_key)
WHERE r.recon_status <> 'matched'
ORDER BY r.recon_status, r.subject_key""",
    },
    {
        "id": "by-arm",
        "question": "How many subjects and reportable adverse events are there in each treatment arm?",
        "systems": ["edc"],
        "explanation": "Counts randomized subjects and their serious or severe events by treatment arm. "
                       "The arm is unblinding information, so the answer depends on who is asking.",
        "sql": """SELECT s.arm,
       count(DISTINCT s.subject_key) AS subjects,
       count(a.ae_key) FILTER (WHERE a.is_reportable) AS reportable_events,
       round(count(a.ae_key) FILTER (WHERE a.is_reportable) * 1.0 / count(DISTINCT s.subject_key), 2) AS events_per_subject
FROM gold.dim_subject s
LEFT JOIN gold.fact_adverse_event a USING (subject_key)
WHERE s.is_randomized
GROUP BY s.arm
ORDER BY subjects DESC""",
    },
    {
        "id": "expired-kits",
        "question": "Which kits were dispensed after they expired, and to whom?",
        "systems": ["irt", "ctms"],
        "explanation": "Finds kits whose dispensing date in IRT is later than their expiry date, with the site and the subject who received them.",
        "sql": """SELECT k.kit_id, d.site_name, k.kit_type, k.expiry_date, k.dispensed_date,
       date_diff('day', k.expiry_date, k.dispensed_date) AS days_past_expiry,
       k.dispensed_subject_key
FROM gold.fact_kit k
JOIN gold.dim_site d USING (site_key)
WHERE k.dispensed_date > k.expiry_date
ORDER BY days_past_expiry DESC""",
    },
    {
        "id": "owed",
        "question": "Which sites are we late paying, how much, and how long have they waited?",
        "systems": ["finance", "edc", "ctms"],
        "explanation": "Lists sites with payment documents past their due date in the ERP, next to how many subjects they still have on study.",
        "sql": """SELECT site_key, site_name, n_active, n_overdue_invoices, overdue_usd, max_days_overdue, paid_usd
FROM gold.site_360
WHERE n_overdue_invoices > 0
ORDER BY overdue_usd DESC""",
    },
    {
        "id": "cost-per-visit",
        "question": "What does each site cost us per completed subject visit?",
        "systems": ["finance", "edc"],
        "explanation": "Divides what the ERP shows as paid to each site by the number of subject visits EDC shows it completed.",
        "sql": """SELECT site_key, site_name, n_visits, paid_usd,
       round(paid_usd / NULLIF(n_visits, 0), 0) AS usd_per_visit
FROM gold.site_360
ORDER BY usd_per_visit DESC NULLS LAST""",
    },
    {
        "id": "unmonitored",
        "question": "Which sites with active subjects have not had a monitoring visit in 90 days?",
        "systems": ["ctms", "edc", "safety"],
        "explanation": "Compares the last monitoring visit in CTMS with the snapshot date, for sites that still have subjects on study.",
        "sql": """SELECT site_key, site_name, n_active, last_monitoring_date, days_since_monitoring,
       open_action_items, open_safety_cases
FROM gold.site_360
WHERE n_active > 0 AND days_since_monitoring > 90
ORDER BY days_since_monitoring DESC""",
    },
    {
        "id": "irt-vs-edc",
        "question": "Do IRT and EDC agree on how many subjects each site has randomized?",
        "systems": ["irt", "edc"],
        "explanation": "Counts randomizations per site in IRT and compares them with the subjects EDC shows as randomized and dosed.",
        "sql": """WITH irt AS (
    SELECT site_key, count(*) AS irt_randomized FROM gold.fact_randomization GROUP BY 1
)
SELECT s.site_key, s.site_name, s.n_randomized AS edc_randomized, i.irt_randomized,
       COALESCE(i.irt_randomized, 0) - s.n_randomized AS difference
FROM gold.site_360 s
LEFT JOIN irt i USING (site_key)
ORDER BY abs(COALESCE(i.irt_randomized, 0) - s.n_randomized) DESC, s.site_key""",
    },
    {
        "id": "overdue-followup",
        "question": "Which open safety cases are overdue for follow-up?",
        "systems": ["safety", "ctms"],
        "explanation": "Lists open cases in the safety database whose follow-up due date has passed as of the snapshot.",
        "sql": """SELECT c.case_id, d.site_name, c.subject_key, c.reaction_pt, c.is_serious, c.received_date,
       c.followup_due_date,
       date_diff('day', c.followup_due_date, (SELECT as_of FROM gold.snapshot)) AS days_overdue
FROM gold.fact_safety_case c
JOIN gold.dim_site d USING (site_key)
WHERE c.is_followup_overdue
ORDER BY days_overdue DESC""",
    },
]

_STOP = set("a an and are as at be by do does each for from has have how in is it many much of on or our than that the "
            "their there to us was we were what which who whom with".split())


def _tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {w[:-1] if w.endswith("s") and len(w) > 3 else w for w in words if w not in _STOP}


# Other ways people phrase the reviewed questions; only used for matching when no model is configured.
ALSO = {
    "triple-trouble": ["sites in trouble on safety, supply and payments", "which sites need attention"],
    "sae-recon": ["SAE reconciliation", "serious adverse events missing from the safety database"],
    "by-arm": ["adverse events by arm", "safety by treatment group"],
    "expired-kits": ["expired kits dispensed"],
    "owed": ["who is late getting paid", "overdue site payments", "how much do we owe each site"],
    "cost-per-visit": ["cost per visit by site"],
    "unmonitored": ["sites overdue for monitoring", "last monitoring visit"],
    "irt-vs-edc": ["randomization counts IRT versus EDC"],
    "overdue-followup": ["safety follow-up overdue"],
}


def match_vetted(question: str) -> tuple[dict | None, float]:
    """Closest vetted question by word overlap."""
    q = _tokens(question)
    best, score = None, 0.0
    for v in VETTED:
        for phrasing in [v["question"], *ALSO.get(v["id"], [])]:
            t = _tokens(phrasing)
            s = len(q & t) / len(q | t) if q | t else 0.0
            if s > score:
                best, score = v, s
    return best, score


def model_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


# ----------------------------------------------------------------------------- the model
class SqlAnswer(BaseModel):
    can_answer: bool = Field(description="False when the question cannot be answered from the tables available to this role.")
    sql: str = Field(description="One DuckDB SELECT statement. Empty string when can_answer is false.")
    explanation: str = Field(description="One or two plain sentences on how the query answers the question, or why it cannot be answered.")


def _schema_prompt(role: str) -> str:
    cat = engine.catalog()
    visible, withheld = [], []
    for fqn, ds in cat["datasets"].items():
        if ds["layer"] not in ("gold", "master"):
            continue
        a = engine.access(ds, role)
        if a["denied"]:
            withheld.append(f"- {fqn}: {ds['description']} (withheld: {', '.join(a['denied_tags'])})")
            continue
        lines = [f"### {fqn}", f"{ds['description']} Grain: {ds['grain']}."]
        for name, col in ds["columns"].items():
            if name.startswith("_src_"):
                continue
            mark = f"  [MASKED for this role: always NULL, {', '.join(a['masked'][name])}]" if name in a["masked"] else ""
            samples = "" if mark or not col["samples"] else f"  e.g. {', '.join(col['samples'][:3])}"
            lines.append(f"- {name} {col['type']}: {col['description']}{mark}{samples}")
        visible.append("\n".join(lines))
    examples = "\n\n".join(f"Q: {v['question']}\n{v['sql']}" for v in VETTED)
    r = policy.ROLES[role]
    return f"""You write SQL for Concord, a clinical trial data platform that joins five source systems (EDC, CTMS, IRT, the safety database and the finance ERP) on shared master keys. A study team member asks a question in plain English; you return one DuckDB query that answers it.

The person asking holds the role "{r['name']}": {r['blurb']} Their grants are: {', '.join(r['grants'])}. The tables below are exactly what this role can query. Access is enforced by the database itself, so a query that touches a withheld table fails and a masked column is always NULL. When a question needs something withheld or masked, do not work around it: set can_answer to false and say in the explanation what is withheld and why. If a site-level aggregate that is available (gold.site_360) answers the question just as well, use that instead.

Everything is evaluated as of the snapshot date {config.snapshot_date()}, available as (SELECT as_of FROM gold.snapshot). Do not use current_date.

Writing the query:
- One SELECT statement in DuckDB dialect, schema-qualified table names, no trailing semicolon.
- Prefer the gold tables. Join facts and dimensions on site_key and subject_key; never join on names.
- Include site_key, subject_key or the record's own key (case_id, doc_no, kit_id) in the output when it fits, so the reader can trace each row back to its source. Include site_name alongside site_key.
- Select only the columns that answer the question, with readable aliases for computed values, and order the result so the most important rows come first.

## Tables available to this role

{chr(10).join(visible)}

## Withheld from this role

{chr(10).join(withheld) if withheld else "(nothing)"}

## Reviewed examples

{examples}"""


def _call_model(question: str, role: str, retry_note: str | None = None) -> SqlAnswer:
    import anthropic

    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": question}]
    if retry_note:
        messages[0]["content"] = f"{question}\n\n{retry_note}"
    common = dict(
        model=MODEL,
        max_tokens=8000,
        system=[{"type": "text", "text": _schema_prompt(role), "cache_control": {"type": "ephemeral"}}],
        messages=messages,
        thinking={"type": "adaptive"},
        output_config={"effort": "low"},
        output_format=SqlAnswer,
    )
    try:
        # Let the API re-run the request on another model if a safety classifier declines it.
        response = client.beta.messages.parse(**common, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    except (anthropic.BadRequestError, TypeError):
        response = client.messages.parse(**common)
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return SqlAnswer(can_answer=False, sql="", explanation="The model declined to answer this question.")
    return response.parsed_output


# ----------------------------------------------------------------------------- entry point
def ask(question: str, role: str) -> dict:
    question = question.strip()
    vetted, score = match_vetted(question)
    suggestions = [v["question"] for v in VETTED]

    if vetted and score >= 0.85:
        result = engine.execute(vetted["sql"], role)
        return {**result, "question": question, "mode": "vetted", "explanation": vetted["explanation"],
                "matched_question": vetted["question"], "model": None}

    if model_available():
        try:
            answer = _call_model(question, role)
            if answer.can_answer and answer.sql.strip():
                result = engine.execute(answer.sql, role)
                if result["error"] and not result["denied"]:
                    answer = _call_model(question, role, f"Your previous query failed with this error, fix it:\n{result['error']}\n\nPrevious query:\n{answer.sql}")
                    result = engine.execute(answer.sql, role) if answer.can_answer and answer.sql.strip() else None
                if result is not None:
                    return {**result, "question": question, "mode": "model", "explanation": answer.explanation, "model": MODEL}
            return {"question": question, "role": role, "mode": "model", "model": MODEL, "declined": True,
                    "explanation": answer.explanation, "suggestions": suggestions}
        except Exception as e:  # network, auth, rate limit: fall through to the vetted library
            model_error = f"{type(e).__name__}: {str(e)[:200]}"
    else:
        model_error = None

    if vetted and score >= 0.34:
        result = engine.execute(vetted["sql"], role)
        return {**result, "question": question, "mode": "vetted", "explanation": vetted["explanation"],
                "matched_question": vetted["question"], "model": None, "model_error": model_error,
                "note": "Answered with the closest reviewed question." + ("" if model_available() else " Set ANTHROPIC_API_KEY to ask anything.")}
    return {"question": question, "role": role, "mode": "none", "model": None, "model_error": model_error, "suggestions": suggestions,
            "explanation": "No reviewed question is close to this one"
                           + ("." if model_available() else ", and no language model is configured (set ANTHROPIC_API_KEY to ask anything).")}
