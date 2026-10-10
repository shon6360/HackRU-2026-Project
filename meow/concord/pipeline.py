"""Build everything from the feeds: bronze -> silver -> master -> gold, quality, catalog, role marts.

    python -m concord build

Layers
  bronze  the exports exactly as received (every value a string) plus where each row came from
  silver  the same data typed, renamed and with dates parsed, still one table per source object
  master  the golden site and subject records and the crosswalks that map every system's ids to them
  gold    conformed dimensions and facts keyed on the master keys: what people actually query
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime

import duckdb

from . import config, policy, quality
from .models import Model, load_models


def _snake(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


# ----------------------------------------------------------------------------- bronze
def _load_bronze(con) -> tuple[list[dict], dict[str, dict], dict[str, tuple[str, int, int]]]:
    """Load every file named in a feed manifest. Returns (feeds, bronze dataset metadata, row counts)."""
    now = config.platform_now()
    feeds, datasets, rows = [], {}, {}
    for manifest_path in sorted(config.FEEDS.glob("*/_manifest.json")):
        feed = json.loads(manifest_path.read_text())
        system = feed["system"]
        age = (now - datetime.fromisoformat(feed["extracted_at"])).total_seconds() / 3600
        feed["age_hours"] = round(age, 1)
        feed["is_stale"] = age > feed["freshness_sla_hours"]
        for f in feed["files"]:
            path = config.FEEDS / system / f["file"]
            rel = f"feeds/{system}/{f['file']}"
            table = f"{system}_{_snake(path.stem)}"
            headers: dict[str, str] = {}
            if path.suffix == ".csv":
                # parallel=false keeps file order, so row_number() is the line number in the file
                raw = con.execute(
                    "SELECT * FROM read_csv(?, all_varchar=true, header=true, parallel=false) LIMIT 0", [str(path)]
                ).description
                headers = {_snake(c[0]): c[0] for c in raw}
                select = ", ".join(f'"{orig}" AS {col}' for col, orig in headers.items())
                con.execute(
                    f"""CREATE TABLE bronze.{table} AS
                        SELECT {select}, '{system}' AS _src_system, '{rel}' AS _src_file, row_number() OVER () AS _src_row
                        FROM read_csv('{path}', all_varchar=true, header=true, parallel=false)"""
                )
            else:
                doc = json.loads(path.read_text())
                records = doc["results"] if isinstance(doc, dict) and "results" in doc else [doc]
                headers = {"raw": "the JSON record, verbatim"}
                con.execute(f"CREATE TABLE bronze.{table} (raw VARCHAR, _src_system VARCHAR, _src_file VARCHAR, _src_row BIGINT)")
                con.executemany(f"INSERT INTO bronze.{table} VALUES (?, ?, ?, ?)",
                                [[json.dumps(r), system, rel, i] for i, r in enumerate(records, start=1)])
            loaded = con.execute(f"SELECT count(*) FROM bronze.{table}").fetchone()[0]
            rows[rel] = (f"bronze.{table}", f["rows"], loaded)
            column_tags = f.get("column_tags", {})
            datasets[f"bronze.{table}"] = {
                "schema": "bronze", "name": table, "layer": "bronze",
                "description": f"{f['description']}. Raw export from {feed['system_name']}, loaded as received with every value kept as text.",
                "owner": feed["owner"], "steward": feed["steward"], "source_system": system,
                "grain": "one row per record in the file", "standard": "",
                "tags": f.get("tags", []), "source_file": rel, "sql": None, "deps": [rel],
                "columns": {col: {"description": f'Source column "{orig}"' if path.suffix == ".csv" else orig.capitalize(),
                                  "tags": column_tags.get(col, [])} for col, orig in headers.items()},
            }
        feeds.append(feed)
    return feeds, datasets, rows


# ----------------------------------------------------------------------------- models
def _run_models(con, models: list[Model], feeds: list[dict]) -> dict[str, dict]:
    con.execute((config.MODELS / "macros.sql").read_text())
    by_owner = {f["owner"]: f for f in feeds}
    datasets = {}
    for m in models:
        con.execute(f"CREATE TABLE {m.fqn} AS {m.sql}")
        feed = by_owner.get(m.owner)
        datasets[m.fqn] = {
            "schema": m.schema, "name": m.name, "layer": m.schema,
            "description": m.description, "owner": m.owner, "steward": feed["steward"] if feed else "Data Stewardship",
            "source_system": feed["system"] if feed and m.schema == "silver" else None,
            "grain": m.grain, "standard": m.standard, "tags": m.tags, "source_file": None,
            "sql": m.sql, "deps": m.deps, "columns": m.columns,
        }
    return datasets


# ----------------------------------------------------------------------------- catalog
def _profile(con, fqn: str, declared: dict[str, dict]) -> list[dict]:
    cols = con.execute(f"DESCRIBE {fqn}").fetchall()
    n = con.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    out = []
    for pos, (name, dtype, *_rest) in enumerate(cols):
        q = f'"{name}"'
        nulls, distinct, lo, hi = con.execute(
            f"SELECT count(*) - count({q}), count(DISTINCT {q}), CAST(min({q}) AS VARCHAR), CAST(max({q}) AS VARCHAR) FROM {fqn}"
        ).fetchone()
        samples = [r[0] for r in con.execute(
            f"""SELECT left(CAST({q} AS VARCHAR), 60) FROM {fqn} WHERE {q} IS NOT NULL
                GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 4""").fetchall()]
        meta = declared.get(name) or {"description": config.LINEAGE_COLUMNS.get(name, ""), "tags": []}
        out.append({"name": name, "position": pos, "type": dtype, "description": meta["description"], "tags": meta["tags"],
                    "null_pct": round(100 * nulls / n, 1) if n else 0.0, "n_distinct": distinct,
                    "min": lo, "max": hi, "samples": samples})
    return out


def _upstream_feeds(fqn: str, datasets: dict[str, dict], memo: dict[str, set]) -> set[str]:
    if fqn not in memo:
        ds = datasets.get(fqn)
        if ds is None:  # a feed file: feeds/<system>/<file>
            memo[fqn] = {fqn.split("/")[1]} if fqn.startswith("feeds/") else set()
        else:
            deps = [d for d in ds["deps"] if d not in config.ID_MAPS]
            memo[fqn] = set().union(*(_upstream_feeds(d, datasets, memo) for d in deps)) if deps else set()
    return memo[fqn]


def _write_catalog(con, datasets: dict[str, dict], feeds: list[dict]) -> None:
    con.execute("CREATE SCHEMA IF NOT EXISTS meta")
    con.execute("""CREATE TABLE meta.feeds (system VARCHAR, system_name VARCHAR, owner VARCHAR, steward VARCHAR,
                   extracted_at TIMESTAMP, freshness_sla_hours INTEGER, age_hours DOUBLE, is_stale BOOLEAN,
                   id_conventions VARCHAR, files VARCHAR)""")
    for f in feeds:
        con.execute("INSERT INTO meta.feeds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [f["system"], f["system_name"], f["owner"], f["steward"], f["extracted_at"], f["freshness_sla_hours"],
                     f["age_hours"], f["is_stale"], f["id_conventions"], json.dumps(f["files"])])

    con.execute("""CREATE TABLE meta.datasets (fqn VARCHAR, schema VARCHAR, name VARCHAR, layer VARCHAR, description VARCHAR,
                   owner VARCHAR, steward VARCHAR, source_system VARCHAR, grain VARCHAR, standard VARCHAR, tags VARCHAR,
                   source_file VARCHAR, sql VARCHAR, row_count BIGINT, upstream_systems VARCHAR)""")
    con.execute("""CREATE TABLE meta.columns (fqn VARCHAR, name VARCHAR, position INTEGER, type VARCHAR, description VARCHAR,
                   tags VARCHAR, null_pct DOUBLE, n_distinct BIGINT, min VARCHAR, max VARCHAR, samples VARCHAR)""")
    con.execute("CREATE TABLE meta.lineage (src VARCHAR, dst VARCHAR)")
    memo: dict[str, set] = {}
    for fqn, ds in datasets.items():
        n = con.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
        systems = sorted(_upstream_feeds(fqn, datasets, memo))
        con.execute("INSERT INTO meta.datasets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [fqn, ds["schema"], ds["name"], ds["layer"], ds["description"], ds["owner"], ds["steward"],
                     ds["source_system"], ds["grain"], ds["standard"], json.dumps(ds["tags"]), ds["source_file"], ds["sql"],
                     n, json.dumps(systems)])
        for c in _profile(con, fqn, ds["columns"]):
            con.execute("INSERT INTO meta.columns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        [fqn, c["name"], c["position"], c["type"], c["description"], json.dumps(c["tags"]), c["null_pct"],
                         c["n_distinct"], c["min"], c["max"], json.dumps(c["samples"])])
        for dep in ds["deps"]:
            con.execute("INSERT INTO meta.lineage VALUES (?, ?)", [dep, fqn])


# ----------------------------------------------------------------------------- role marts
def _build_role_marts(datasets: dict[str, dict], types: dict[str, list[tuple[str, str]]]) -> dict[str, dict]:
    """One read-only database per role, holding only what that role may see (see policy.py)."""
    summary = {}
    for role in policy.ROLES:
        path = config.role_db(role)
        path.unlink(missing_ok=True)
        out = duckdb.connect(str(path))
        out.execute(f"ATTACH '{config.WAREHOUSE}' AS wh (READ_ONLY)")
        denied = masked = 0
        for schema in config.LAYERS:
            out.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        for fqn, ds in datasets.items():
            if policy.table_denied(ds, role):
                denied += 1
                continue
            hidden = policy.masked_columns(ds, role)
            masked += len(hidden)
            select = ", ".join(f'CAST(NULL AS {dtype}) AS "{col}"' if col in hidden else f'"{col}"' for col, dtype in types[fqn])
            out.execute(f"CREATE TABLE {fqn} AS SELECT {select} FROM wh.{fqn}")
        out.execute("DETACH wh")
        out.close()
        summary[role] = {"tables_denied": denied, "columns_masked": masked}
    return summary


# ----------------------------------------------------------------------------- entry point
def build(verbose: bool = True) -> dict:
    started = time.time()
    config.BUILD.mkdir(exist_ok=True)
    for old in config.BUILD.glob("*.duckdb*"):
        old.unlink()

    con = duckdb.connect(str(config.WAREHOUSE))
    for schema in config.LAYERS:
        con.execute(f"CREATE SCHEMA {schema}")
    con.execute(f"CREATE TABLE gold.snapshot AS SELECT DATE '{config.snapshot_date()}' AS as_of")

    feeds, datasets, bronze_rows = _load_bronze(con)
    models = load_models()
    datasets.update(_run_models(con, models, feeds))
    datasets["gold.snapshot"] = {
        "schema": "gold", "name": "snapshot", "layer": "gold",
        "description": "The date everything is evaluated as of: 'overdue', 'active', 'usable' and 'stale' are all relative to it.",
        "owner": "Clinical Data Engineering", "steward": "Data Stewardship", "source_system": None,
        "grain": "one row", "standard": "", "tags": [], "source_file": None, "sql": None, "deps": [],
        "columns": {"as_of": {"description": "Snapshot date", "tags": []}},
    }

    dq = quality.run(con, feeds, bronze_rows)
    _write_catalog(con, datasets, feeds)
    types = {fqn: [(r[0], r[1]) for r in con.execute(f"DESCRIBE {fqn}").fetchall()] for fqn in datasets}
    score = quality.score_answer_key(con)
    counts = dict(con.execute("SELECT layer, count(*) FROM meta.datasets GROUP BY 1").fetchall())
    xwalk = dict(con.execute("SELECT status, count(*) FROM master.site_xwalk GROUP BY 1").fetchall())
    con.close()

    roles = _build_role_marts(datasets, types)
    summary = {"seconds": round(time.time() - started, 1), "as_of": str(config.snapshot_date()), "feeds": len(feeds),
               "datasets": counts, "site_crosswalk": xwalk, "quality": dq,
               "answer_key": {k: score[k] for k in ("n_planted", "n_caught", "n_additional")}, "roles": roles}
    if verbose:
        print(f"Concord build finished in {summary['seconds']}s (snapshot date {summary['as_of']})")
        print(f"  feeds      {len(feeds)} systems: " + ", ".join(
            f"{f['system']}{' (STALE)' if f['is_stale'] else ''}" for f in feeds))
        print("  datasets   " + ", ".join(f"{counts.get(l, 0)} {l}" for l in config.LAYERS))
        print("  crosswalk  " + ", ".join(f"{n} {s}" for s, n in sorted(xwalk.items())) + " site identifiers")
        print(f"  quality    {dq['rules']} rules, {dq['rules_failing']} failing, {dq['findings']} findings")
        print(f"  answer key {score['n_caught']}/{score['n_planted']} planted problems caught, "
              f"{score['n_additional']} more found that were not planted")
        for role, r in roles.items():
            print(f"  role mart  {role:8s} {r['tables_denied']} tables withheld, {r['columns_masked']} columns masked")
    return summary
