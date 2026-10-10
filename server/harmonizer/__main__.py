"""Command line: python -m harmonizer build."""
from __future__ import annotations

import argparse


def main() -> None:
    parser = argparse.ArgumentParser(prog="harmonizer", description="Build Concord's warehouse from the source feeds.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build", help="load the feeds and build the warehouse, catalog, quality results and marts")
    parser.parse_args()

    from .pipeline import build
    build()


if __name__ == "__main__":
    main()
