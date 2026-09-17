"""
Role resolution.

Not an identity system: there are no passwords and no user records. What it does
provide is a role claim the client cannot forge. The role travels in an
HMAC-signed cookie, is re-verified on every request, and is the only thing the
`.conca` engine consults when deciding which agents a caller may dispatch. The
frontend router mirrors the role for layout purposes and is never trusted for
enforcement.

The honest framing for a defence: authentication is stubbed, authorisation is
real. Swapping in OAuth means replacing `login` — every downstream check keeps
working untouched, because they only ever read the verified role.

**Where the trust boundary actually is.** There used to be a council PIN in front
of the staff role, and it was theatre: `POST /api/auth/login` would mint a staff
cookie for anybody who asked, so the PIN was a locked door standing next to an
open one. Removing it changed nothing an attacker could reach, and closing
`login` to remote callers changed a great deal.

What replaces it is the machine boundary. A caller on the loopback interface is
the person sitting at this keyboard, and that person already owns `.env`, `.conca`
and the SQLite file — they can grant themselves anything with a text editor, so a
secret asked of them protects nothing and costs a step on every fresh profile. A
caller from anywhere else gets `public` and cannot escalate, which is strictly
tighter than the PIN era. `CONCA_OPEN_ROLE` is the deliberate, auditable opt-out
for the one legitimate remote case: the phone wrapper on a network you trust.
"""

from __future__ import annotations

import hmac
import os
import secrets
from hashlib import sha256
from typing import Literal

from fastapi import Cookie, Depends, HTTPException, Request

Role = Literal["public", "student", "staff"]

VALID_ROLES: tuple[Role, ...] = ("public", "student", "staff")
COOKIE_NAME = "conca_role"

# Remote callers with no cookie are the public tier rather than rejected — that
# tier is the "busy masses" surface and is meant to need no login. Its `.conca`
# grant list is correspondingly minimal.
DEFAULT_ROLE: Role = "public"

# What a loopback caller gets. The operator of the machine is the owner of the
# machine; see the module docstring.
LOCAL_ROLE: Role = "staff"

# `::ffff:127.0.0.1` is how a v4 loopback address arrives on a dual-stack socket,
# which is the default on Windows and would otherwise read as remote.
_LOOPBACK_HOSTS = frozenset(
    {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1", "testclient"}
)


def is_local(request: Request | None) -> bool:
    """
    Whether the request came from this machine.

    Read from the socket's peer address only. `X-Forwarded-For` and friends are
    deliberately ignored: they are set by whoever is calling, so trusting one would
    hand every remote caller the local role by adding a header — which is precisely
    the forgery the signed cookie exists to prevent.
    """
    if request is None or request.client is None:
        return False
    return request.client.host in _LOOPBACK_HOSTS


def _remote_role() -> Role:
    """
    The role granted to a remote caller with no cookie.

    `public` unless `CONCA_OPEN_ROLE` names another, which is how the phone wrapper
    reaches the staff surface over a LAN. An invalid value falls back to `public`
    rather than raising: a typo in an env var must not decide a permission upward,
    and must not take the server down either.
    """
    want = os.environ.get("CONCA_OPEN_ROLE", "").strip().lower()
    return want if want in VALID_ROLES else DEFAULT_ROLE  # type: ignore[return-value]


def _load_secret() -> bytes:
    """
    Signing key.

    A generated key means cookies do not survive a restart, which is a nuisance
    in development and a footgun in a deployment that expects sessions to
    persist — hence the explicit warning rather than a silent fallback.
    """
    env = os.environ.get("CONCA_SECRET", "").strip()
    if env:
        return env.encode("utf-8")
    generated = secrets.token_hex(32)
    print(
        "[auth] CONCA_SECRET not set — generated an ephemeral signing key. "
        "Role cookies will be invalidated on restart. Set CONCA_SECRET in .env "
        "to make sessions durable."
    )
    return generated.encode("utf-8")


_SECRET = _load_secret()


def _sign(payload: str) -> str:
    return hmac.new(_SECRET, payload.encode("utf-8"), sha256).hexdigest()[:32]


def make_cookie(username: str, role: Role) -> str:
    """Build the signed cookie value for a user and role."""
    if role not in VALID_ROLES:
        raise ValueError(f"unknown role: {role}")
    payload = f"{username}:{role}"
    return f"{payload}.{_sign(payload)}"


def verify_cookie(raw: str | None) -> tuple[str, Role] | None:
    """
    Recover the (username, role) from a cookie, or None if absent/tampered.
    """
    if not raw or "." not in raw:
        return None
    payload, _, signature = raw.rpartition(".")
    if ":" not in payload:
        # Legacy cookie without username
        role = payload
        if role in VALID_ROLES and hmac.compare_digest(signature, _sign(role)):
            return ("legacy_user", role)  # type: ignore[return-value]
        return None
    
    username, _, role = payload.rpartition(":")
    if role not in VALID_ROLES:
        return None
    if not hmac.compare_digest(signature, _sign(payload)):
        return None
    return username, role  # type: ignore[return-value]


async def current_session(
    request: Request,
    conca_role: str | None = Cookie(default=None, alias=COOKIE_NAME),
) -> tuple[str | None, Role]:
    """
    FastAPI dependency: returns (username, verified_role).
    """
    from_cookie = verify_cookie(conca_role)
    if from_cookie is not None:
        return from_cookie
    
    # Check if profiles.json exists. If it exists, they MUST login to get a staff role.
    profiles_path = os.path.join(os.path.dirname(__file__), "..", "profiles.json")
    if os.path.exists(profiles_path):
        return None, _remote_role()  # Forced to login/public

    # Fallback to local auto-staff if no profiles exist yet (first-time onboarding)
    auto_role = LOCAL_ROLE if is_local(request) else _remote_role()
    auto_name = None
    if auto_role == LOCAL_ROLE:
        profile_file = os.path.join(os.path.dirname(__file__), "..", "user_profile.json")
        if os.path.exists(profile_file):
            try:
                import json
                with open(profile_file, "r", encoding="utf-8") as f:
                    p_data = json.loads(f.read())
                    auto_name = p_data.get("name")
            except Exception:
                pass
    return auto_name, auto_role

async def current_role(request: Request, session: tuple[str | None, Role] = Depends(current_session)) -> Role:
    return session[1]

async def current_user(request: Request, session: tuple[str | None, Role] = Depends(current_session)) -> str | None:
    return session[0]


def require_staff(role: Role) -> Role:
    """Guard for endpoints that only make sense for the staff surface."""
    if role != "staff":
        raise HTTPException(
            status_code=403,
            detail=f'This endpoint requires the staff role; caller is "{role}"',
        )
    return role


def require_local(request: Request) -> None:
    """
    Guard for endpoints that may only be driven from this machine.

    Used by the two routes that change what the process is allowed to do — role
    selection and credential writing. Both are safe in the hands of whoever owns
    the filesystem and neither is safe over a network, and that distinction is a
    property of where the packet came from, not of anything the caller can assert.
    """
    if not is_local(request):
        raise HTTPException(
            status_code=403,
            detail=(
                "This endpoint is restricted to the machine running the server. "
                "Open the app locally to change it."
            ),
        )
