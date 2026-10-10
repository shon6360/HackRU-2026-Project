"""End-to-end checks. Run with `python -m pytest -q` or plain `python tests/test_concord.py`.

They build the warehouse from the committed feeds and then assert the things a judge (or an
auditor) would want to be true: the planted problems are caught, the headline question gives
the documented answer, no role can read what its policy withholds, by any route, and nobody
gets a role they did not sign in to.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from backend import accounts, ask, engine, server  # noqa: E402
from harmonizer import config, policy, quality  # noqa: E402
from harmonizer.pipeline import build  # noqa: E402

SUMMARY = build(verbose=False)
KEY = json.loads((config.FEEDS / "ANSWER_KEY.json").read_text())
# a throwaway accounts database holding only the starter accounts, so a run never touches the real one
config.ACCOUNTS = Path(tempfile.mkdtemp(prefix="concord-test-")) / "accounts.db"


def signed_in(username: str, password: str | None = None) -> TestClient:
    """A browser signed in to one account: the client keeps the session cookie the server sets."""
    client = TestClient(server.app)
    r = client.post("/api/login", json={"username": username, "password": password or accounts.starter_password()})
    assert r.status_code == 200, (username, r.json())
    return client


def test_every_planted_problem_is_caught():
    con = engine.warehouse()
    score = quality.score_answer_key(con)
    con.close()
    missed = [p for p in score["planted"] if not p["caught"]]
    assert not missed, missed
    assert score["n_planted"] >= 20


def test_headline_question_matches_the_documented_story():
    result = ask.ask("Which sites have open safety cases, low drug supply and overdue payments?", "clinops")
    assert result["mode"] == "vetted" and not result["error"]
    sites = sorted(row[0] for row in result["rows"])
    assert sites == sorted("S" + s for s in KEY["story_sites"]["all_three_problems"])
    assert any(w["kind"] == "stale" for w in result["context"]["warnings"]), "the stale finance feed must be flagged"


def test_every_reviewed_question_runs_or_is_refused_for_every_role():
    for v in ask.VETTED:
        outcomes = set()
        for role in accounts.roles():
            r = engine.execute(v["sql"], role)
            assert r["denied"] or not r["error"], (v["id"], role, r["error"])
            outcomes.add("refused" if r["denied"] else "ran")
        assert "ran" in outcomes, v["id"]


def test_every_grant_database_holds_nothing_the_policy_withholds():
    # every combination of grants, not only the ones today's roles hold: an administrator can give a role any of them
    cat = engine.catalog()
    assert len(policy.grant_sets()) == 2 ** len(policy.TAGS)
    for grants in policy.grant_sets():
        con = engine.mart_connection(grants)
        present = {f"{s}.{t}" for s, t in con.execute(
            "SELECT table_schema, table_name FROM information_schema.tables").fetchall()}
        for fqn, ds in cat["datasets"].items():
            if policy.table_denied(ds, grants):
                assert fqn not in present, f"the {grants} database contains withheld table {fqn}"
                continue
            assert fqn in present, f"the {grants} database lacks {fqn}, which those grants allow"
            for col in policy.masked_columns(ds, grants):
                n = con.execute(f'SELECT count("{col}") FROM {fqn}').fetchone()[0]
                assert n == 0, f"{grants} can read {fqn}.{col}"
        con.close()
    for role, r in accounts.roles().items():
        con = engine.role_connection(role)
        assert con.execute("PRAGMA database_list").fetchone()[2].endswith(config.mart_db(r["grants"]).name), f"{role} reads the wrong database"
        con.close()


def test_blinded_role_cannot_learn_the_arm_by_any_route():
    for sql in ["SELECT arm FROM gold.dim_subject",
                "SELECT trt_desc FROM bronze.irt_randomization",
                "SELECT kit_type FROM silver.irt_kits",
                "SELECT arm, count(*) FROM gold.fact_randomization GROUP BY 1",
                "SELECT * FROM bronze.edc_dm"]:
        r = engine.execute(sql, "clinops")
        assert not r["error"], r["error"]
        assert any(d["action"] == "mask" for d in r["decisions"]), sql
        arm_like = {"arm", "armcd", "actarm", "actarmcd", "trt_desc", "trt_cd", "kit_type"}
        idx = [i for i, c in enumerate(r["columns"]) if c["name"] in arm_like]
        assert idx and all(row[i] is None for row in r["rows"] for i in idx), sql


def test_finance_role_sees_no_patient_rows_and_statistician_no_money():
    assert engine.execute("SELECT * FROM gold.dim_subject", "finance")["denied"]
    assert engine.execute("SELECT * FROM bronze.edc_ae", "finance")["denied"]
    assert engine.execute("SELECT * FROM gold.fact_payment", "biostat")["denied"]
    r = engine.execute("SELECT site_key, overdue_usd FROM gold.site_360", "biostat")
    assert all(row[1] is None for row in r["rows"])
    r = engine.execute("SELECT vendor_id, payment_terms FROM silver.finance_vendors", "biostat")
    assert r["rows"] and all(row[1] is None for row in r["rows"]), "payment terms are financial"
    r = engine.execute("SELECT site_key, n_active, overdue_usd FROM gold.site_360", "finance")
    assert not r["error"] and any(row[2] for row in r["rows"]), "site-level aggregates stay available to finance"


def test_pages_that_read_the_full_warehouse_withhold_what_the_role_may_not_see():
    for role in accounts.roles():
        q = server.quality_view(role)
        hidden = {r["rule_id"] for r in q["rules"] if r["hidden"]}
        assert all(not r["failures"] for r in q["rules"] if r["hidden"]), role
        for p in q["answer_key"]["planted"]:
            assert (p["record_key"] is None) == (p["rule_id"] in hidden), (role, p["id"])
        assert q["answer_key"]["n_planted"] == len(KEY["planted"]), "the score itself stays visible to every role"
    finance = server.quality_view("finance")
    assert any(r["hidden"] and r["n_failed"] for r in finance["rules"]), "finance must be told findings exist without seeing them"
    assert not any(r["hidden"] for r in server.quality_view("clinops")["rules"])
    assert all(g["example"] is None for g in server.crosswalk("finance")["subjects"]["groups"])
    assert any(g["example"] for g in server.crosswalk("clinops")["subjects"]["groups"])


def test_sandbox_rejects_everything_but_select_on_cataloged_tables():
    for sql in ["DROP TABLE gold.dim_site",
                "SELECT 1; SELECT 2",
                "SELECT * FROM read_csv('feeds/irt/randomization.csv')",
                "COPY gold.dim_site TO 'out.csv'",
                "ATTACH 'build/warehouse.duckdb' AS wh",
                "SELECT * FROM gold.no_such_table",
                ""]:
        r = engine.execute(sql, "finance")
        assert r["error"], sql
    con = engine.role_connection("finance")
    for sql in ["SELECT * FROM read_csv('feeds/irt/randomization.csv')",
                f"ATTACH '{config.WAREHOUSE}' AS wh (READ_ONLY)",
                "SET enable_external_access = true"]:
        try:
            con.execute(sql)
        except Exception:
            continue
        raise AssertionError(f"the finance role's database allowed: {sql}")
    con.close()


def test_nothing_is_served_without_a_session():
    # routes put straight on the app skip the session check, so there must be none beyond these
    unguarded = {r.path for r in server.app.routes if getattr(r, "path", "").startswith("/api/")}
    assert unguarded == {"/api/login", "/api/logout", "/api/docs", "/api/openapi.json"}, unguarded
    visitor, checked = TestClient(server.app), 0
    for route in server.api.routes:
        for method in route.methods - {"HEAD", "OPTIONS"}:
            r = visitor.request(method, route.path.format(fqn="gold.site_360", account_id=1, role_id="clinops"), json={} if method in ("POST", "PATCH") else None)
            assert r.status_code == 401, f"{method} {route.path} answered {r.status_code} without a session"
            checked += 1
    assert checked >= 15, "the walk over the routes found too few of them"
    for password in ["wrong-password", ""]:
        assert visitor.post("/api/login", json={"username": "maya", "password": password}).status_code == 401
    assert visitor.post("/api/login", json={"username": "nobody", "password": accounts.starter_password()}).status_code == 401
    assert visitor.get("/api/me").status_code == 401, "a failed sign-in must not start a session"
    maya = signed_in("maya")
    assert maya.get("/api/me").json()["role"] == "clinops"
    maya.post("/api/logout")
    assert maya.get("/api/meta").status_code == 401, "signing out ends the session"


def test_the_role_comes_from_the_account_and_never_from_the_request():
    dana = signed_in("dana")
    r = dana.post("/api/sql", json={"sql": "SELECT * FROM gold.dim_subject", "role": "admin"}).json()
    assert r["role"] == "finance" and r["denied"] and not r["rows"], "a role named in the body must be ignored"
    r = dana.post("/api/ask", json={"question": "How many subjects and reportable adverse events are there in each treatment arm?", "role": "biostat"}).json()
    assert r["role"] == "finance" and r["denied"]
    assert any(d["access"]["denied"] for d in dana.get("/api/catalog", params={"role": "admin"}).json()["datasets"])
    assert dana.get("/api/dataset/gold.dim_subject", params={"role": "admin"}).json()["preview"] is None
    t = dana.get("/api/trace", params={"role": "admin", "column": "subject_key", "value": "x"}).json()
    assert t["crosswalk"]["denied"], "the trace runs as the account's role too"
    # comparing roles shows what the policy decides for each, and never another role's rows
    compared = dana.post("/api/compare", json={"sql": "SELECT arm, count(*) FROM gold.dim_subject GROUP BY 1"}).json()
    assert {c["role"]: c["denied"] for c in compared["roles"]} == {"clinops": False, "biostat": False, "finance": True, "admin": False}
    assert all(set(c) == {"role", "denied", "decisions"} for c in compared["roles"])
    admin = signed_in("admin").post("/api/sql", json={"sql": "SELECT arm, count(*) FROM gold.dim_subject GROUP BY 1"}).json()
    assert not admin["decisions"] and all(row[0] for row in admin["rows"]), "the administrator holds every grant"


def test_only_an_administrator_manages_accounts_and_changes_take_effect_at_once():
    admin, arjun = signed_in("admin"), signed_in("arjun")
    ids = {a["username"]: a["id"] for a in admin.get("/api/accounts").json()["accounts"]}
    assert set(ids) >= {"maya", "arjun", "dana", "admin"}
    new = {"username": "sam", "name": "Sam Lee", "role": "finance", "password": "long-enough-1"}
    for r in [arjun.get("/api/accounts"), arjun.post("/api/accounts", json={**new, "role": "admin"}),
              arjun.patch(f"/api/accounts/{ids['arjun']}", json={"role": "admin"}), arjun.delete(f"/api/accounts/{ids['dana']}")]:
        assert r.status_code == 403, "only an administrator may manage accounts"
    me = arjun.patch("/api/me", json={"name": "Arjun Rao", "role": "admin", "active": True}).json()
    assert me["name"] == "Arjun Rao" and me["role"] == "biostat", "people change their own name, never their own role"

    sam_id = admin.post("/api/accounts", json=new).json()["id"]
    assert admin.post("/api/accounts", json=new).status_code == 409, "usernames are unique"
    assert admin.post("/api/accounts", json={**new, "username": "sam2", "password": "short"}).status_code == 400
    assert admin.post("/api/accounts", json={**new, "username": "sam2", "role": "root"}).status_code == 400
    sam = signed_in("sam", "long-enough-1")
    patients = {"sql": "SELECT count(*) FROM gold.dim_subject"}
    assert sam.post("/api/sql", json=patients).json()["denied"]
    admin.patch(f"/api/accounts/{sam_id}", json={"role": "clinops"})
    assert not sam.post("/api/sql", json=patients).json()["denied"], "a new role applies to a session that is already open"

    assert sam.post("/api/me/password", json={"current": "not-it", "new": "another-long-1"}).status_code == 403
    assert sam.post("/api/me/password", json={"current": "long-enough-1", "new": "another-long-1"}).status_code == 200
    assert sam.get("/api/me").status_code == 200, "changing your own password keeps you signed in"
    assert TestClient(server.app).post("/api/login", json={"username": "sam", "password": "long-enough-1"}).status_code == 401
    admin.patch(f"/api/accounts/{sam_id}", json={"active": False})
    assert sam.get("/api/me").status_code == 401, "deactivating an account ends its sessions"
    assert TestClient(server.app).post("/api/login", json={"username": "sam", "password": "another-long-1"}).status_code == 401
    assert admin.delete(f"/api/accounts/{sam_id}").status_code == 200
    assert "sam" not in {a["username"] for a in admin.get("/api/accounts").json()["accounts"]}

    for r in [admin.delete(f"/api/accounts/{ids['admin']}"), admin.patch(f"/api/accounts/{ids['admin']}", json={"role": "clinops"}),
              admin.patch(f"/api/accounts/{ids['admin']}", json={"active": False})]:
        assert r.status_code == 409, "there must always be an active administrator"
    assert admin.get("/api/accounts").status_code == 200

    con = sqlite3.connect(config.ACCOUNTS)
    stored = " ".join(str(v) for table in ("accounts", "sessions") for row in con.execute(f"SELECT * FROM {table}").fetchall() for v in row)
    con.close()
    assert accounts.starter_password() not in stored and "another-long-1" not in stored, "passwords are stored only as hashes"
    assert admin.cookies[server.COOKIE] not in stored, "session tokens are stored only as hashes"
    assert all("password" not in key for a in admin.get("/api/accounts").json()["accounts"] for key in a)


def test_an_administrator_creates_and_edits_roles_and_the_grants_apply_at_once():
    admin, maya = signed_in("admin"), signed_in("maya")
    reviewer = {"name": "Safety Reviewer", "blurb": "Reads the cases.", "grants": ["patient_level"]}
    for r in [maya.post("/api/roles", json=reviewer), maya.patch("/api/roles/clinops", json={"grants": ["patient_level", "unblinded", "financial"]}),
              maya.patch("/api/roles/clinops", json={"manages_accounts": True}), maya.delete("/api/roles/finance")]:
        assert r.status_code == 403, "only an administrator may create, change or remove roles"

    role = admin.post("/api/roles", json=reviewer).json()
    assert role["id"] == "safety_reviewer" and role["grants"] == ["patient_level"] and not role["manages_accounts"]
    assert admin.post("/api/roles", json=reviewer).status_code == 409, "role names are unique"
    assert admin.post("/api/roles", json={"name": "Root", "grants": ["everything"]}).status_code == 400, "a grant must be a real tag"
    assert admin.get("/api/meta").json()["roles"]["safety_reviewer"]["name"] == "Safety Reviewer"
    assert "safety_reviewer" in admin.get("/api/access").json()["datasets"][0]["roles"]

    account = admin.post("/api/accounts", json={"username": "rev", "name": "Rev", "role": "safety_reviewer", "password": "long-enough-1"}).json()
    rev = signed_in("rev", "long-enough-1")
    arm = {"sql": "SELECT subject_key, arm FROM gold.dim_subject"}
    r = rev.post("/api/sql", json=arm).json()
    assert r["rows"] and all(row[1] is None for row in r["rows"]), "the new role is blinded: it was not granted unblinded"
    assert rev.post("/api/sql", json={"sql": "SELECT * FROM gold.fact_payment"}).json()["denied"], "nor financial"
    admin.patch("/api/roles/safety_reviewer", json={"grants": ["patient_level", "unblinded"], "name": "Unblinded Safety Reviewer"})
    r = rev.post("/api/sql", json=arm).json()
    assert all(row[1] for row in r["rows"]) and not r["decisions"], "a grant added to a role reaches a session that is already open"
    admin.patch("/api/roles/safety_reviewer", json={"grants": []})
    r = rev.post("/api/sql", json=arm).json()
    assert r["denied"] and "Unblinded Safety Reviewer" in r["decisions"][0]["reason"], "and so does a grant taken away"
    assert rev.get("/api/dataset/gold.dim_subject").json()["preview"] is None

    assert admin.delete("/api/roles/safety_reviewer").status_code == 409, "a role that an account holds cannot be removed"
    assert admin.post("/api/accounts", json={"username": "x9", "name": "X", "role": "no_such_role", "password": "long-enough-1"}).status_code == 400
    assert admin.patch("/api/roles/admin", json={"manages_accounts": False}).status_code == 409, "somebody must stay able to manage accounts"
    assert admin.get("/api/accounts").status_code == 200
    assert rev.post("/api/roles", json={"name": "Mine"}).status_code == 403
    admin.patch("/api/roles/safety_reviewer", json={"manages_accounts": True})
    assert rev.get("/api/accounts").status_code == 200, "a role can be given the management of accounts, and it applies at once"
    admin.delete(f"/api/accounts/{account['id']}")
    assert admin.delete("/api/roles/safety_reviewer").status_code == 200
    assert "safety_reviewer" not in admin.get("/api/meta").json()["roles"]
    assert admin.patch("/api/roles/safety_reviewer", json={"name": "Gone"}).status_code == 404


def test_each_account_keeps_its_own_gemini_key_and_it_never_comes_back():
    maya, dana, admin = signed_in("maya"), signed_in("dana"), signed_in("admin")
    key, question = "test-key-" + "k" * 30, "Which five sites have the most subjects still on study?"
    assert ask.match_vetted(question)[1] < 0.85, "the question must not be a reviewed one, or the model is never reached"
    # the model call is replaced, so nothing leaves the machine, and the server's own key is put aside for the test
    server_keys = {name: os.environ.pop(name, None) for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY")}
    real, used, written = ask._call_model, [], ["SELECT site_key, site_name, n_active FROM gold.site_360 ORDER BY n_active DESC LIMIT 5"]

    def stand_in(question, role, retry_note=None, api_key=None):
        used.append((role, api_key))
        return ask.SqlAnswer(can_answer=True, sql=written[0], explanation="Written by the stand-in.")

    ask._call_model = stand_in
    try:
        assert not maya.get("/api/me").json()["has_gemini_key"] and not maya.get("/api/meta").json()["model"]["available"]
        r = maya.post("/api/ask", json={"question": question}).json()
        assert r["mode"] != "model" and not used, "with no key anywhere, free-form asking is off and no model is called"

        assert maya.post("/api/me/gemini-key", json={"key": "too short"}).status_code == 400
        saved = maya.post("/api/me/gemini-key", json={"key": f"  {key}\n"})
        assert saved.json()["has_gemini_key"] and maya.get("/api/me").json()["has_gemini_key"]
        asked = maya.post("/api/ask", json={"question": question})
        assert asked.json()["mode"] == "model" and asked.json()["rows"] and used == [("clinops", key)], "a question is asked with the account's own key"
        r = dana.post("/api/ask", json={"question": question}).json()
        assert r["mode"] != "model" and len(used) == 1, "one account's key is never used for another account's question"

        listed = admin.get("/api/accounts")
        assert {a["username"]: a["has_gemini_key"] for a in listed.json()["accounts"]}["maya"]
        for r in [saved, asked, listed, maya.get("/api/me"), maya.get("/api/meta"), maya.patch("/api/me", json={"name": "Maya"})]:
            assert key not in r.text, "the key is never sent back, to its owner or to an administrator"

        # the key only decides whose quota the call uses: what the model writes still meets the role's policy
        dana.post("/api/me/gemini-key", json={"key": key})
        written[0] = "SELECT subject_key, arm FROM gold.dim_subject"
        r = dana.post("/api/ask", json={"question": question}).json()
        assert used[-1] == ("finance", key) and r["denied"] and not r["rows"]

        assert not maya.delete("/api/me/gemini-key").json()["has_gemini_key"]
        assert maya.post("/api/ask", json={"question": question}).json()["mode"] != "model", "removing the key turns free-form asking off again"
    finally:
        ask._call_model = real
        os.environ.update({name: value for name, value in server_keys.items() if value is not None})
        for client in (maya, dana):
            client.delete("/api/me/gemini-key")


def test_trace_reaches_source_rows_and_respects_policy():
    site = "S" + KEY["story_sites"]["all_three_problems"][0]
    t = engine.trace("clinops", "site_key", site)
    systems = {x["system"] for x in t["crosswalk"]["rows"]}
    assert systems == {"ctms", "edc", "irt", "safety", "finance"}
    assert all(s.get("rows") for s in t["sources"]), "every source block should show raw rows for clinops"
    t = engine.trace("finance", "site_key", site)
    withheld = [s["dataset"] for s in t["sources"] if s.get("denied")]
    assert "gold.dim_subject" in withheld and "gold.fact_payment" not in withheld


def test_lineage_reaches_a_source_file_for_every_table():
    cat = engine.catalog()
    for fqn in cat["datasets"]:
        if fqn == "gold.snapshot":
            continue
        nodes = engine.upstream_graph([fqn])["nodes"]
        assert any(n["layer"] == "source" for n in nodes), fqn


if __name__ == "__main__":
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"{len(tests)} passed")
