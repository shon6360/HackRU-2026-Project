"""Paths, settings from `.env`, and the snapshot date everything is evaluated against."""
from __future__ import annotations

import json
from datetime import date, datetime, time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
# Every module, here and in the back end, imports config first, so the key is in place before anything reads it.
# A variable already set in the shell wins over the file.
load_dotenv(ROOT / ".env")
FEEDS = ROOT / "feeds"
BUILD = ROOT / "build"
WAREHOUSE = BUILD / "warehouse.duckdb"
# Accounts and sessions. Kept out of build/, which every build deletes and recreates.
ACCOUNTS = ROOT / "state" / "accounts.db"
MODELS = Path(__file__).parent / "models"

LAYERS = ["bronze", "silver", "master", "gold"]
LINEAGE_COLUMNS = {
    "_src_system": "Lineage: source system this row came from",
    "_src_file": "Lineage: source file this row came from",
    "_src_row": "Lineage: row number in the source file (1 = first data row)",
}


# Crosswalks read every system in order to map its ids. When working out which systems an answer's
# DATA came from (freshness, quality warnings) they are not followed; the lineage graph still shows them.
ID_MAPS = {"master.site_xwalk", "master.subject_xwalk"}


def mart_db(grants) -> Path:
    """The read-only database holding exactly what this set of grants may see. One is built for every combination."""
    return BUILD / f"mart_{'+'.join(sorted(grants)) or 'no_grants'}.duckdb"


def snapshot_date() -> date:
    return date.fromisoformat(json.loads((FEEDS / "_snapshot.json").read_text())["as_of"])


def platform_now() -> datetime:
    """The platform's notion of 'now': 08:00 on the snapshot day, after the nightly extracts land.
    Feed freshness is measured from here."""
    return datetime.combine(snapshot_date(), time(8, 0))
