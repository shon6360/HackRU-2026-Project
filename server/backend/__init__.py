"""Concord's back end: answers questions from the warehouse the harmonizer built.

Runs a role's SQL inside the database built for that role's grants, explains the answer (lineage, freshness,
quality, what was withheld), turns plain-English questions into SQL, and serves the JSON API
that clients connect to. It never writes to build/; `config` and `policy` come from the harmonizer.
"""
