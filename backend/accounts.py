"""Accounts, roles and sign-in: who is asking, which role their account holds, and what that role is granted.

An account holds exactly one role. A role is a name for a set of grants, plus whether it may
manage accounts and roles. Both are data here, so an administrator can create and edit them.
What a grant lets someone read is not decided here: that is the policy
(`harmonizer/policy.py`), and it is enforced by the database built for that set of grants. This
module only answers "whose request is this, and which grants does their role hold?".

Accounts and roles are kept in SQLite (`state/accounts.db`), not in the warehouse. `build/` is deleted and
recreated by every build, and sign-ins are small writes that can come from the server and a test
run at once, which DuckDB's one-writer file lock does not allow. SQLite is in the standard
library, so it adds no dependency.

No password is stored, only a salted PBKDF2-SHA256 hash of it. A session is a random token that
the browser holds in a cookie; only its SHA-256 is stored, so a copy of the database does not
let anyone sign in.

This is the one module that reads the real clock. Study data is frozen at the snapshot date, but
a sign-in happens today and a session has to end in real hours.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import lru_cache

from harmonizer import config, policy

SESSION_SECONDS = 12 * 3600
ROUNDS = 600_000
MIN_PASSWORD, MAX_PASSWORD = 8, 200
MAX_FAILURES, LOCKOUT_SECONDS = 5, 300
USERNAME = re.compile(r"[a-z0-9][a-z0-9._-]{1,31}")

# What an empty database starts with, so a clean clone can be signed in to. After that the database
# is what counts: editing these changes nothing for an install that already has roles or accounts.
STARTER_ROLES = {
    "clinops": {
        "name": "Clinical Operations Lead",
        "blurb": "Runs the study day to day. Blinded: must not learn who is on which treatment.",
        "grants": ["patient_level", "financial"],
    },
    "biostat": {
        "name": "Unblinded Statistician",
        "blurb": "Prepares the safety review for the independent monitoring committee. Sees treatment arms, not site contracts.",
        "grants": ["patient_level", "unblinded"],
    },
    "finance": {
        "name": "Site Payments Analyst",
        "blurb": "Pays the sites. Sees money and site-level counts, never individual participants.",
        "grants": ["financial"],
    },
    "admin": {
        "name": "Administrator",
        "blurb": "Looks after Concord itself. Holds every grant, and creates, changes and removes accounts and roles.",
        "grants": ["patient_level", "unblinded", "financial"],
        "manages_accounts": True,
    },
}
# The password is public (it is in the README): set CONCORD_STARTER_PASSWORD before the first start, or change it afterwards.
STARTERS = [("maya", "Maya", "clinops"), ("arjun", "Arjun", "biostat"), ("dana", "Dana", "finance"), ("admin", "Admin", "admin")]
STARTER_PASSWORD = "concord-demo"


def starter_password() -> str:
    return os.environ.get("CONCORD_STARTER_PASSWORD") or STARTER_PASSWORD

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    REAL NOT NULL,
    last_login_at REAL
);
CREATE TABLE IF NOT EXISTS roles (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    blurb            TEXT NOT NULL DEFAULT '',
    grants           TEXT NOT NULL,
    manages_accounts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    expires_at REAL NOT NULL
);
"""


class AccountError(Exception):
    """Something asked of an account that cannot be done. The message is shown to the person as written."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ----------------------------------------------------------------------------- the database
_ready: set[str] = set()
_failures: dict[str, list[float]] = {}  # username -> times of recent failed sign-ins. In memory: a restart clears it
_roles_cache: tuple[tuple, dict] | None = None  # (what the database file looked like, the roles read from it)


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(config.ACCOUNTS, timeout=5, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init() -> list[str]:
    """Create the accounts database when it is missing, and the starter roles and accounts when it holds none.

    Returns the usernames it created, which is an empty list on every start but the first.
    """
    path = str(config.ACCOUNTS)
    if path in _ready:
        return []
    config.ACCOUNTS.parent.mkdir(parents=True, exist_ok=True)
    con = _connect()
    created = []
    try:
        con.executescript(SCHEMA)
        os.chmod(config.ACCOUNTS, 0o600)
        empty = lambda table: not con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: E731
        if empty("roles") or empty("accounts"):
            rows = [(username, name, role, _hash(starter_password()), time.time()) for username, name, role in STARTERS] if empty("accounts") else []
            con.execute("BEGIN IMMEDIATE")  # another process may have got here first, so look again under the lock
            if empty("roles"):
                con.executemany("INSERT INTO roles (id, name, blurb, grants, manages_accounts) VALUES (?, ?, ?, ?, ?)",
                                [(role, r["name"], r["blurb"], json.dumps(r["grants"]), int(r.get("manages_accounts", False))) for role, r in STARTER_ROLES.items()])
            if rows and empty("accounts"):
                con.executemany("INSERT INTO accounts (username, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", rows)
                created = [row[0] for row in rows]
            con.execute("COMMIT")
    finally:
        con.close()
    _ready.add(path)
    return created


@contextmanager
def _db(write: bool = False):
    """A connection for one short piece of work.

    With `write`, the lock is taken at the start and everything is committed together or not at
    all, so a check and the change that depends on it cannot be split by another request.
    """
    global _roles_cache
    init()
    con = _connect()
    try:
        if write:
            con.execute("BEGIN IMMEDIATE")
        yield con
        if write:
            con.execute("COMMIT")
    except BaseException:
        if con.in_transaction:
            con.execute("ROLLBACK")
        raise
    finally:
        con.close()
        if write:
            _roles_cache = None


def _get(con: sqlite3.Connection, account_id: int) -> sqlite3.Row:
    row = con.execute("SELECT * FROM accounts WHERE id = ?", [account_id]).fetchone()
    if row is None:
        raise AccountError("That account no longer exists.", 404)
    return row


def _stamp(t: float | None) -> str | None:
    return None if t is None else datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")


def _public(row: sqlite3.Row) -> dict:
    """An account as a client may see it: everything but the password hash."""
    return {"id": row["id"], "username": row["username"], "name": row["name"], "role": row["role"], "active": bool(row["active"]),
            "created_at": _stamp(row["created_at"]), "last_login_at": _stamp(row["last_login_at"])}


# ----------------------------------------------------------------------------- passwords and tokens
def _hash(password: str, salt: bytes | None = None, rounds: int = ROUNDS) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds)
    return f"pbkdf2_sha256${rounds}${salt.hex()}${digest.hex()}"


def _matches(password: str, stored: str) -> bool:
    _, rounds, salt, _ = stored.split("$")
    return hmac.compare_digest(_hash(password, bytes.fromhex(salt), int(rounds)), stored)


@lru_cache(maxsize=1)
def _decoy() -> str:
    """A hash to check against when there is no such account, so that takes as long as a wrong password does."""
    return _hash(secrets.token_urlsafe(16))


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ----------------------------------------------------------------------------- what an account may hold
def _valid_name(name: str) -> str:
    name = " ".join(name.split())
    if not 1 <= len(name) <= 60:
        raise AccountError("A name must be between 1 and 60 characters.")
    return name


def _valid_username(username: str) -> str:
    username = username.strip().lower()
    if not USERNAME.fullmatch(username):
        raise AccountError("A username is 2 to 32 characters: lower-case letters, digits, dots, hyphens and underscores, starting with a letter or a digit.")
    return username


def _valid_password(password: str) -> str:
    if not MIN_PASSWORD <= len(password) <= MAX_PASSWORD:
        raise AccountError(f"A password must be between {MIN_PASSWORD} and {MAX_PASSWORD} characters.")
    return password


def _valid_blurb(blurb: str) -> str:
    blurb = " ".join(blurb.split())
    if len(blurb) > 300:
        raise AccountError("A role's description can be at most 300 characters.")
    return blurb


def _valid_grants(grants: list[str]) -> list[str]:
    unknown = [g for g in grants if g not in policy.TAGS]
    if unknown:
        raise AccountError(f"There is no tag called {unknown[0]!r}.")
    return [t for t in policy.TAGS if t in grants]


def _role_row(con: sqlite3.Connection, role: str, status: int = 404) -> sqlite3.Row:
    row = con.execute("SELECT * FROM roles WHERE id = ?", [role]).fetchone()
    if row is None:
        raise AccountError(f"There is no role with the id {role!r}.", status)
    return row


def _keep_an_administrator(con: sqlite3.Connection) -> None:
    """Refuse a change that leaves nobody able to manage accounts.

    Called after the change, inside its transaction, so raising here undoes it. It covers every
    way of getting there: removing, deactivating or re-roling an account, or editing a role.
    """
    left = con.execute("SELECT count(*) FROM accounts a JOIN roles r ON r.id = a.role WHERE a.active = 1 AND r.manages_accounts = 1").fetchone()[0]
    if not left:
        raise AccountError("That would leave no active account able to manage accounts. Give another active account that ability first.", 409)


# ----------------------------------------------------------------------------- roles
def _role(row: sqlite3.Row) -> dict:
    """A role as the rest of Concord uses it. Grants are kept in the order of `policy.TAGS`; a tag that no longer exists is dropped."""
    held = json.loads(row["grants"])
    return {"name": row["name"], "blurb": row["blurb"], "grants": [t for t in policy.TAGS if t in held], "manages_accounts": bool(row["manages_accounts"])}


def roles() -> dict[str, dict]:
    """Every role by id, in the order they were created. Do not change what it returns: it is shared.

    Asked many times per request, so it is read from the database only when the file has changed
    (or this process has just written to it), the way the catalog is reloaded after a build.
    """
    global _roles_cache
    init()
    stat = config.ACCOUNTS.stat()
    seen = (str(config.ACCOUNTS), stat.st_mtime_ns, stat.st_size)
    cached = _roles_cache
    if cached is None or cached[0] != seen:
        with _db() as con:
            cached = _roles_cache = (seen, {r["id"]: _role(r) for r in con.execute("SELECT * FROM roles ORDER BY rowid").fetchall()})
    return cached[1]


def create_role(name: str, blurb: str = "", grants: list[str] | None = None, manages_accounts: bool = False) -> dict:
    """Add a role. Its id is made from its name and never changes afterwards, so accounts keep pointing at it when it is renamed."""
    name, blurb, grants = _valid_name(name), _valid_blurb(blurb), _valid_grants(grants or [])
    stem = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "role"
    with _db(write=True) as con:
        taken = {r[0] for r in con.execute("SELECT id FROM roles").fetchall()}
        role = next(candidate for candidate in [stem, *(f"{stem}_{n}" for n in range(2, len(taken) + 3))] if candidate not in taken)
        try:
            con.execute("INSERT INTO roles (id, name, blurb, grants, manages_accounts) VALUES (?, ?, ?, ?, ?)",
                        [role, name, blurb, json.dumps(grants), int(manages_accounts)])
        except sqlite3.IntegrityError:
            raise AccountError(f"There is already a role called {name}.", 409) from None
        return {"id": role, **_role(_role_row(con, role))}


def update_role(role: str, name: str | None = None, blurb: str | None = None, grants: list[str] | None = None,
                manages_accounts: bool | None = None) -> dict:
    """Change a role. Whatever is left as None stays as it is.

    Nobody is signed out: every request reads its role's grants afresh, so the change reaches
    everyone who holds the role on their next request.
    """
    changes: dict = {}
    if name is not None:
        changes["name"] = _valid_name(name)
    if blurb is not None:
        changes["blurb"] = _valid_blurb(blurb)
    if grants is not None:
        changes["grants"] = json.dumps(_valid_grants(grants))
    if manages_accounts is not None:
        changes["manages_accounts"] = int(manages_accounts)
    with _db(write=True) as con:
        _role_row(con, role)
        if changes:
            try:
                con.execute(f"UPDATE roles SET {', '.join(f'{column} = ?' for column in changes)} WHERE id = ?", [*changes.values(), role])
            except sqlite3.IntegrityError:
                raise AccountError(f"There is already a role called {changes['name']}.", 409) from None
            _keep_an_administrator(con)
        return {"id": role, **_role(_role_row(con, role))}


def delete_role(role: str) -> None:
    """Remove a role that no account holds."""
    with _db(write=True) as con:
        _role_row(con, role)
        held = con.execute("SELECT count(*) FROM accounts WHERE role = ?", [role]).fetchone()[0]
        if held:
            raise AccountError(f"{held} account{' holds' if held == 1 else 's hold'} this role. Give {'it' if held == 1 else 'them'} another role first.", 409)
        con.execute("DELETE FROM roles WHERE id = ?", [role])


# ----------------------------------------------------------------------------- signing in and out
def sign_in(username: str, password: str) -> tuple[str, dict]:
    """Check a username and password and start a session. Returns the session token and the account.

    An unknown username, a wrong password and a deactivated account all get the same answer, so
    the reply does not say which usernames exist. Five failures for one username lock it for
    five minutes.
    """
    wrong = AccountError("That username and password do not match an account.", 401)
    username, now = username.strip().lower(), time.time()
    if not USERNAME.fullmatch(username) or len(password) > MAX_PASSWORD:
        raise wrong
    recent = [t for t in _failures.get(username, []) if now - t < LOCKOUT_SECONDS]
    if len(recent) >= MAX_FAILURES:
        raise AccountError("Too many failed sign-ins for this username. Wait five minutes and try again.", 429)
    with _db() as con:
        row = con.execute("SELECT * FROM accounts WHERE username = ? AND active = 1", [username]).fetchone()
    if not _matches(password, row["password_hash"] if row else _decoy()) or row is None:
        _failures[username] = recent + [now]
        raise wrong
    _failures.pop(username, None)
    token = secrets.token_urlsafe(32)
    with _db(write=True) as con:
        if not _get(con, row["id"])["active"]:
            raise wrong
        con.execute("DELETE FROM sessions WHERE expires_at < ?", [now])
        con.execute("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)", [_digest(token), row["id"], now + SESSION_SECONDS])
        con.execute("UPDATE accounts SET last_login_at = ? WHERE id = ?", [now, row["id"]])
        return token, _public(_get(con, row["id"]))


def account_for(token: str | None) -> dict | None:
    """The active account a session token belongs to, or None when the token is missing, unknown or expired.

    Read on every request, so a change of role or a deactivation takes effect at once.
    """
    if not token:
        return None
    with _db() as con:
        row = con.execute("""SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
                             WHERE s.token_hash = ? AND s.expires_at > ? AND a.active = 1""", [_digest(token), time.time()]).fetchone()
    return _public(row) if row else None


def sign_out(token: str | None) -> None:
    if token:
        with _db(write=True) as con:
            con.execute("DELETE FROM sessions WHERE token_hash = ?", [_digest(token)])


# ----------------------------------------------------------------------------- managing accounts
def list_accounts() -> list[dict]:
    with _db() as con:
        return [_public(r) for r in con.execute("SELECT * FROM accounts ORDER BY name COLLATE NOCASE, username").fetchall()]


def create(username: str, name: str, role: str, password: str) -> dict:
    username = _valid_username(username)
    values = [username, _valid_name(name), role, _hash(_valid_password(password)), time.time()]
    with _db(write=True) as con:
        _role_row(con, role, 400)
        try:
            cur = con.execute("INSERT INTO accounts (username, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", values)
        except sqlite3.IntegrityError:
            raise AccountError(f"The username {username} is already taken.", 409) from None
        return _public(_get(con, cur.lastrowid))


def update(account_id: int, name: str | None = None, username: str | None = None, role: str | None = None,
           active: bool | None = None, password: str | None = None) -> dict:
    """Change an account's details. Whatever is left as None stays as it is.

    A new password or a deactivation signs the account out everywhere. A change of role needs no
    such step, because the role is read from the account on every request.
    """
    changes: dict = {}
    if name is not None:
        changes["name"] = _valid_name(name)
    if username is not None:
        changes["username"] = _valid_username(username)
    if role is not None:
        changes["role"] = role
    if active is not None:
        changes["active"] = int(active)
    if password is not None:
        changes["password_hash"] = _hash(_valid_password(password))
    with _db(write=True) as con:
        _get(con, account_id)
        if "role" in changes:
            _role_row(con, changes["role"], 400)
        if changes:
            try:
                con.execute(f"UPDATE accounts SET {', '.join(f'{column} = ?' for column in changes)} WHERE id = ?", [*changes.values(), account_id])
            except sqlite3.IntegrityError:
                raise AccountError(f"The username {changes['username']} is already taken.", 409) from None
            _keep_an_administrator(con)
        after = _get(con, account_id)
        if "password_hash" in changes or not after["active"]:
            con.execute("DELETE FROM sessions WHERE account_id = ?", [account_id])
        return _public(after)


def change_password(account_id: int, current: str, new: str, keep: str | None = None) -> None:
    """Change your own password, after proving the current one.

    Every other session of the account is signed out. `keep` is the token of the session making
    the change, which stays signed in.
    """
    new = _valid_password(new)
    with _db() as con:
        row = _get(con, account_id)
    if len(current) > MAX_PASSWORD or not _matches(current, row["password_hash"]):
        raise AccountError("The current password is not right.", 403)
    hashed = _hash(new)
    with _db(write=True) as con:
        con.execute("UPDATE accounts SET password_hash = ? WHERE id = ?", [hashed, account_id])
        con.execute("DELETE FROM sessions WHERE account_id = ? AND token_hash != ?", [account_id, _digest(keep or "")])


def delete(account_id: int) -> None:
    """Remove an account and its sessions. The last active account that can manage accounts cannot be removed."""
    with _db(write=True) as con:
        _get(con, account_id)
        con.execute("DELETE FROM accounts WHERE id = ?", [account_id])
        _keep_an_administrator(con)
