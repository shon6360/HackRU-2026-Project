"""Command line: python -m backend serve | ask."""
from __future__ import annotations

import argparse
import json

from harmonizer import config, policy


def _build_if_missing(verbose: bool = True) -> None:
    """Run the harmonizer pipeline when `build/warehouse.duckdb` is not there yet.

    `serve` and `ask` only build on first use. After changing a model, a feed, a quality
    rule or the policy, rebuild yourself with `python -m harmonizer build`.
    """
    if not config.WAREHOUSE.exists():
        from harmonizer.pipeline import build
        build(verbose=verbose)


def main() -> None:
    """CLI entry point: `python -m backend serve` or `python -m backend ask QUESTION`.

    Both commands build the warehouse first when it is missing. `serve` starts the FastAPI
    app; `ask` prints the result JSON for one question and role.
    """
    parser = argparse.ArgumentParser(prog="backend", description="One question across every clinical trial system.")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="start the web app")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8040)
    ask = sub.add_parser("ask", help="ask a question from the terminal")
    ask.add_argument("question")
    ask.add_argument("--role", default="clinops", choices=list(policy.ROLES))
    args = parser.parse_args()

    if args.command == "serve":
        import uvicorn

        _build_if_missing()
        print(f"\nConcord is running at http://{args.host}:{args.port}\n")
        uvicorn.run("backend.server:app", host=args.host, port=args.port, log_level="warning")
    elif args.command == "ask":
        from .ask import ask as run_ask
        _build_if_missing(verbose=False)
        print(json.dumps(run_ask(args.question, args.role), indent=1, default=str))


if __name__ == "__main__":
    main()
