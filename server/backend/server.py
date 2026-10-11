"""The server: a small JSON API over the engine, plus the web app that `client/` builds to static files.

One process on one address serves both, so another computer needs only a browser and every request the web
app makes is same-origin. Every route but signing in and out needs a session. The role a request runs as is the role of
the signed-in account, looked up from the session cookie: no route takes a role from the client.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from harmonizer import config, policy, quality

from . import accounts
from . import ask as asker
from . import engine, filters

WEB = config.ROOT.parent / "client" / "out"  # the static site that `npm run build` writes in client/
COOKIE = "concord_session"

# The schema sits under /api with the docs page that loads it, so the page also works through `npm run dev`, which forwards only /api.
app = FastAPI(title="Concord", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)


# ----------------------------------------------------------------------------- who is asking
def _account(request: Request) -> dict:
    """The signed-in account behind a request."""
    account = accounts.account_for(request.cookies.get(COOKIE))
    if account is None:
        raise HTTPException(401, "Sign in to use Concord.")
    if account["role"] not in accounts.roles():
        raise HTTPException(403, f"Your account holds a role that no longer exists ({account['role']}). Ask an administrator to change it.")
    return account


def _role(account: dict = Depends(_account)) -> str:
    """The role a request runs as: the signed-in account's, never one the client names."""
    return account["role"]


def _admin(account: dict = Depends(_account)) -> dict:
    if not accounts.roles()[account["role"]]["manages_accounts"]:
        raise HTTPException(403, "Only an administrator can manage accounts and roles.")
    return account


# Routes go on `api`, not on `app`, so that a new one needs a session unless it is deliberately made public.
api = APIRouter(dependencies=[Depends(_account)])


@app.exception_handler(accounts.AccountError)
def account_error(_: Request, e: accounts.AccountError):
    return JSONResponse({"detail": str(e)}, status_code=e.status)


class LoginBody(BaseModel):
    username: str
    password: str


class NameBody(BaseModel):
    name: str


class PasswordBody(BaseModel):
    current: str
    new: str


class KeyBody(BaseModel):
    key: str


class NewAccount(BaseModel):
    username: str
    name: str
    role: str
    password: str


class AccountChanges(BaseModel):
    username: str | None = None
    name: str | None = None
    role: str | None = None
    active: bool | None = None
    password: str | None = None


class NewRole(BaseModel):
    name: str
    blurb: str = ""
    grants: list[str] = []
    manages_accounts: bool = False


class RoleChanges(BaseModel):
    name: str | None = None
    blurb: str | None = None
    grants: list[str] | None = None
    manages_accounts: bool | None = None


class AskBody(BaseModel):
    question: str


class SqlBody(BaseModel):
    sql: str


class Condition(BaseModel):
    """One limit on one field. Which of these it carries depends on the kind of field: see `filters.py`."""
    field: str
    any_of: list[str] | None = None
    contains: str | None = None
    min: float | str | None = None
    max: float | str | None = None
    equals: bool | None = None


class FilterBody(BaseModel):
    category: str
    site_key: str | None = None
    subject_key: str | None = None
    conditions: list[Condition] = []


# ----------------------------------------------------------------------------- sign-in and your own account
@app.post("/api/login")
def login(body: LoginBody, request: Request, response: Response):
    token, account = accounts.sign_in(body.username, body.password)
    # HttpOnly keeps the token from scripts; SameSite=Strict keeps other sites from making requests with it
    response.set_cookie(COOKIE, token, max_age=accounts.SESSION_SECONDS, httponly=True, samesite="strict",
                        secure=request.url.scheme == "https", path="/")
    return account


@app.post("/api/logout")
def logout(request: Request, response: Response):
    accounts.sign_out(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@api.get("/api/me")
def me(account: dict = Depends(_account)):
    return account


@api.patch("/api/me")
def rename_me(body: NameBody, account: dict = Depends(_account)):
    return accounts.update(account["id"], name=body.name)


@api.post("/api/me/password")
def change_my_password(body: PasswordBody, request: Request, account: dict = Depends(_account)):
    accounts.change_password(account["id"], body.current, body.new, keep=request.cookies.get(COOKIE))
    return {"ok": True}


# Your own Gemini key goes in and never comes back out: the account that is returned says only that it has one.
@api.post("/api/me/gemini-key")
def set_my_gemini_key(body: KeyBody, account: dict = Depends(_account)):
    return accounts.set_gemini_key(account["id"], body.key)


@api.delete("/api/me/gemini-key")
def remove_my_gemini_key(account: dict = Depends(_account)):
    return accounts.set_gemini_key(account["id"], None)


# ----------------------------------------------------------------------------- accounts (administrators only)
@api.get("/api/accounts")
def account_list(_: dict = Depends(_admin)):
    return {"accounts": accounts.list_accounts()}


@api.post("/api/accounts")
def account_create(body: NewAccount, _: dict = Depends(_admin)):
    return accounts.create(body.username, body.name, body.role, body.password)


@api.patch("/api/accounts/{account_id}")
def account_update(account_id: int, body: AccountChanges, _: dict = Depends(_admin)):
    return accounts.update(account_id, **body.model_dump(exclude_none=True))


@api.delete("/api/accounts/{account_id}")
def account_delete(account_id: int, _: dict = Depends(_admin)):
    accounts.delete(account_id)
    return {"ok": True}


# ----------------------------------------------------------------------------- roles (administrators only)
# Everyone reads the roles from /api/meta. Changing them is changing who can see what, so it is the administrator's.
@api.post("/api/roles")
def role_create(body: NewRole, _: dict = Depends(_admin)):
    return accounts.create_role(body.name, body.blurb, body.grants, body.manages_accounts)


@api.patch("/api/roles/{role_id}")
def role_update(role_id: str, body: RoleChanges, _: dict = Depends(_admin)):
    return accounts.update_role(role_id, **body.model_dump(exclude_none=True))


@api.delete("/api/roles/{role_id}")
def role_delete(role_id: str, _: dict = Depends(_admin)):
    accounts.delete_role(role_id)
    return {"ok": True}


# ----------------------------------------------------------------------------- meta
@api.get("/api/meta")
def meta():
    cat = engine.catalog()
    layers = {}
    for ds in cat["datasets"].values():
        layers[ds["layer"]] = layers.get(ds["layer"], 0) + 1
    return {
        "as_of": str(config.snapshot_date()),
        "roles": accounts.roles(),
        "tags": policy.TAGS,
        "feeds": list(cat["feeds"].values()),
        "layers": layers,
        "model": {"available": asker.model_available(), "id": asker.MODEL},
    }


# ----------------------------------------------------------------------------- ask
@api.post("/api/ask")
def ask(body: AskBody, role: str = Depends(_role), account: dict = Depends(_account)):
    # the account's own key, when it has one, pays for the model call. The role still decides what the answer may hold
    return asker.ask(body.question, role, accounts.gemini_key(account["id"]))


@api.get("/api/filters")
def filter_options(role: str = Depends(_role)):
    return filters.options(role)


@api.post("/api/filter")
def filter_run(body: FilterBody, role: str = Depends(_role)):
    return filters.run(body.model_dump(), role)


@api.post("/api/sql")
def sql(body: SqlBody, role: str = Depends(_role)):
    result = engine.execute(body.sql, role)
    return {**result, "mode": "sql", "question": None, "explanation": None, "model": None}


@api.post("/api/compare")
def compare(body: SqlBody):
    """What the policy decides about one query for each role. Nothing is run, so no role's rows reach another."""
    roles = []
    for role in accounts.roles():
        try:
            pre = engine.preflight(body.sql, role)
        except engine.QueryRejected as e:
            return {"error": str(e), "roles": []}
        roles.append({"role": role, "denied": pre["denied"], "decisions": pre["decisions"]})
    return {"error": None, "roles": roles}


@api.get("/api/trace")
def trace(column: str, value: str, role: str = Depends(_role)):
    return engine.trace(role, column, value)


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


@api.get("/api/catalog")
def catalog_list(role: str = Depends(_role)):
    cat = engine.catalog()
    return {"datasets": [_summary(ds, role, cat) for ds in cat["datasets"].values()]}


@api.get("/api/dataset/{fqn}")
def dataset(fqn: str, role: str = Depends(_role)):
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
                   "reason": engine.reason(a["denied_tags"], role) if a["denied"] else None},
        "fair_checks": _fair(ds, cat), "upstream": sorted(cat["upstream"].get(fqn, [])), "downstream": downstream,
        "graph": engine.upstream_graph([fqn]), "rules": rules,
        "feeds": [cat["feeds"][s] for s in ds["upstream_systems"]],
    }


@api.get("/api/lineage")
def lineage():
    cat = engine.catalog()
    return engine.upstream_graph([fqn for fqn in cat["datasets"]])


@api.get("/api/lineage/sites")
def lineage_sites(role: str = Depends(_role)):
    """The sites the Lineage page can be searched for by name. Site names are data, so they follow the role."""
    return engine.site_list(role)


@api.get("/api/lineage/site")
def lineage_site(site_key: str, role: str = Depends(_role)):
    return engine.site_lineage(role, site_key)


# ----------------------------------------------------------------------------- crosswalk
# the column each system's silver tables carry a site's id in, as master.site_xwalk reads them
SITE_ID_COLUMN = {"ctms": "site_number_src", "edc": "site_id_src", "irt": "site_code_src", "safety": "site_name_src", "finance": "vendor_id"}


def _id_sources(con, cat: dict, role: str, system: str, native_id: str) -> list[dict]:
    """The source files one site id is written in and the rows it is on, so a problem can be found where it was made.

    Read from the role's own database. A file whose table or id column is withheld is still named,
    with the reason and no rows: whether the id is in it is itself withheld.
    """
    col = SITE_ID_COLUMN[system]
    read_for_matching = cat["upstream"]["master.site_xwalk"]  # those files first: they are where the id is defined
    found = []
    for fqn, ds in sorted(cat["datasets"].items(), key=lambda kv: (kv[0] not in read_for_matching, kv[0])):
        if ds["layer"] != "silver" or ds["source_system"] != system or col not in ds["columns"]:
            continue
        file = next(cat["datasets"][b]["source_file"] for b in sorted(cat["upstream"][fqn]) if cat["datasets"][b]["source_file"])
        a = engine.access(ds, role)
        hidden = a["denied_tags"] or a["masked"].get(col)
        if hidden:
            found.append({"file": file, "rows": None, "row_numbers": [], "denied": engine.reason(hidden, role)})
            continue
        rows = [r[0] for r in con.execute(f'SELECT _src_row FROM {fqn} WHERE "{col}" = ? ORDER BY _src_row', [native_id]).fetchall()]
        if rows:
            found.append({"file": file, "rows": len(rows), "row_numbers": rows[:5], "denied": None})
    return found


@api.get("/api/crosswalk")
def crosswalk(role: str = Depends(_role)):
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
    mart = engine.role_connection(role)
    try:
        for r in rows:  # only the ids a person has to look at say where they were found
            r["sources"] = _id_sources(mart, cat, role, r["system"], r["native_id"]) if r["status"] != "auto" else None
    finally:
        mart.close()
    sites: dict[str, dict] = {}
    unresolved = []
    for r in rows:
        if r["site_key"] is None:
            unresolved.append(r)
            continue
        site = sites.setdefault(r["site_key"], {"site_key": r["site_key"], "site_name": r["site_name"], "city": r["city"],
                                                "state": r["state"], "pi": r["principal_investigator"], "ids": []})
        site["ids"].append({k: r[k] for k in ("system", "native_id", "native_label", "method", "confidence", "status",
                                              "runner_up_site_key", "runner_up_confidence", "evidence", "sources")})
    return {
        "sites": list(sites.values()), "unresolved": unresolved,
        "counts": {s: sum(1 for r in rows if r["status"] == s) for s in ("auto", "review", "unresolved")},
        "subjects": {"denied": engine.reason(subject_access["denied_tags"], role) if subject_access["denied"] else None,
                     "groups": [{"system": s, "status": st, "method": m, "n": n,
                                 "example": None if subject_access["denied"] else ex} for s, st, m, n, ex in subj]},
        "feeds": [{"system": f["system"], "system_name": f["system_name"], "id_conventions": f["id_conventions"]}
                  for f in cat["feeds"].values()],
    }


# ----------------------------------------------------------------------------- quality
@api.get("/api/quality")
def quality_view(role: str = Depends(_role)):
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
        rules.append({**r, "hidden": engine.reason(a["denied_tags"], role) if a["denied"] else None,
                      "failures": [] if a["denied"] else found})
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "warning": 4, "info": 5}
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
@api.get("/api/access")
def access_matrix():
    cat = engine.catalog()
    out = []
    for fqn, ds in cat["datasets"].items():
        per_role = {}
        for role in accounts.roles():
            a = engine.access(ds, role)
            per_role[role] = {"denied": a["denied"], "masked": sorted(a["masked"])}
        tagged_cols = {n: c["tags"] for n, c in ds["columns"].items() if c["tags"]}
        if ds["tags"] or tagged_cols:
            out.append({"fqn": fqn, "layer": ds["layer"], "tags": ds["tags"], "column_tags": tagged_cols, "roles": per_role})
    return {"roles": accounts.roles(), "tags": policy.TAGS, "datasets": out}


app.include_router(api)

# ----------------------------------------------------------------------------- the web app
# Mounted last, so it only sees what no /api route claimed. html=True serves <page>/index.html for /<page>/.
if WEB.is_dir():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="client")
else:
    @app.get("/", include_in_schema=False)
    def not_built():
        return PlainTextResponse("The web app has not been built yet. Run this once in server/, then restart the server:\n\n"
                                 "    python -m backend build\n\n"
                                 "The API is running: see /api/docs.\n", status_code=503)
