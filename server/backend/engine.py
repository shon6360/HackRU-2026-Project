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

from harmonizer import config, policy

from . import accounts

ROW_LIMIT = 500
TIMEOUT_SECONDS = 15
SANDBOX = {"enable_external_access": False, "lock_configuration": True}


# ----------------------------------------------------------------------------- catalog access
def warehouse():
    """Open a read-only connection to the full warehouse.

    This is the unfiltered database. Anything read through it and returned to a client must be
    filtered by policy by hand; user SQL never runs here.
    """
    return duckdb.connect(str(config.WAREHOUSE), read_only=True)


def grants(role: str) -> list[str]:
    """The grants a role holds right now. Roles are edited while the server runs, so this is asked every time, never kept."""
    return accounts.roles()[role]["grants"]


def mart_connection(held):
    """Open a read-only, sandboxed connection to the database built for one set of grants.

    Tables those grants do not cover are physically absent and masked columns are physically NULL.
    External file and network access are switched off.
    """
    return duckdb.connect(str(config.mart_db(held)), read_only=True, config=SANDBOX)


def role_connection(role: str):
    """Open the database that holds exactly what this role's grants may see."""
    return mart_connection(grants(role))


@lru_cache(maxsize=4)
def _catalog(build_stamp: float) -> dict:
    """Load datasets, columns, lineage, feeds and quality rules from the warehouse.

    `build_stamp` is the warehouse file's mtime so a rebuild invalidates the cache. Callers
    should use `catalog()` rather than this function.
    """
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
    """Return the catalog as built by the pipeline.

    Reloads automatically after a rebuild because the cache key is the warehouse file's mtime.
    """
    return _catalog(config.WAREHOUSE.stat().st_mtime)


def jsonable(v):
    """Turn a DuckDB cell into a JSON-serializable value.

    Dates become ISO strings, decimals become floats, and bytes become UTF-8 text.
    """
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", "replace")
    return v


def access(dataset: dict, role: str) -> dict:
    """Say what this role may see of one catalog dataset.

    Returns whether the table is withheld, which tags caused that, and which columns are
    masked (empty when the whole table is denied).
    """
    held = grants(role)
    denied = policy.table_denied(dataset, held)
    return {"denied": bool(denied), "denied_tags": denied,
            "masked": {} if denied else policy.masked_columns(dataset, held)}


def reason(tags: list[str], role: str) -> str:
    """Why something carrying these tags is withheld from this role, in words for the person asking."""
    return policy.reason(tags, accounts.roles()[role]["name"])


# ----------------------------------------------------------------------------- policy pre-flight
class QueryRejected(Exception):
    pass


def preflight(sql: str, role: str) -> dict:
    """Parse the SQL and decide, from catalog tags alone, what this role may not see in it.

    Accepts exactly one SELECT-like statement against cataloged tables. Records a deny
    decision per withheld table and a mask decision per withheld column the query touches.
    Raises QueryRejected for anything that is not a single safe SELECT.
    """
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
                              "reason": reason(a["denied_tags"], role)})
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
                          "reason": reason(tags, role)})

    return {"sql": tree.sql(dialect="duckdb", pretty=True), "tables": tables, "decisions": decisions,
            "denied": any(d["action"] == "deny" for d in decisions)}


# ----------------------------------------------------------------------------- execution
def execute(sql: str, role: str) -> dict:
    """Pre-flight a query, then run it inside the role's sandboxed database.

    Never raises for bad input. Always returns the same result dict, with problems in `error`
    and policy outcomes in `decisions` and `denied`. If anything is denied, nothing is executed.
    Results are capped at ROW_LIMIT rows; a 15-second interrupt stops a runaway query.
    """
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
    """Walk lineage from the given tables back to every dataset and feed file they were built from.

    Returns nodes (catalog tables plus source files) and the edges between them, including the
    id crosswalks so the graph is complete even when the data path skips those tables.
    """
    cat = catalog()
    seen, order = set(), list(targets)
    while order:
        node = order.pop()
        if node in seen:
            continue
        seen.add(node)
        order.extend(cat["upstream"].get(node, ()))
    return _graph(seen, targets)


def _graph(ids: set[str], targets: list[str]) -> dict:
    """Describe a set of catalog tables and source files as graph nodes, with the lineage edges among them."""
    cat = catalog()
    nodes = []
    for n in sorted(ids):
        ds = cat["datasets"].get(n)
        if ds:
            nodes.append({"id": n, "layer": ds["layer"], "label": ds["name"], "rows": ds["row_count"], "tags": ds["tags"]})
        else:
            system = n.split("/")[1]
            nodes.append({"id": n, "layer": "source", "label": n.split("/", 1)[1], "system": system,
                          "stale": cat["feeds"][system]["is_stale"]})
    return {"nodes": nodes, "edges": [[s, d] for s, d in cat["edges"] if s in ids and d in ids], "targets": targets}


def data_path(tables: list[str]) -> set[str]:
    """Everything the rows of these tables are built from: like the graph, but not through the id crosswalks.

    The crosswalks read every system to map ids, so following them would make every table
    appear to come from every feed.
    """
    cat = catalog()
    seen, todo = set(), list(tables)
    while todo:
        node = todo.pop()
        if node not in seen:
            seen.add(node)
            todo.extend(p for p in cat["upstream"].get(node, ()) if p not in config.ID_MAPS)
    return seen


def _days(hours: float) -> str:
    """Format a duration in hours as a whole number of days for a warning sentence."""
    n = round(hours / 24)
    return f"{n} day{'' if n == 1 else 's'}"


def answer_context(tables: list[str]) -> dict:
    """Collect what a reader needs in order to trust an answer built from these tables.

    Returns the upstream lineage graph, the feeds those tables depend on, a stale warning per
    feed past its SLA, and a quality warning listing failing rules on upstream datasets.
    Info-severity rules do not raise warnings. The data path skips the id crosswalks so one
    answer does not appear to depend on every feed.
    """
    cat = catalog()
    graph = upstream_graph(tables)
    upstream_ids = data_path(tables)
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
    """Follow one gold table's lineage columns back to the raw rows in bronze.

    Looks up `_src_file` and `_src_row` for the matching key, then loads those bronze rows.
    Returns a denied reason instead of rows when the gold table, the key, or the bronze file
    is withheld from this role.
    """
    ds = cat["datasets"][gold]
    a = access(ds, role)
    block = {"dataset": gold, "description": ds["description"]}
    if a["denied"]:
        return {**block, "denied": reason(a["denied_tags"], role)}
    if key_col in a["masked"]:
        return {**block, "denied": f"{key_col} is {reason(a['masked'][key_col], role)}"}
    refs = con.execute(f'SELECT _src_file, _src_row FROM {gold} WHERE "{key_col}" = ? ORDER BY _src_row', [value]).fetchall()
    if not refs:
        return {**block, "total": 0}
    src_file = refs[0][0]
    bronze = cat["by_file"][src_file]
    b = access(cat["datasets"][bronze], role)
    block.update(total=len(refs), file=src_file, bronze=bronze, system=src_file.split("/")[1])
    if b["denied"]:
        return {**block, "denied": reason(b["denied_tags"], role)}
    wanted = [r[1] for r in refs[:limit]]
    cur = con.execute(f"SELECT * EXCLUDE (_src_system, _src_file) FROM {bronze} WHERE _src_row IN ({', '.join('?' * len(wanted))}) ORDER BY _src_row", wanted)
    cols = [c[0] for c in cur.description]
    block.update(columns=cols, rows=[[jsonable(v) for v in r] for r in cur.fetchall()], masked=sorted(b["masked"]))
    return block


def _crosswalk(con, cat: dict, role: str, key_col: str, value: str) -> dict:
    """How each system's id was matched to one master key, or why this role may not see that."""
    xwalk = XWALK[key_col]
    xa = access(cat["datasets"][xwalk], role)
    if xa["denied"]:
        return {"denied": reason(xa["denied_tags"], role)}
    cur = con.execute(f"SELECT * FROM {xwalk} WHERE {key_col} = ? ORDER BY system, native_id", [value])
    cols = [c[0] for c in cur.description]
    return {"dataset": xwalk, "rows": [dict(zip(cols, [jsonable(v) for v in r])) for r in cur.fetchall()]}


def trace(role: str, column: str, value: str) -> dict:
    """Return everything behind one key in an answer: how its ids were matched, and the source rows.

    Entity keys (`site_key`, `subject_key`) show the crosswalk plus source rows from every gold
    table that has the key. Record keys (`case_id`, `doc_no`, and so on) show the one gold
    table's source rows. Runs in the role's database and reports withheld blocks instead of
    hiding them. Returns an error if the column is not in TRACEABLE.
    """
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
        crosswalk = _crosswalk(con, cat, role, key_col, value)
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


# ----------------------------------------------------------------------------- one site's lineage
SITES = "gold.dim_site"


def site_list(role: str) -> dict:
    """The sites this role can look up by name, read from its own database.

    Returns the reason instead of the list when the role may not see site names.
    """
    a = access(catalog()["datasets"][SITES], role)
    hidden = a["denied_tags"] or a["masked"].get("site_key") or a["masked"].get("site_name")
    if hidden:
        return {"sites": [], "denied": reason(hidden, role)}
    con = role_connection(role)
    try:
        cur = con.execute(f"SELECT site_key, site_name, city, state FROM {SITES} ORDER BY site_name, site_key")
        cols = [c[0] for c in cur.description]
        return {"sites": [dict(zip(cols, r)) for r in cur.fetchall()], "denied": None}
    finally:
        con.close()


def _chain(start: str, end: str) -> list[str]:
    """The longest run of lineage edges from one node down to another on the data path, both ends included."""
    cat, runs = catalog(), {}

    def longest(node: str) -> list[str] | None:
        if node not in runs:
            above = [r for p in sorted(cat["upstream"].get(node, ())) if p not in config.ID_MAPS and (r := longest(p))]
            runs[node] = [node] if node == start else max(above, key=len) + [node] if above else None
        return runs[node]

    return longest(end) or [start, end]  # a row can name a file its table reaches only through a crosswalk


def site_lineage(role: str, site_key: str) -> dict:
    """Every source file one site's data came from, and where each file's rows went.

    A file is listed when rows of a gold table that belong to the site name it in `_src_file`, with
    how many of its rows are this site's and, for each such table, the chain of tables between the
    two and the summary tables that count those rows again. A file that holds only the site's id
    in its system, such as a vendor list, is listed with the chain to the crosswalk that matched
    it and no row count. The graph is all of those chains together, and its row counts are this
    site's rows, not the tables'. Runs in the role's database: the files behind a withheld table
    are not listed, and the table is reported as withheld.
    """
    cat = catalog()
    listed = site_list(role)
    if listed["denied"]:
        return {"error": f"Site names are {listed['denied']}."}
    site = next((s for s in listed["sites"] if s["site_key"] == site_key), None)
    if site is None:
        return {"error": "There is no site with that key."}
    con = role_connection(role)
    try:
        withheld, reached, file_rows, site_rows, summaries = [], {}, {}, {}, set()
        for fqn, ds in cat["datasets"].items():
            if ds["layer"] != "gold" or "site_key" not in ds["columns"]:
                continue
            a = access(ds, role)
            hidden = a["denied_tags"] or a["masked"].get("site_key")
            if hidden:
                withheld.append({"dataset": fqn, "denied": reason(hidden, role)})
            elif "_src_row" not in ds["columns"]:  # a summary: it has rows for the site, but they point at no source row
                n = con.execute(f"SELECT count(*) FROM {fqn} WHERE site_key = ?", [site_key]).fetchone()[0]
                if n:
                    site_rows[fqn] = n
                    summaries.add(fqn)
            else:
                refs = con.execute(f"SELECT _src_file, _src_row FROM {fqn} WHERE site_key = ?", [site_key]).fetchall()
                if refs:
                    site_rows[fqn] = len(refs)
                for f in sorted({f for f, _ in refs}):
                    reached.setdefault(f, []).append({"dataset": fqn, "rows": sum(1 for g, _ in refs if g == f)})
                    file_rows.setdefault(f, set()).update(row for g, row in refs if g == f)
        crosswalk = _crosswalk(con, cat, role, "site_key", site_key)
    finally:
        con.close()

    ids: dict[str, list] = {}
    for x in crosswalk.get("rows", []):
        ids.setdefault(x["system"], []).append(x["native_id"])
    xwalk = XWALK["site_key"]
    if ids:  # the files that were read only to work out which of a system's ids is this site
        site_rows[xwalk] = sum(len(v) for v in ids.values())
        for node in sorted(data_path([xwalk])):
            if node not in cat["datasets"] and node.split("/")[1] in ids and node not in reached:
                reached[node] = [{"dataset": xwalk, "rows": len(ids[node.split("/")[1]])}]

    below: dict[str, set] = {}
    for src, dst in cat["edges"]:
        below.setdefault(src, set()).add(dst)

    def downstream(node: str, seen: set) -> set:
        for nxt in below.get(node, ()):
            if nxt not in seen:
                seen.add(nxt)
                downstream(nxt, seen)
        return seen

    files, on_path = [], set(summaries) | ({xwalk} if ids else set())
    for f in sorted(reached):
        system = f.split("/")[1]
        for t in reached[f]:
            t["path"] = _chain(f, t["dataset"])
            t["also"] = sorted(downstream(t["dataset"], set()) & summaries) if f in file_rows else []
            on_path |= {node for node in data_path([t["dataset"]]) if f in data_path([node])}
        # one source row can reach more than one gold table: count it once
        n = len(file_rows[f]) if f in file_rows else None
        files.append({"file": f, "system": system, "stale": cat["feeds"][system]["is_stale"], "bronze": cat["by_file"][f],
                      "rows": n, "ids": ids.get(system, []), "tables": reached[f]})
        if n is not None:
            site_rows[f] = site_rows[cat["by_file"][f]] = n
    graph = _graph(on_path, sorted(t for t in site_rows if t in cat["datasets"] and cat["datasets"][t]["layer"] == "gold"))
    for node in graph["nodes"]:
        node.pop("rows", None)  # the whole table's count would be read as this site's
        if node["id"] in site_rows:
            node["rows"] = site_rows[node["id"]]
    return {"site": site, "crosswalk": crosswalk, "files": files, "withheld": withheld, "graph": graph}
