"""Run a question's SQL for a role, and explain the answer: what was withheld, where the numbers
came from, how fresh the sources are, and which source rows stand behind any key in the result.

Nothing here trusts the SQL. It may come from a person or from a language model; either way it
is parsed, checked against the role's policy, and then executed inside that role's own
read-only database with file and network access switched off.
"""
from __future__ import annotations

import datetime as dt
import decimal
import difflib
import json
import threading
import time
from functools import lru_cache

import duckdb
import sqlglot
from sqlglot import exp

from . import config, policy

ROW_LIMIT = 500
TIMEOUT_SECONDS = 15
SANDBOX = {"enable_external_access": False, "lock_configuration": True}


# ----------------------------------------------------------------------------- catalog access
def warehouse():
    return duckdb.connect(str(config.WAREHOUSE), read_only=True)


def role_connection(role: str):
    return duckdb.connect(str(config.role_db(role)), read_only=True, config=SANDBOX)


@lru_cache(maxsize=4)
def _catalog(build_stamp: float) -> dict:
    con = warehouse()
    datasets = {}
    for row in con.execute("SELECT * FROM meta.datasets").fetchall():
        d = dict(zip([c[0] for c in con.description], row))
        d["tags"] = json.loads(d["tags"])
        d["upstream_systems"] = json.loads(d["upstream_systems"])
        d["columns"] = {}
        datasets[d["fqn"]] = d
    for row in con.execute("SELECT * FROM meta.columns ORDER BY fqn, position").fetchall():
        c = dict(zip([c[0] for c in con.description], row))
        c["tags"] = json.loads(c["tags"])
        c["samples"] = json.loads(c["samples"])
        datasets[c.pop("fqn")]["columns"][c["name"]] = c
    edges = con.execute("SELECT src, dst FROM meta.lineage").fetchall()
    feeds = {}
    for row in con.execute("SELECT * FROM meta.feeds ORDER BY system").fetchall():
        f = dict(zip([c[0] for c in con.description], row))
        f["files"] = json.loads(f["files"])
        f["extracted_at"] = f["extracted_at"].isoformat()
        feeds[f["system"]] = f
    rules = [dict(zip([c[0] for c in con.description], r)) for r in con.execute("SELECT * FROM dq.rules").fetchall()]
    con.close()
    upstream: dict[str, set] = {}
    for src, dst in edges:
        upstream.setdefault(dst, set()).add(src)
    return {"datasets": datasets, "edges": edges, "feeds": feeds, "rules": rules, "upstream": upstream,
            "by_file": {d["source_file"]: fqn for fqn, d in datasets.items() if d["source_file"]}}


def catalog() -> dict:
    """The catalog as built by the pipeline; reloaded automatically after a rebuild."""
    return _catalog(config.WAREHOUSE.stat().st_mtime)


def jsonable(v):
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", "replace")
    return v


def access(dataset: dict, role: str) -> dict:
    denied = policy.table_denied(dataset, role)
    return {"denied": bool(denied), "denied_tags": denied,
            "masked": {} if denied else policy.masked_columns(dataset, role)}


# ----------------------------------------------------------------------------- policy pre-flight
class QueryRejected(Exception):
    pass


def preflight(sql: str, role: str) -> dict:
    """Parse the SQL and decide, from catalog tags alone, what this role may not see in it."""
    cat = catalog()
    try:
        statements = [s for s in sqlglot.parse(sql, dialect="duckdb") if s is not None]
    except sqlglot.errors.ParseError as e:
        raise QueryRejected(f"Could not parse the SQL: {str(e).splitlines()[0]}") from e
    if not statements:
        raise QueryRejected("There is no query to run. Write one SELECT statement.")
    if len(statements) != 1:
        raise QueryRejected("Exactly one statement is allowed.")
    tree = statements[0]
    if not isinstance(tree, exp.Query):
        raise QueryRejected("Only SELECT queries are allowed.")
    forbidden = (exp.Insert, exp.Update, exp.Delete, exp.Create, exp.Drop, exp.Alter, exp.Command, exp.Copy, exp.Attach)
    if any(tree.find(kind) for kind in forbidden):
        raise QueryRejected("Only SELECT queries are allowed.")

    cte_names = {c.alias for c in tree.find_all(exp.CTE)}
    tables, alias_of, decisions = [], {}, []
    for t in tree.find_all(exp.Table):
        if not t.db and t.name in cte_names:
            continue
        if not t.name:
            raise QueryRejected("Table functions are not allowed; query the cataloged tables.")
        if not t.db:
            t.set("db", exp.to_identifier("gold"))
        fqn = f"{t.db}.{t.name}".lower()
        if fqn not in cat["datasets"]:
            near = difflib.get_close_matches(fqn, cat["datasets"], n=3, cutoff=0.5)
            raise QueryRejected(f"There is no table {fqn} in the catalog." + (f" Did you mean {', '.join(near)}?" if near else ""))
        alias_of[t.alias_or_name.lower()] = fqn
        if fqn not in tables:
            tables.append(fqn)

    masked_by_table = {}
    for fqn in tables:
        a = access(cat["datasets"][fqn], role)
        if a["denied"]:
            decisions.append({"action": "deny", "object": fqn, "tags": a["denied_tags"],
                              "reason": policy.reason(a["denied_tags"], role)})
        else:
            masked_by_table[fqn] = a["masked"]

    hit = set()
    stars = list(tree.find_all(exp.Star))
    for col in tree.find_all(exp.Column):
        name = col.name.lower()
        scope = [alias_of[col.table.lower()]] if col.table and col.table.lower() in alias_of else list(masked_by_table)
        for fqn in scope:
            if name in masked_by_table.get(fqn, {}) or (isinstance(col.this, exp.Star) and masked_by_table.get(fqn)):
                for m in ([name] if name in masked_by_table[fqn] else masked_by_table[fqn]):
                    hit.add((fqn, m))
    if stars:
        for fqn, masked in masked_by_table.items():
            hit.update((fqn, m) for m in masked)
    for fqn, name in sorted(hit):
        tags = masked_by_table[fqn][name]
        decisions.append({"action": "mask", "object": f"{fqn}.{name}", "column": name, "tags": tags,
                          "reason": policy.reason(tags, role)})

    return {"sql": tree.sql(dialect="duckdb", pretty=True), "tables": tables, "decisions": decisions,
            "denied": any(d["action"] == "deny" for d in decisions)}


# ----------------------------------------------------------------------------- execution
def execute(sql: str, role: str) -> dict:
    """Pre-flight, then run inside the role's sandboxed database. Always returns a result dict."""
    started = time.time()
    out = {"role": role, "sql": sql, "columns": [], "rows": [], "row_count": 0, "truncated": False,
           "decisions": [], "tables": [], "denied": False, "error": None, "masked_columns": []}
    try:
        pre = preflight(sql, role)
    except QueryRejected as e:
        out["error"] = str(e)
        return out
    out.update(sql=pre["sql"], tables=pre["tables"], decisions=pre["decisions"], denied=pre["denied"])
    out["context"] = answer_context(pre["tables"])
    if pre["denied"]:
        return out

    con = role_connection(role)
    timer = threading.Timer(TIMEOUT_SECONDS, con.interrupt)
    timer.start()
    try:
        cur = con.execute(f"SELECT * FROM (\n{pre['sql']}\n) AS answer LIMIT {ROW_LIMIT + 1}")
        out["columns"] = [{"name": c[0], "type": str(c[1])} for c in cur.description]
        rows = cur.fetchall()
    except duckdb.InterruptException:
        out["error"] = f"The query ran for more than {TIMEOUT_SECONDS} seconds and was stopped. Narrow it down and try again."
        return out
    except duckdb.Error as e:
        out["error"] = str(e).split("\n\n")[0]
        return out
    finally:
        timer.cancel()
        con.close()
    out["truncated"] = len(rows) > ROW_LIMIT
    out["rows"] = [[jsonable(v) for v in r] for r in rows[:ROW_LIMIT]]
    out["row_count"] = len(out["rows"])
    masked_names = {d["column"] for d in pre["decisions"] if d["action"] == "mask"}
    out["masked_columns"] = [c["name"] for c in out["columns"] if c["name"].lower() in masked_names]
    out["traceable"] = [c["name"] for c in out["columns"] if c["name"].lower() in TRACEABLE]
    out["elapsed_ms"] = round((time.time() - started) * 1000)
    return out


# ----------------------------------------------------------------------------- lineage + trust
def upstream_graph(targets: list[str]) -> dict:
    """Every dataset and feed file the targets were built from, as nodes and edges."""
    cat = catalog()
    seen, order = set(), list(targets)
    while order:
        node = order.pop()
        if node in seen:
            continue
        seen.add(node)
        order.extend(cat["upstream"].get(node, ()))
    nodes = []
    for n in sorted(seen):
        ds = cat["datasets"].get(n)
        if ds:
            nodes.append({"id": n, "layer": ds["layer"], "label": ds["name"], "rows": ds["row_count"], "tags": ds["tags"]})
        else:
            system = n.split("/")[1]
            nodes.append({"id": n, "layer": "source", "label": n.split("/", 1)[1], "system": system,
                          "stale": cat["feeds"][system]["is_stale"]})
    return {"nodes": nodes, "edges": [[s, d] for s, d in cat["edges"] if s in seen and d in seen], "targets": targets}


def _days(hours: float) -> str:
    n = round(hours / 24)
    return f"{n} day{'' if n == 1 else 's'}"


def answer_context(tables: list[str]) -> dict:
    """What a reader needs in order to trust an answer built from these tables."""
    cat = catalog()
    graph = upstream_graph(tables)
    upstream_ids, todo = set(), list(tables)
    while todo:  # the data path: like the graph, but not through the id crosswalks
        node = todo.pop()
        if node not in upstream_ids:
            upstream_ids.add(node)
            todo.extend(p for p in cat["upstream"].get(node, ()) if p not in config.ID_MAPS)
    systems = sorted({s for t in tables for s in cat["datasets"][t]["upstream_systems"]})
    feeds = [{k: cat["feeds"][s][k] for k in ("system", "system_name", "extracted_at", "age_hours", "is_stale", "freshness_sla_hours")}
             for s in systems]
    warnings = []
    for f in feeds:
        if f["is_stale"]:
            warnings.append({"kind": "stale", "text": f"The {f['system']} feed is {f['age_hours'] / 24:.0f} days old "
                             f"(SLA {_days(f['freshness_sla_hours'])}). Anything recorded there since "
                             f"{f['extracted_at'][:10]} is not in this answer."})
    issues = [r for r in cat["rules"] if r["n_failed"] and r["dataset"] in upstream_ids and r["severity"] != "info"]
    if issues:
        n = sum(r["n_failed"] for r in issues)
        warnings.append({"kind": "quality", "text": f"{n} open data-quality finding{'s' if n != 1 else ''} on the data behind this answer.",
                         "rules": [{"rule_id": r["rule_id"], "title": r["title"], "n_failed": r["n_failed"], "severity": r["severity"]}
                                   for r in sorted(issues, key=lambda r: -r["n_failed"])]})
    return {"graph": graph, "feeds": feeds, "warnings": warnings}


# ----------------------------------------------------------------------------- trace to source rows
TRACEABLE = {
    "site_key": ("entity", "site_key"),
    "subject_key": ("entity", "subject_key"),
    "dispensed_subject_key": ("entity", "subject_key"),
    "case_id": ("record", "gold.fact_safety_case", "case_id"),
    "doc_no": ("record", "gold.fact_payment", "doc_no"),
    "kit_id": ("record", "gold.fact_kit", "kit_id"),
    "visit_id": ("record", "gold.fact_monitoring_visit", "visit_id"),
    "ae_key": ("record", "gold.fact_adverse_event", "ae_key"),
    "edc_ae_key": ("record", "gold.fact_adverse_event", "ae_key"),
    "rand_no": ("record", "gold.fact_randomization", "rand_no"),
}
XWALK = {"site_key": "master.site_xwalk", "subject_key": "master.subject_xwalk"}


def _source_rows(con, cat: dict, role: str, gold: str, key_col: str, value: str, limit: int = 12) -> dict:
    """Follow one gold table's lineage columns back to the raw rows in bronze."""
    ds = cat["datasets"][gold]
    a = access(ds, role)
    block = {"dataset": gold, "description": ds["description"]}
    if a["denied"]:
        return {**block, "denied": policy.reason(a["denied_tags"], role)}
    if key_col in a["masked"]:
        return {**block, "denied": f"{key_col} is {policy.reason(a['masked'][key_col], role)}"}
    refs = con.execute(f'SELECT _src_file, _src_row FROM {gold} WHERE "{key_col}" = ? ORDER BY _src_row', [value]).fetchall()
    if not refs:
        return {**block, "total": 0}
    src_file = refs[0][0]
    bronze = cat["by_file"][src_file]
    b = access(cat["datasets"][bronze], role)
    block.update(total=len(refs), file=src_file, bronze=bronze, system=src_file.split("/")[1])
    if b["denied"]:
        return {**block, "denied": policy.reason(b["denied_tags"], role)}
    wanted = [r[1] for r in refs[:limit]]
    cur = con.execute(f"SELECT * EXCLUDE (_src_system, _src_file) FROM {bronze} WHERE _src_row IN ({', '.join('?' * len(wanted))}) ORDER BY _src_row", wanted)
    cols = [c[0] for c in cur.description]
    block.update(columns=cols, rows=[[jsonable(v) for v in r] for r in cur.fetchall()], masked=sorted(b["masked"]))
    return block


def trace(role: str, column: str, value: str) -> dict:
    """Everything behind one key in an answer: how its ids were matched, and the source rows."""
    cat = catalog()
    spec = TRACEABLE.get(column.lower())
    if spec is None:
        return {"error": f"{column} is not a traceable key."}
    con = role_connection(role)
    try:
        if spec[0] == "record":
            _, gold, key_col = spec
            return {"kind": "record", "column": column, "value": value, "crosswalk": None,
                    "sources": [_source_rows(con, cat, role, gold, key_col, value)]}
        key_col = spec[1]
        xwalk = XWALK[key_col]
        xa = access(cat["datasets"][xwalk], role)
        if xa["denied"]:
            crosswalk = {"denied": policy.reason(xa["denied_tags"], role)}
        else:
            cur = con.execute(f"SELECT * FROM {xwalk} WHERE {key_col} = ? ORDER BY system, native_id", [value])
            cols = [c[0] for c in cur.description]
            crosswalk = {"dataset": xwalk, "rows": [dict(zip(cols, [jsonable(v) for v in r])) for r in cur.fetchall()]}
        sources = []
        for fqn, ds in cat["datasets"].items():
            if ds["layer"] != "gold" or "_src_row" not in ds["columns"]:
                continue
            for candidate in ([key_col] if key_col == "site_key" else ["subject_key", "dispensed_subject_key"]):
                if candidate in ds["columns"]:
                    block = _source_rows(con, cat, role, fqn, candidate, value)
                    if block.get("total") != 0:
                        sources.append(block)
        sources.sort(key=lambda s: (s.get("system") or "~", s["dataset"]))
        return {"kind": "entity", "column": key_col, "value": value, "crosswalk": crosswalk, "sources": sources}
    finally:
        con.close()
