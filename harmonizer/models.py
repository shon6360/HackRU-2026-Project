"""SQL models: one .sql file per table, with its documentation in the header.

    -- @description What the table is
    -- @owner       Who answers for it
    -- @tags        patient_level, financial          (table-level sensitivity tags)
    -- @grain       one row per ...
    -- @col name [unblinded]: What the column means   (column-level tags in brackets)
    SELECT ...

Dependencies are not declared: they are read out of the SQL, which is also where the lineage
graph comes from. A model's schema is its folder name.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from graphlib import TopologicalSorter

import sqlglot
from sqlglot import exp

from . import config

_COL = re.compile(r"^(\w+)\s*(?:\[([^\]]*)\])?\s*:\s*(.*)$")


@dataclass
class Model:
    schema: str
    name: str
    sql: str
    description: str = ""
    owner: str = ""
    grain: str = ""
    standard: str = ""
    tags: list[str] = field(default_factory=list)
    columns: dict[str, dict] = field(default_factory=dict)
    deps: list[str] = field(default_factory=list)

    @property
    def fqn(self) -> str:
        return f"{self.schema}.{self.name}"


def referenced_tables(sql: str) -> list[str]:
    """Schema-qualified tables a statement reads from (CTE names are unqualified, so they drop out)."""
    tree = sqlglot.parse_one(sql, dialect="duckdb")
    return sorted({f"{t.db}.{t.name}" for t in tree.find_all(exp.Table) if t.db})


def _parse(schema: str, name: str, text: str) -> Model:
    m = Model(schema=schema, name=name, sql="")
    body = []
    for line in text.splitlines():
        if line.startswith("-- @"):
            key, _, value = line[4:].partition(" ")
            value = value.strip()
            if key == "col":
                hit = _COL.match(value)
                if not hit:
                    raise ValueError(f"{schema}.{name}: bad @col line: {line}")
                col, tags, desc = hit.groups()
                m.columns[col] = {"description": desc, "tags": [t.strip() for t in (tags or "").split(",") if t.strip()]}
            elif key == "tags":
                m.tags = [t.strip() for t in value.split(",") if t.strip()]
            elif key in ("description", "owner", "grain", "standard"):
                setattr(m, key, value)
            else:
                raise ValueError(f"{schema}.{name}: unknown header @{key}")
        else:
            body.append(line)
    m.sql = "\n".join(body).strip()
    m.deps = referenced_tables(m.sql)
    return m


def load_models() -> list[Model]:
    """All models, in an order where every model comes after the tables it reads."""
    found = {}
    for schema in ("silver", "master", "gold"):
        for path in sorted((config.MODELS / schema).glob("*.sql")):
            model = _parse(schema, path.stem, path.read_text())
            found[model.fqn] = model
    order = TopologicalSorter({fqn: [d for d in m.deps if d in found] for fqn, m in found.items()}).static_order()
    return [found[fqn] for fqn in order]
