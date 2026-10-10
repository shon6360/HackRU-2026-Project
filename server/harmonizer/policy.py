"""Access policy: sensitivity tags on data, grants on roles, and nothing else.

A table or column is tagged in the catalog (by the source owner in the feed manifest, or in a
model header). A role holds a set of grants. The whole policy is:

    table  carries a tag the role lacks  ->  the table does not exist for that role
    column carries a tag the role lacks  ->  the column is NULL for that role

It is enforced twice. At build time every combination of grants gets its own read-only database
(a mart) that physically contains only what those grants may see, so a query cannot leak what is
not there, whoever (or whatever model) wrote the SQL. At query time the SQL is parsed and checked
against the same tags, so the user is told exactly what was withheld and why.

The tags are fixed here, because they are written into the feed manifests and the model headers.
The roles are not: an administrator creates and edits them, and they are kept with the accounts
(`backend/accounts.py`). That is why the marts are built per combination of grants and not per
role. Whatever grants a role is given, its mart already exists.
"""
from __future__ import annotations

from itertools import combinations

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


def grant_sets() -> list[tuple[str, ...]]:
    """Every combination of grants a role could hold, from none of the tags to all of them."""
    return [held for n in range(len(TAGS) + 1) for held in combinations(TAGS, n)]


def missing_tags(tags: list[str], grants) -> list[str]:
    return [t for t in tags if t not in grants]


def table_denied(dataset: dict, grants) -> list[str]:
    """Tags that keep these grants out of the table entirely (empty list = allowed)."""
    return missing_tags(dataset["tags"], grants)


def masked_columns(dataset: dict, grants) -> dict[str, list[str]]:
    """Columns of an allowed table that are nulled for these grants, with the tags responsible."""
    out = {}
    for name, col in dataset["columns"].items():
        lacking = missing_tags(col["tags"], grants)
        if lacking:
            out[name] = lacking
    return out


def reason(tags: list[str], role_name: str) -> str:
    labels = " and ".join(TAGS[t]["label"].lower() for t in tags)
    return f"tagged {labels}; the {role_name} role does not hold that grant"
