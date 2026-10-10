"""Access policy: sensitivity tags on data, grants on roles, and nothing else.

A table or column is tagged in the catalog (by the source owner in the feed manifest, or in a
model header). A role holds a set of grants. The whole policy is:

    table  carries a tag the role lacks  ->  the table does not exist for that role
    column carries a tag the role lacks  ->  the column is NULL for that role

It is enforced twice. At build time each role gets its own read-only database that physically
contains only what the role may see, so a query cannot leak what is not there, whoever (or
whatever model) wrote the SQL. At query time the SQL is parsed and checked against the same
tags, so the user is told exactly what was withheld and why.
"""
from __future__ import annotations

TAGS = {
    "patient_level": {
        "label": "Patient-level",
        "description": "Rows about individual trial participants.",
    },
    "unblinded": {
        "label": "Unblinded",
        "description": "Reveals which treatment a participant received. The study team must stay blind to it.",
    },
    "financial": {
        "label": "Financial",
        "description": "Payment amounts and terms agreed with sites.",
    },
}

ROLES = {
    "clinops": {
        "name": "Clinical Operations Lead",
        "person": "Maya",
        "blurb": "Runs the study day to day. Blinded: must not learn who is on which treatment.",
        "grants": ["patient_level", "financial"],
    },
    "biostat": {
        "name": "Unblinded Statistician",
        "person": "Arjun",
        "blurb": "Prepares the safety review for the independent monitoring committee. Sees treatment arms, not site contracts.",
        "grants": ["patient_level", "unblinded"],
    },
    "finance": {
        "name": "Site Payments Analyst",
        "person": "Dana",
        "blurb": "Pays the sites. Sees money and site-level counts, never individual participants.",
        "grants": ["financial"],
    },
}


def missing_tags(tags: list[str], role: str) -> list[str]:
    grants = set(ROLES[role]["grants"])
    return [t for t in tags if t not in grants]


def table_denied(dataset: dict, role: str) -> list[str]:
    """Tags that keep this role out of the table entirely (empty list = allowed)."""
    return missing_tags(dataset["tags"], role)


def masked_columns(dataset: dict, role: str) -> dict[str, list[str]]:
    """Columns of an allowed table that are nulled for this role, with the tags responsible."""
    out = {}
    for name, col in dataset["columns"].items():
        lacking = missing_tags(col["tags"], role)
        if lacking:
            out[name] = lacking
    return out


def reason(tags: list[str], role: str) -> str:
    labels = " and ".join(TAGS[t]["label"].lower() for t in tags)
    return f"tagged {labels}; the {ROLES[role]['name']} role does not hold that grant"
