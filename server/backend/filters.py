"""Answer a question that is filled in instead of typed: a site, a subject, a category of data, and limits on its fields.

The third way to get SQL, beside the model (`ask.py`) and the editor. The form is drawn from the catalog,
and the query is written here by rule from what was picked, so the same picks always give the same query
and no language model is involved. Like the other two it ends in `engine.execute()`: what was picked is
checked against the catalog first, but nothing here is the access control.

What a person picks from (the sites, the subjects, the values of a field, the two ends of a range) is read
from the database for the role's own grants, so a table the role may not see offers no fields and a masked
column offers no values.
"""
from __future__ import annotations

import datetime as dt
import math
from functools import lru_cache

from harmonizer import config, policy

from . import engine

# One entry per category of data: a gold table, what a study team calls it, and the order its rows come back in.
CATEGORIES = [
    {"id": "sites", "label": "Site summary", "table": "gold.site_360", "order": "site_key"},
    {"id": "site-details", "label": "Site details", "table": "gold.dim_site", "order": "site_key"},
    {"id": "subjects", "label": "Subjects", "table": "gold.dim_subject", "order": "subject_key"},
    {"id": "visits", "label": "Subject visits", "table": "gold.fact_subject_visit", "order": "subject_key, visit_date, visit_num"},
    {"id": "adverse-events", "label": "Adverse events", "table": "gold.fact_adverse_event", "order": "onset_date DESC, ae_key"},
    {"id": "safety-cases", "label": "Safety cases", "table": "gold.fact_safety_case", "order": "received_date DESC, case_id"},
    {"id": "safety-reconciliation", "label": "Safety reconciliation", "table": "gold.fact_sae_reconciliation", "order": "recon_status, subject_key, recon_key"},
    {"id": "randomizations", "label": "Randomizations", "table": "gold.fact_randomization", "order": "randomization_date DESC, rand_no"},
    {"id": "kits", "label": "Drug kits", "table": "gold.fact_kit", "order": "site_key, kit_id"},
    {"id": "payments", "label": "Site payments", "table": "gold.fact_payment", "order": "invoice_date DESC, doc_no"},
    {"id": "monitoring", "label": "Monitoring visits", "table": "gold.fact_monitoring_visit", "order": "visit_date DESC, visit_id"},
]
SITES, SUBJECTS = "gold.dim_site", "gold.dim_subject"   # where the two lists at the top of the form come from
SITE = "site_key"
SUBJECT = ("subject_key", "dispensed_subject_key")      # the column a table keeps its subject in, as engine.trace() looks for it
MAX_CHOICES = 25      # a text column with more distinct values than this is searched, not picked from
MAX_CONDITIONS = 20
MAX_TEXT = 200
NUMERIC = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "FLOAT", "REAL", "DOUBLE", "DECIMAL")
# client/lib/format.ts repeats SPOKEN and _label (fmtHeader), so an answer's column headings read like the form's fields
SPOKEN = {"ae": "AE", "sae": "SAE", "edc": "EDC", "usd": "USD", "id": "ID", "cra": "CRA", "usubjid": "USUBJID",
          "no": "number", "num": "number", "seq": "sequence", "pt": "term", "doc": "document", "rand": "randomization",
          "recon": "reconciliation", "diff": "difference", "followup": "follow-up", "followups": "follow-ups", "8w": "for 8 weeks"}


class FilterError(Exception):
    """What was picked cannot be turned into a query. The message is written for the person who picked it."""


# ----------------------------------------------------------------------------- the form
def _label(name: str) -> str:
    """A column name as a study team would say it: `is_low_supply` is Low supply, `n_active` is Active (count)."""
    words = name.removeprefix("is_").split("_")
    counted = words[0] == "n" and len(words) > 1
    text = " ".join(SPOKEN.get(w, w) for w in (words[1:] if counted else words))
    return text[0].upper() + text[1:] + (" (count)" if counted else "")


def _kind(col: dict) -> str:
    """How a column is limited: yes or no, a date range, a number range, a pick from its values, or a search in its text."""
    t = col["type"].upper()
    if t == "BOOLEAN":
        return "flag"
    if t == "DATE":
        return "date"
    if t.startswith(NUMERIC):
        return "number"
    return "choice" if col["n_distinct"] <= MAX_CHOICES else "text"


def _subject_column(ds: dict) -> str | None:
    return next((c for c in SUBJECT if c in ds["columns"]), None)


def _fields(ds: dict) -> dict[str, dict]:
    """The columns of a table a limit can be put on: all but the lineage columns and the two keys picked at the top of the form."""
    apart = (SITE, _subject_column(ds))
    return {name: {"name": name, "label": _label(name), "description": col["description"], "kind": _kind(col)}
            for name, col in ds["columns"].items() if not name.startswith("_src_") and name not in apart}


@lru_cache(maxsize=16)
def _picks(build_stamp: float, held: tuple[str, ...]) -> dict:
    """Everything there is to pick from in the database for one set of grants.

    Read from that database and not from the warehouse, so nothing these grants withhold can be offered.
    Kept per build and per set of grants, like the catalog: the lists only change when the data does.
    """
    cat = engine.catalog()
    con = engine.mart_connection(held)
    try:
        sites = [{"site_key": k, "site_name": n} for k, n in con.execute(f"SELECT site_key, site_name FROM {SITES} ORDER BY 1").fetchall()]
        subjects = []
        if not policy.table_denied(cat["datasets"][SUBJECTS], held):
            subjects = [{"subject_key": k, "site_key": s} for k, s in con.execute(f"SELECT subject_key, site_key FROM {SUBJECTS} ORDER BY 1").fetchall()]
        fields = {}
        for c in CATEGORIES:
            ds = cat["datasets"][c["table"]]
            if policy.table_denied(ds, held):
                continue
            fields[c["table"]] = found = {}
            for name, f in _fields(ds).items():
                if f["kind"] == "choice":
                    found[name] = {"values": [r[0] for r in con.execute(f'SELECT DISTINCT "{name}" FROM {c["table"]} WHERE "{name}" IS NOT NULL ORDER BY 1').fetchall()]}
                elif f["kind"] in ("number", "date"):
                    lo, hi = con.execute(f'SELECT min("{name}"), max("{name}") FROM {c["table"]}').fetchone()
                    found[name] = {"min": engine.jsonable(lo), "max": engine.jsonable(hi)}
    finally:
        con.close()
    return {"sites": sites, "subjects": subjects, "fields": fields}


def options(role: str) -> dict:
    """The filter form for this role: the sites, the subjects, and each category with the fields a limit can be put on.

    A category the role may not see is listed with the reason and no fields. A masked field is listed with
    the reason and nothing to pick. Withheld things are named, never left out.
    """
    cat = engine.catalog()
    picks = _picks(config.WAREHOUSE.stat().st_mtime, tuple(sorted(engine.grants(role))))
    subjects = engine.access(cat["datasets"][SUBJECTS], role)
    categories = []
    for c in CATEGORIES:
        ds = cat["datasets"][c["table"]]
        a = engine.access(ds, role)
        fields = [] if a["denied"] else [
            {**f, **picks["fields"][c["table"]].get(name, {}), "masked": engine.reason(a["masked"][name], role) if name in a["masked"] else None}
            for name, f in _fields(ds).items()]
        categories.append({"id": c["id"], "label": c["label"], "table": c["table"], "description": ds["description"],
                           "systems": ds["upstream_systems"], "by_subject": _subject_column(ds) is not None,
                           "denied": engine.reason(a["denied_tags"], role) if a["denied"] else None, "fields": fields})
    return {"sites": picks["sites"], "categories": categories,
            "subjects": {"denied": engine.reason(subjects["denied_tags"], role) if subjects["denied"] else None, "options": picks["subjects"]}}


# ----------------------------------------------------------------------------- from picks to SQL
def _text(value, what: str) -> str | None:
    """A picked or typed value as text, or None when nothing was given."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise FilterError(f"That is not a value {what} can have.")
    return value.strip()


def _lit(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _spoken(label: str) -> str:
    """A label in the middle of a sentence: Onset date becomes onset date, AE key stays as it is."""
    return label if label[:2].isupper() else label[0].lower() + label[1:]


def _bound(value, f: dict, said: str):
    """One end of a range as a number or a date, or None when that end was left open."""
    if value is None or str(value).strip() == "":
        return None
    try:
        if f["kind"] == "date":
            return dt.date.fromisoformat(str(value).strip())
        n = float(str(value).strip())
    except ValueError:
        raise FilterError(f"{value!r} is not a {'date (use YYYY-MM-DD)' if f['kind'] == 'date' else 'number'}, for {said}.") from None
    if not math.isfinite(n):
        raise FilterError(f"{value!r} is not a number, for {said}.")
    return int(n) if n.is_integer() else n


def _condition(f: dict, cond: dict) -> tuple[str, str]:
    """One limit on one field as a SQL condition, and the same thing in words."""
    name, said, kind = f["name"], _spoken(f["label"]), f["kind"]
    if kind == "flag":
        if not isinstance(cond.get("equals"), bool):
            raise FilterError(f"Say yes or no for {said}, or remove it.")
        return (name if cond["equals"] else f"NOT {name}"), f"{said} is {'yes' if cond['equals'] else 'no'}"
    if kind == "choice":
        values = [v for v in (_text(v, said) for v in cond.get("any_of") or []) if v]
        if not values or len(values) > MAX_CHOICES:
            raise FilterError(f"Pick at least one value for {said}, or remove it.")
        return f"{name} IN ({', '.join(_lit(v) for v in values)})", f"{said} is {' or '.join(values)}"
    if kind == "text":
        needle = _text(cond.get("contains"), said)
        if not needle:
            raise FilterError(f"Type what {said} should contain, or remove it.")
        return f"contains(lower({name}), {_lit(needle.lower())})", f"{said} contains “{needle}”"
    lo, hi = _bound(cond.get("min"), f, said), _bound(cond.get("max"), f, said)
    if lo is None and hi is None:
        raise FilterError(f"Give a start or an end for {said}, or remove it.")
    if lo is not None and hi is not None and lo > hi:
        raise FilterError(f"The range for {said} ends before it starts.")
    sql = (lambda v: f"DATE '{v}'") if kind == "date" else str
    words = {"both": "is from {} to {}", "lo": "is on or after {}", "hi": "is on or before {}"} if kind == "date" else \
            {"both": "is between {} and {}", "lo": "is at least {}", "hi": "is at most {}"}
    if lo is not None and hi is not None:
        return f"{name} BETWEEN {sql(lo)} AND {sql(hi)}", f"{said} {words['both'].format(lo, hi)}"
    if lo is not None:
        return f"{name} >= {sql(lo)}", f"{said} {words['lo'].format(lo)}"
    return f"{name} <= {sql(hi)}", f"{said} {words['hi'].format(hi)}"


def build(spec: dict) -> tuple[str, str]:
    """Write the query for what was picked, and say it back as a sentence.

    Depends on the catalog and not on who is asking: the role is applied when the query is run. Raises
    FilterError for a category or a field that does not exist, and for a limit that says nothing.
    """
    category = next((c for c in CATEGORIES if c["id"] == spec.get("category")), None)
    if category is None:
        raise FilterError("Pick a category of data to look at.")
    ds = engine.catalog()["datasets"][category["table"]]
    fields, where, limits, scope = _fields(ds), [], [], ""

    site, subject = _text(spec.get("site_key"), "a site"), _text(spec.get("subject_key"), "a subject")
    if site:
        if SITE not in ds["columns"]:
            raise FilterError(f"{category['label']} cannot be narrowed to one site. Clear the site, or pick another category.")
        where.append(f"{SITE} = {_lit(site)}")
        scope += f" at site {site}"
    if subject:
        column = _subject_column(ds)
        if column is None:
            raise FilterError(f"{category['label']} cannot be narrowed to one subject. Clear the subject, or pick another category.")
        where.append(f"{column} = {_lit(subject)}")
        scope += f" for subject {subject}"

    conditions = spec.get("conditions") or []
    if len(conditions) > MAX_CONDITIONS:
        raise FilterError(f"That is more than {MAX_CONDITIONS} filters. Remove some.")
    for cond in conditions:
        f = fields.get(cond.get("field"))
        if f is None:
            raise FilterError(f"There is no field called {cond.get('field') or '(nothing)'} to filter {_spoken(category['label'])} on.")
        clause, words = _condition(f, cond)
        where.append(clause)
        limits.append(words)

    columns = [name for name in ds["columns"] if not name.startswith("_src_")]
    sql = f"SELECT {', '.join(columns)}\nFROM {category['table']}"
    if where:
        sql += "\nWHERE " + "\n  AND ".join(where)
    return f"{sql}\nORDER BY {category['order']}", category["label"] + scope + (" where " + " and ".join(limits) if limits else "")


def run(spec: dict, role: str) -> dict:
    """Run what was picked for this role. Never raises for bad input: like `engine.execute()`, problems come back in `error`."""
    try:
        sql, sentence = build(spec)
    except FilterError as e:
        return {"role": role, "mode": "filter", "question": None, "explanation": None, "model": None, "error": str(e)}
    return {**engine.execute(sql, role), "mode": "filter", "question": sentence, "explanation": None, "model": None}
