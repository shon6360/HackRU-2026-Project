"""Concord's harmonizer: turns the five source feeds into one warehouse.

Loads the feeds, works out which ids mean the same site and subject, builds the conformed
tables, checks quality, writes the catalog, and cuts one read-only database per combination of grants. The
back end reads what this package leaves in build/ and imports `config` and `policy` from here.
"""

__version__ = "0.1.0"
