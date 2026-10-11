"""Turn a question in plain English into SQL, then hand it to the engine.

Gemini writes the SQL from the catalog. It is given only the schema the current role may see, and its
SQL goes through exactly the same policy check and sandbox as anybody else's. The model is a
convenience, never the access control.

The model needs a Gemini API key. It is the asking account's own key when they have saved one on
their profile page, and otherwise the server's, GEMINI_API_KEY in `.env` (or the environment).
With neither, free-form asking is not enabled and nothing is answered here: the two ways to ask
that need no model are the filter form (`filters.py`) and the SQL editor. CONCORD_MODEL overrides
the model id.
"""
from __future__ import annotations

import os

from pydantic import BaseModel, Field

from harmonizer import config

from . import accounts, engine

MODEL = os.environ.get("CONCORD_MODEL", "gemini-3.8-flash")

# Questions with SQL a person has checked. They are what the model is shown of how to query this warehouse, and nothing else.
EXAMPLES = [
    {
        "question": "Which sites have open safety cases, low drug supply and overdue payments?",
        "sql": """SELECT site_key, site_name, open_safety_cases, n_active, kits_usable, kits_needed_8w,
       n_overdue_invoices, overdue_usd, max_days_overdue
FROM gold.site_360
WHERE open_safety_cases > 0 AND is_low_supply AND n_overdue_invoices > 0
ORDER BY overdue_usd DESC""",
    },
    {
        "question": "Where do EDC and the safety database disagree about serious or severe adverse events?",
        "sql": """SELECT r.recon_status, r.subject_key, d.site_name, r.preferred_term,
       r.edc_ae_key, r.edc_onset_date, r.case_id, r.case_onset_date, r.onset_day_diff
FROM gold.fact_sae_reconciliation r
JOIN gold.dim_site d USING (site_key)
WHERE r.recon_status <> 'matched'
ORDER BY r.recon_status, r.subject_key""",
    },
    {
        "question": "How many subjects and reportable adverse events are there in each treatment arm?",
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
        "question": "Which kits were dispensed after they expired, and to whom?",
        "sql": """SELECT k.kit_id, d.site_name, k.kit_type, k.expiry_date, k.dispensed_date,
       date_diff('day', k.expiry_date, k.dispensed_date) AS days_past_expiry,
       k.dispensed_subject_key
FROM gold.fact_kit k
JOIN gold.dim_site d USING (site_key)
WHERE k.dispensed_date > k.expiry_date
ORDER BY days_past_expiry DESC""",
    },
    {
        "question": "Which sites are we late paying, how much, and how long have they waited?",
        "sql": """SELECT site_key, site_name, n_active, n_overdue_invoices, overdue_usd, max_days_overdue, paid_usd
FROM gold.site_360
WHERE n_overdue_invoices > 0
ORDER BY overdue_usd DESC""",
    },
    {
        "question": "What does each site cost us per completed subject visit?",
        "sql": """SELECT site_key, site_name, n_visits, paid_usd,
       round(paid_usd / NULLIF(n_visits, 0), 0) AS usd_per_visit
FROM gold.site_360
ORDER BY usd_per_visit DESC NULLS LAST""",
    },
    {
        "question": "Which sites with active subjects have not had a monitoring visit in 90 days?",
        "sql": """SELECT site_key, site_name, n_active, last_monitoring_date, days_since_monitoring,
       open_action_items, open_safety_cases
FROM gold.site_360
WHERE n_active > 0 AND days_since_monitoring > 90
ORDER BY days_since_monitoring DESC""",
    },
    {
        "question": "Do IRT and EDC agree on how many subjects each site has randomized?",
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
        "question": "Which open safety cases are overdue for follow-up?",
        "sql": """SELECT c.case_id, d.site_name, c.subject_key, c.reaction_pt, c.is_serious, c.received_date,
       c.followup_due_date,
       date_diff('day', c.followup_due_date, (SELECT as_of FROM gold.snapshot)) AS days_overdue
FROM gold.fact_safety_case c
JOIN gold.dim_site d USING (site_key)
WHERE c.is_followup_overdue
ORDER BY days_overdue DESC""",
    },
]


def model_available() -> bool:
    """True when the server has a Gemini API key of its own, so anyone's free-form question can be written into SQL."""
    return bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))


NO_KEY = ("Free-form asking is not enabled: add a Gemini API key on your profile page, or set GEMINI_API_KEY in .env. "
          "Filter and Write SQL need no key.")


# ----------------------------------------------------------------------------- the model
class SqlAnswer(BaseModel):
    can_answer: bool = Field(description="False when the question cannot be answered from the tables available to this role.")
    sql: str = Field(description="One DuckDB SELECT statement. Empty string when can_answer is false.")
    explanation: str = Field(description="One or two plain sentences on how the query answers the question, or why it cannot be answered.")


def _schema_prompt(role: str) -> str:
    """Build the system prompt Gemini sees for this role.

    Includes only gold and master tables the role may query, marks masked columns, lists
    withheld tables by name and description without their columns, omits sample values for
    masked columns, and appends every question in EXAMPLES with its SQL.
    """
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
    examples = "\n\n".join(f"Q: {v['question']}\n{v['sql']}" for v in EXAMPLES)
    r = accounts.roles()[role]
    return f"""You write SQL for Concord, a clinical trial data platform that joins five source systems (EDC, CTMS, IRT, the safety database and the finance ERP) on shared master keys. A study team member asks a question in plain English; you return one DuckDB query that answers it.

The person asking holds the role "{r['name']}": {r['blurb']} Their grants are: {', '.join(r['grants']) or 'none'}. The tables below are exactly what this role can query. Access is enforced by the database itself, so a query that touches a withheld table fails and a masked column is always NULL. When a question needs something withheld or masked, do not work around it: set can_answer to false and say in the explanation what is withheld and why. If a site-level aggregate that is available (gold.site_360) answers the question just as well, use that instead.

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


def _call_model(question: str, role: str, retry_note: str | None = None, api_key: str | None = None) -> SqlAnswer:
    """Ask Gemini to write one SELECT for this question, using the role's schema as context.

    Optionally includes a retry note when the previous SQL failed. The reply is validated
    into SqlAnswer. The model is never trusted with access control; its SQL still goes
    through engine.execute. `api_key` is the asking account's own key; with None the client
    takes the server's from the environment.
    """
    from google import genai

    client = genai.Client(api_key=api_key)
    interaction = client.interactions.create(
        model=MODEL,
        system_instruction=_schema_prompt(role),
        input=f"{question}\n\n{retry_note}" if retry_note else question,
        generation_config={"thinking_level": "low"},
        response_format={"type": "text", "mime_type": "application/json", "schema": SqlAnswer.model_json_schema()},
        store=False,  # one question, one answer: nothing to continue, so nothing is kept on the server
    )
    if interaction.status != "completed" or not interaction.output_text:
        return SqlAnswer(can_answer=False, sql="", explanation="The model declined to answer this question.")
    return SqlAnswer.model_validate_json(interaction.output_text)


# ----------------------------------------------------------------------------- entry point
def ask(question: str, role: str, api_key: str | None = None) -> dict:
    """Turn a plain-English question into an engine result for this role.

    Gemini writes the SQL, with one retry on a SQL error. With no key, or when the model cannot be
    reached, nothing is run and the result says why. The result always includes `mode`: `model`
    when the model answered or declined, `none` when it was never reached.

    `api_key` is the asking account's own Gemini key, used in place of the server's. It only
    decides who pays for the model call: what the answer may contain is still the role's.
    """
    question = question.strip()
    api_key = api_key or None
    unanswered = {"question": question, "role": role, "mode": "none", "model": None, "model_error": None}
    if not (api_key or model_available()):
        return {**unanswered, "explanation": NO_KEY}
    try:
        answer = _call_model(question, role, api_key=api_key)
        if answer.can_answer and answer.sql.strip():
            result = engine.execute(answer.sql, role)
            if result["error"] and not result["denied"]:
                answer = _call_model(question, role, f"Your previous query failed with this error, fix it:\n{result['error']}\n\nPrevious query:\n{answer.sql}", api_key)
                result = engine.execute(answer.sql, role) if answer.can_answer and answer.sql.strip() else None
            if result is not None:
                return {**result, "question": question, "mode": "model", "explanation": answer.explanation, "model": MODEL}
        return {"question": question, "role": role, "mode": "model", "model": MODEL, "declined": True, "explanation": answer.explanation}
    except Exception as e:  # network, auth, rate limit
        return {**unanswered, "model_error": f"{type(e).__name__}: {str(e)[:200]}",
                "explanation": "The language model could not be reached, so this question was not answered. Filter and Write SQL need no model."}
