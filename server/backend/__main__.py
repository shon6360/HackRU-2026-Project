"""Command line: python -m backend build | serve | ask."""
from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess

from harmonizer import config


def _build_if_missing(verbose: bool = True) -> None:
    """Run the harmonizer pipeline when `build/warehouse.duckdb` is not there yet.

    `serve` and `ask` only build on first use. After changing a model, a feed, a quality
    rule or the policy, rebuild yourself with `python -m harmonizer build`.
    """
    if not config.WAREHOUSE.exists():
        from harmonizer.pipeline import build
        build(verbose=verbose)


def _build_web() -> None:
    """Build the web app into `client/out` with npm, installing its packages first when they are missing."""
    client = config.ROOT.parent / "client"
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("\nThe web app was not built, because npm was not found. Install Node.js 20.9 or newer and run this again.")
    steps = [["run", "build"]] if (client / "node_modules").is_dir() else [["install"], ["run", "build"]]
    for step in steps:
        print(f"\nWeb app: npm {' '.join(step)}", flush=True)
        if subprocess.run([npm, *step], cwd=client).returncode != 0:
            raise SystemExit(f"\nThe web app was not built: npm {' '.join(step)} failed. Its output is above.")


def _lan_address() -> str | None:
    """This computer's address on its network, which is what another computer's browser opens."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # picks the outgoing interface; a UDP socket sends nothing by connecting
            return probe.getsockname()[0]
    except OSError:
        return None


def _announce(host: str, port: int) -> None:
    """Say where Concord is listening and who can open it."""
    if host in ("127.0.0.1", "localhost", "::1"):
        print(f"\nConcord is running at http://{host}:{port}, for this computer only.\n"
              "To let other computers open it, start it with:  python -m backend serve --host 0.0.0.0\n")
        return
    address = (_lan_address() if host in ("0.0.0.0", "::") else host) or "<this computer's address>"
    print(f"\nConcord is running. From this or another computer, open:  http://{address}:{port}\n"
          "Anyone who can reach that address can try to sign in, and the starter accounts' password is public: change it first.\n")


def main() -> None:
    """CLI entry point: `python -m backend build`, `serve` or `ask QUESTION`.

    `build` makes everything the server needs: the warehouse (the harmonizer's pipeline) and the
    web app (npm, in `client/`). `serve` and `ask` build the warehouse first when it is missing.
    `serve` starts the FastAPI app, which serves the API and the built web app from one address;
    `ask` prints the result JSON for one question and role.
    """
    parser = argparse.ArgumentParser(prog="backend", description="One question across every clinical trial system.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build", help="build the warehouse and the web app")
    serve = sub.add_parser("serve", help="start Concord: the API and the web app, on one address")
    serve.add_argument("--host", default="127.0.0.1", help="the address to listen on. 0.0.0.0 lets other computers open Concord (default: 127.0.0.1, this computer only)")
    serve.add_argument("--port", type=int, default=8040)
    ask = sub.add_parser("ask", help="ask a question from the terminal")
    ask.add_argument("question")
    ask.add_argument("--role", default="clinops", help="the id of the role to ask as (default: clinops)")
    args = parser.parse_args()

    if args.command == "build":
        from harmonizer.pipeline import build
        build()
        _build_web()
    elif args.command == "serve":
        import uvicorn

        from . import accounts
        from .server import WEB

        _build_if_missing()
        starters = accounts.init()
        if starters:
            print(f"\nCreated the starter accounts: {', '.join(starters)}. The README gives their password. Change it once you have signed in.")
        if not WEB.is_dir():
            print("\nThe web app has not been built yet, so only the API will be served.\n"
                  "Build it once with:  python -m backend build")
        _announce(args.host, args.port)
        uvicorn.run("backend.server:app", host=args.host, port=args.port, log_level="warning")
    elif args.command == "ask":
        from . import accounts
        from .ask import ask as run_ask
        _build_if_missing(verbose=False)
        if args.role not in accounts.roles():
            parser.error(f"there is no role with the id {args.role!r}. The roles are: {', '.join(accounts.roles())}")
        print(json.dumps(run_ask(args.question, args.role), indent=1, default=str))


if __name__ == "__main__":
    main()
