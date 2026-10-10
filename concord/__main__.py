"""Command line: python -m concord build | serve | ask."""
from __future__ import annotations

import argparse
import json


def main() -> None:
    parser = argparse.ArgumentParser(prog="concord", description="One question across every clinical trial system.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build", help="load the feeds and build the warehouse, catalog, quality results and role marts")
    serve = sub.add_parser("serve", help="start the web app")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8040)
    ask = sub.add_parser("ask", help="ask a question from the terminal")
    ask.add_argument("question")
    ask.add_argument("--role", default="clinops")
    args = parser.parse_args()

    if args.command == "build":
        from .pipeline import build
        build()
    elif args.command == "serve":
        import uvicorn

        from . import config
        if not config.WAREHOUSE.exists():
            from .pipeline import build
            build()
        print(f"\nConcord is running at http://{args.host}:{args.port}\n")
        uvicorn.run("concord.server:app", host=args.host, port=args.port, log_level="warning")
    elif args.command == "ask":
        from .ask import ask as run_ask
        print(json.dumps(run_ask(args.question, args.role), indent=1, default=str))


if __name__ == "__main__":
    main()
