"""Command line: python -m backend build | serve | ask."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess

from harmonizer import config, policy


def _build_if_missing(verbose: bool = True) -> None:
    """Run the harmonizer pipeline when `build/warehouse.duckdb` is not there yet.

    `serve` and `ask` only build on first use. After changing a model, a feed, a quality
    rule or the policy, rebuild yourself with `python -m harmonizer build`.
    """
    if not config.WAREHOUSE.exists():
        from harmonizer.pipeline import build
        build(verbose=verbose)


def _build_web() -> None:
    """Build the web app into `frontend/out` with npm, installing its packages first when they are missing."""
    frontend = config.ROOT / "frontend"
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("\nThe web app was not built, because npm was not found. Install Node.js 20.9 or newer and run this again.")
    steps = [["run", "build"]] if (frontend / "node_modules").is_dir() else [["install"], ["run", "build"]]
    for step in steps:
        print(f"\nWeb app: npm {' '.join(step)}", flush=True)
        if subprocess.run([npm, *step], cwd=frontend).returncode != 0:
            raise SystemExit(f"\nThe web app was not built: npm {' '.join(step)} failed. Its output is above.")


def main() -> None:
    """CLI entry point: `python -m backend build`, `serve` or `ask QUESTION`.

    `build` makes everything the server needs: the warehouse (the harmonizer's pipeline) and the
    web app (npm). `serve` and `ask` build the warehouse first when it is missing. `serve` starts
    the FastAPI app; `ask` prints the result JSON for one question and role.
    """
    parser = argparse.ArgumentParser(prog="backend", description="One question across every clinical trial system.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build", help="build the warehouse and the web app")
    serve = sub.add_parser("serve", help="start the web app")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8040)
    ask = sub.add_parser("ask", help="ask a question from the terminal")
    ask.add_argument("question")
    ask.add_argument("--role", default="clinops", choices=list(policy.ROLES))
    args = parser.parse_args()

    if args.command == "build":
        from harmonizer.pipeline import build
        build()
        _build_web()
    elif args.command == "serve":
        import uvicorn

        from .server import WEB

        _build_if_missing()
        if not WEB.is_dir():
            print("\nThe web app has not been built yet, so only the API will be served.\n"
                  "Build it once with:  python -m backend build")
        print(f"\nConcord is running at http://{args.host}:{args.port}\n")
        uvicorn.run("backend.server:app", host=args.host, port=args.port, log_level="warning")
    elif args.command == "ask":
        from .ask import ask as run_ask
        _build_if_missing(verbose=False)
        print(json.dumps(run_ask(args.question, args.role), indent=1, default=str))


if __name__ == "__main__":
    main()
