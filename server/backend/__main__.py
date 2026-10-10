"""Command line: python -m backend build | serve | ask."""
from __future__ import annotations

import argparse
import json
import socket

from harmonizer import config


def _build_if_missing(verbose: bool = True) -> None:
    """Run the harmonizer pipeline when `build/warehouse.duckdb` is not there yet.

    `serve` and `ask` only build on first use. After changing a model, a feed, a quality
    rule or the policy, rebuild yourself with `python -m harmonizer build`.
    """
    if not config.WAREHOUSE.exists():
        from harmonizer.pipeline import build
        build(verbose=verbose)


def _lan_address() -> str | None:
    """This computer's address on its network, which is what a client on another computer connects to."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # picks the outgoing interface; a UDP socket sends nothing by connecting
            return probe.getsockname()[0]
    except OSError:
        return None


def _announce(host: str, port: int) -> None:
    """Say where the server is listening and what a client needs to reach it."""
    if host in ("127.0.0.1", "localhost", "::1"):
        print(f"\nThe Concord server is running at http://{host}:{port}, for clients on this computer only.\n"
              "To let other computers connect, start it with:  python -m backend serve --host 0.0.0.0")
    else:
        open_to_all = host in ("0.0.0.0", "::")
        address = (_lan_address() if open_to_all else host) or "<this computer's address>"
        print(f"\nThe Concord server is running on port {port}" + (", for every computer that can reach this one." if open_to_all else f" at {host}."))
        print(f"A client on another computer connects with:  CONCORD_SERVER=http://{address}:{port}")
        print("Anyone who can reach this address can try to sign in, and the starter accounts' password is public: change it first.")
    print("The web app is the client. Start it from the client/ folder with:  npm start\n")


def main() -> None:
    """CLI entry point: `python -m backend build`, `serve` or `ask QUESTION`.

    `build` runs the harmonizer's pipeline, which makes everything the server reads. `serve` and
    `ask` run it first when the warehouse is missing. `serve` starts the API; the web app is the
    client in `client/`, which is built and started by itself, on this computer or another.
    `ask` prints the result JSON for one question and role.
    """
    parser = argparse.ArgumentParser(prog="backend", description="One question across every clinical trial system.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build", help="build the warehouse and the databases the server reads")
    serve = sub.add_parser("serve", help="start the server that clients connect to")
    serve.add_argument("--host", default="127.0.0.1", help="the address to listen on. 0.0.0.0 lets other computers connect (default: 127.0.0.1, this computer only)")
    serve.add_argument("--port", type=int, default=8040)
    ask = sub.add_parser("ask", help="ask a question from the terminal")
    ask.add_argument("question")
    ask.add_argument("--role", default="clinops", help="the id of the role to ask as (default: clinops)")
    args = parser.parse_args()

    if args.command == "build":
        from harmonizer.pipeline import build
        build()
    elif args.command == "serve":
        import uvicorn

        from . import accounts

        _build_if_missing()
        starters = accounts.init()
        if starters:
            print(f"\nCreated the starter accounts: {', '.join(starters)}. The README gives their password. Change it once you have signed in.")
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
