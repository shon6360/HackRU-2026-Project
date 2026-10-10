"""The web app: a small JSON API over the engine, plus the static front end."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ask as asker
from . import config, engine, policy, quality

app = FastAPI(title="Concord", docs_url="/api/docs", redoc_url=None)


def _role(role: str) -> str:
    if role not in policy.ROLES:
        raise HTTPException(400, f"Unknown role {role!r}")
    return role


class AskBody(BaseModel):
    question: str
    role: str


class SqlBody(BaseModel):
    sql: str
    role: str


# ----------------------------------------------------------------------------- meta
@app.get("/api/meta")
def meta():
    cat = engine.catalog()
    layers = {}
    for ds in cat["datasets"].values():
        layers[ds["layer"]] = layers.get(ds["layer"], 0) + 1
    return {
        "as_of": str(config.snapshot_date()),
        "roles": policy.ROLES,
        "tags": policy.TAGS,
        "feeds": list(cat["feeds"].values()),
        "layers": layers,
        "model": {"available": asker.model_available(), "id": asker.MODEL},
        "questions": [{"id": v["id"], "question": v["question"], "systems": v["systems"]} for v in asker.VETTED],
    }


# ----------------------------------------------------------------------------- ask
@app.post("/api/ask")
def ask(body: AskBody):
    return asker.ask(body.question, _role(body.role))


@app.post("/api/sql")
def sql(body: SqlBody):
    result = engine.execute(body.sql, _role(body.role))
    return {**result, "mode": "sql", "question": None, "explanation": None, "model": None}


@app.get("/api/trace")
def trace(role: str, column: str, value: str):
    return engine.trace(_role(role), column, value)


# ----------------------------------------------------------------------------- catalog
def _fair(ds: dict, cat: dict) -> list[dict]:
    cols = [c for n, c in ds["columns"].items()]
    described = sum(1 for c in cols if c["description"]) / max(1, len(cols))
    names = set(ds["columns"])
    stale = [s for s in ds["upstream_systems"] if cat["feeds"][s]["is_stale"]]
    return [
        {"letter": "F", "check": "Has a stable identifier and is indexed in the catalog", "ok": True},
        {"letter": "F", "check": "Table and at least 90% of its columns are described", "ok": bool(ds["description"]) and described >= 0.9},
        {"letter": "A", "check": "Has a named owner and steward", "ok": bool(ds["owner"] and ds["steward"])},
        {"letter": "A", "check": "Metadata stays readable where the data is withheld", "ok": True},
        {"letter": "I", "check": "Keyed on master keys or follows a published standard",
         "ok": bool(ds["standard"]) or bool(names & {"site_key", "subject_key", "study_key"})},
        {"letter": "I", "check": "Typed values and ISO dates rather than raw strings", "ok": ds["layer"] != "bronze"},
        {"letter": "R", "check": "Lineage to source and row-level provenance are recorded",
         "ok": bool(cat["upstream"].get(ds["fqn"])) and ("_src_row" in names or ds["layer"] == "gold")},
        {"letter": "R", "check": "Freshness is known and every upstream feed is within its SLA", "ok": not stale},
    ]


def _summary(ds: dict, role: str, cat: dict) -> dict:
    fair = _fair(ds, cat)
    a = engine.access(ds, role)
    return {
        "fqn": ds["fqn"], "schema": ds["schema"], "name": ds["name"], "layer": ds["layer"], "description": ds["description"],
        "owner": ds["owner"], "steward": ds["steward"], "source_system": ds["source_system"], "grain": ds["grain"],
        "standard": ds["standard"], "tags": ds["tags"], "row_count": ds["row_count"], "n_columns": len(ds["columns"]),
        "upstream_systems": ds["upstream_systems"],
        "stale_systems": [s for s in ds["upstream_systems"] if cat["feeds"][s]["is_stale"]],
        "column_names": list(ds["columns"]),
        "column_text": " ".join(f"{n} {c['description']}" for n, c in ds["columns"].items()),
        "access": {"denied": a["denied"], "denied_tags": a["denied_tags"], "n_masked": len(a["masked"])},
        "fair": {"passed": sum(f["ok"] for f in fair), "total": len(fair)},
    }


@app.get("/api/catalog")
def catalog_list(role: str):
    role = _role(role)
    cat = engine.catalog()
    return {"datasets": [_summary(ds, role, cat) for ds in cat["datasets"].values()]}


@app.get("/api/dataset/{fqn}")
def dataset(fqn: str, role: str):
    role = _role(role)
    cat = engine.catalog()
    ds = cat["datasets"].get(fqn)
    if ds is None:
        raise HTTPException(404, f"No dataset {fqn}")
    a = engine.access(ds, role)
    columns = []
    for name, c in ds["columns"].items():
        hidden = a["denied"] or name in a["masked"]
        columns.append({**c, "masked": name in a["masked"],
                        "samples": [] if hidden else c["samples"],
                        "min": None if hidden else c["min"], "max": None if hidden else c["max"]})
    preview = None
    if not a["denied"]:
        con = engine.role_connection(role)
        cur = con.execute(f"SELECT * FROM {fqn} LIMIT 8")
        preview = {"columns": [c[0] for c in cur.description], "rows": [[engine.jsonable(v) for v in r] for r in cur.fetchall()]}
        con.close()
    downstream = sorted(d for s, d in cat["edges"] if s == fqn)
    rules = [r for r in cat["rules"] if r["dataset"] == fqn]
    return {
        **_summary(ds, role, cat), "sql": ds["sql"], "source_file": ds["source_file"], "columns": columns, "preview": preview,
        "access": {"denied": a["denied"], "denied_tags": a["denied_tags"], "masked": a["masked"],
                   "reason": policy.reason(a["denied_tags"], role) if a["denied"] else None},
        "fair_checks": _fair(ds, cat), "upstream": sorted(cat["upstream"].get(fqn, [])), "downstream": downstream,
        "graph": engine.upstream_graph([fqn]), "rules": rules,
        "feeds": [cat["feeds"][s] for s in ds["upstream_systems"]],
    }


@app.get("/api/lineage")
def lineage():
    cat = engine.catalog()
    return engine.upstream_graph([fqn for fqn in cat["datasets"]])


# ----------------------------------------------------------------------------- crosswalk
@app.get("/api/crosswalk")
def crosswalk(role: str):
    role = _role(role)
    con = engine.warehouse()
    cur = con.execute("""SELECT x.*, s.site_name, s.city, s.state, s.principal_investigator
                         FROM master.site_xwalk x LEFT JOIN master.site s USING (site_key)
                         ORDER BY x.site_key NULLS LAST, x.system, x.native_id""")
    cols = [c[0] for c in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    subj = con.execute("""SELECT system, status, method, count(*) AS n, min(native_id) AS example
                          FROM master.subject_xwalk GROUP BY ALL ORDER BY system, status""").fetchall()
    con.close()
    cat = engine.catalog()
    subject_access = engine.access(cat["datasets"]["master.subject_xwalk"], role)
    sites: dict[str, dict] = {}
    unresolved = []
    for r in rows:
        if r["site_key"] is None:
            unresolved.append(r)
            continue
        site = sites.setdefault(r["site_key"], {"site_key": r["site_key"], "site_name": r["site_name"], "city": r["city"],
                                                "state": r["state"], "pi": r["principal_investigator"], "ids": []})
        site["ids"].append({k: r[k] for k in ("system", "native_id", "native_label", "method", "confidence", "status",
                                              "runner_up_site_key", "runner_up_confidence", "evidence")})
    return {
        "sites": list(sites.values()), "unresolved": unresolved,
        "counts": {s: sum(1 for r in rows if r["status"] == s) for s in ("auto", "review", "unresolved")},
        "subjects": {"denied": policy.reason(subject_access["denied_tags"], role) if subject_access["denied"] else None,
                     "groups": [{"system": s, "status": st, "method": m, "n": n,
                                 "example": None if subject_access["denied"] else ex} for s, st, m, n, ex in subj]},
        "feeds": [{"system": f["system"], "system_name": f["system_name"], "id_conventions": f["id_conventions"]}
                  for f in cat["feeds"].values()],
    }


# ----------------------------------------------------------------------------- quality
@app.get("/api/quality")
def quality_view(role: str):
    role = _role(role)
    cat = engine.catalog()
    con = engine.warehouse()
    failures: dict[str, list] = {}
    for rule_id, key, detail, system, file, row in con.execute(
            "SELECT * FROM dq.failures ORDER BY rule_id, src_row NULLS LAST, record_key").fetchall():
        failures.setdefault(rule_id, []).append({"record_key": key, "detail": detail, "system": system, "file": file, "row": row})
    score = quality.score_answer_key(con)
    con.close()
    planted_keys = {(p["rule_id"], p["record_key"]) for p in score["planted"]}
    hidden_rules = set()
    rules = []
    for r in cat["rules"]:
        ds = cat["datasets"].get(r["dataset"])
        a = engine.access(ds, role) if ds else {"denied": False, "denied_tags": []}
        found = failures.get(r["rule_id"], [])
        for f in found:
            f["planted"] = (r["rule_id"], f["record_key"]) in planted_keys
        if a["denied"]:
            hidden_rules.add(r["rule_id"])
        rules.append({**r, "hidden": policy.reason(a["denied_tags"], role) if a["denied"] else None,
                      "failures": [] if a["denied"] else found})
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    rules.sort(key=lambda r: (r["n_failed"] == 0, order[r["severity"]], -r["n_failed"]))
    dims: dict[str, dict] = {}
    for r in rules:
        d = dims.setdefault(r["dimension"], {"dimension": r["dimension"], "rules": 0, "passing": 0, "findings": 0})
        d["rules"] += 1
        d["passing"] += r["n_failed"] == 0
        d["findings"] += r["n_failed"]
    by_rule = {}
    for r in rules:
        if r["n_failed"]:
            n_planted = sum(1 for p in score["planted"] if p["rule_id"] == r["rule_id"])
            if r["n_failed"] > n_planted:
                by_rule[r["rule_id"]] = {"title": r["title"], "n": r["n_failed"] - n_planted, "dataset": r["dataset"]}
    # the answer key names the same records as the findings, so it is withheld on the same terms
    planted = [{**p, "record_key": None, "hidden": True} if p["rule_id"] in hidden_rules else p for p in score["planted"]]
    return {"rules": rules, "dimensions": list(dims.values()), "feeds": list(cat["feeds"].values()),
            "answer_key": {**score, "planted": planted, "additional_by_rule": by_rule},
            "totals": {"rules": len(rules), "passing": sum(r["n_failed"] == 0 for r in rules),
                       "findings": sum(r["n_failed"] for r in rules)}}


# ----------------------------------------------------------------------------- access matrix
@app.get("/api/access")
def access_matrix():
    cat = engine.catalog()
    out = []
    for fqn, ds in cat["datasets"].items():
        per_role = {}
        for role in policy.ROLES:
            a = engine.access(ds, role)
            per_role[role] = {"denied": a["denied"], "masked": sorted(a["masked"])}
        tagged_cols = {n: c["tags"] for n, c in ds["columns"].items() if c["tags"]}
        if ds["tags"] or tagged_cols:
            out.append({"fqn": fqn, "layer": ds["layer"], "tags": ds["tags"], "column_tags": tagged_cols, "roles": per_role})
    return {"roles": policy.ROLES, "tags": policy.TAGS, "datasets": out}


# ----------------------------------------------------------------------------- front end
@app.get("/")
def index():
    return FileResponse(config.WEB / "index.html")


app.mount("/static", StaticFiles(directory=config.WEB), name="static")
