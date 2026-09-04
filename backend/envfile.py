"""
`.env` as an editable surface, so accounts can be connected from onboarding.

Every integration in this app is configured by an environment variable, and until
now the only way to set one was to open `backend/.env` in an editor and restart.
That is a fine contract for a deployment and a bad one for a person who has just
been shown four onboarding slides and told the system can read their mail.

Two properties make this safe enough to expose:

**Writes are confined to a catalogue.** `CATALOGUE` below is the complete set of
keys this module will touch. Anything else is refused, which is what keeps the
endpoint from being a general-purpose "set any environment variable" primitive.
`PYTHON_EXE` is deliberately *absent* from it: that variable names the interpreter
`python_execute` shells out to, so writing it from the UI would be a path to
arbitrary code execution that the policy engine never sees. Same reasoning excludes
`CONCA_OPEN_ROLE` — a control over who may reach this endpoint must not itself be
settable through it.

**Values are write-only.** `status()` reports whether a key is set and, for
secrets, the last four characters. It never returns a value, because the whole
point of putting keys in a file outside the bundle is that the browser never holds
them. A UI that can display your Twilio token has re-created the problem.

Edits are applied to `os.environ` as well as to the file. `tools._env` and
`rotator._key_configured` both read the environment at call time rather than at
import, so a key pasted into onboarding is live on the next request with no
restart. `CONCA_SECRET` is the documented exception — `auth.py` reads it once at
import — and is flagged `restart=True` so the UI can say so instead of leaving the
user to wonder why nothing changed.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

ENV_PATH = Path(__file__).resolve().parent / ".env"

#: Values are single-line assignments; a newline would smuggle in a second one.
_FORBIDDEN = ("\n", "\r", "\0")

#: Long enough for any real credential (Google refresh tokens are the longest
#: thing here at a few hundred bytes) and short enough that the file cannot be
#: used as a data store.
MAX_VALUE_LEN = 4096

GroupState = Literal["off", "partial", "on"]


@dataclass(frozen=True)
class EnvField:
    key: str
    label: str
    #: Masked in the UI and never echoed back. False for identifiers and URLs that
    #: are useful to see confirmed — a base URL you cannot read is a base URL you
    #: cannot check for a typo.
    secret: bool = True
    #: Counts toward the group's `on` state.
    required: bool = False
    placeholder: str = ""
    help: str = ""
    #: True when the process reads this once at import and cannot pick it up live.
    restart: bool = False


@dataclass(frozen=True)
class EnvGroup:
    id: str
    title: str
    blurb: str
    #: What the user gets in return. Written as a capability, not as a feature
    #: list, because the question being answered is "why would I paste a key here".
    unlocks: str
    fields: tuple[EnvField, ...]


CATALOGUE: tuple[EnvGroup, ...] = (
    EnvGroup(
        id="models",
        title="Model providers",
        blurb=(
            "The reasoning ladder is walked top-down and skips any provider whose "
            "key is missing, so one key is enough to start and each further key is "
            "another fallback when a free tier runs out."
        ),
        unlocks="Planning, decomposition, and every agent that has to think.",
        fields=(
            EnvField(
                key="GEMINI_API_KEY",
                label="Google Gemini",
                required=True,
                placeholder="AIza…",
                help=(
                    "The highest-leverage single key: eighteen ladder slots, and the "
                    "only provider wired for image input, which is what lets a screen "
                    "capture actually be read rather than guessed at."
                ),
            ),
            EnvField(
                key="GEMINI_API_KEY_2",
                label="Gemini — second project",
                help=(
                    "A separate Google project, not a second key for the same one. "
                    "Free-tier limits are per project, so this is how the original "
                    "survived a demo: three independent quotas for one model."
                ),
            ),
            EnvField(key="GEMINI_API_KEY_3", label="Gemini — third project"),
            EnvField(key="GROQ_API_KEY", label="Groq", help="Also powers voice dictation."),
            EnvField(
                key="OPENROUTER_API_KEY",
                label="OpenRouter",
                help="One key, 100+ models. The best second key to add.",
            ),
            EnvField(key="MISTRAL_API_KEY", label="Mistral"),
            EnvField(key="DEEPSEEK_API_KEY", label="DeepSeek"),
            EnvField(key="COHERE_API_KEY", label="Cohere"),
            EnvField(key="TOGETHER_API_KEY", label="Together"),
            EnvField(key="NVIDIA_API_KEY", label="NVIDIA NIM"),
            EnvField(key="GLM_API_KEY", label="Zhipu GLM"),
            EnvField(key="KIMI_API_KEY", label="Moonshot Kimi"),
            EnvField(key="HUGGINGFACE_API_KEY", label="Hugging Face"),
            EnvField(key="PERPLEXITY_API_KEY", label="Perplexity"),
            EnvField(
                key="ANTHROPIC_API_KEY",
                label="Anthropic",
                help=(
                    "Sits last on the ladder on purpose: it is the only provider here "
                    "with no free allowance, so it should be reached only once every "
                    "free tier above it has retired."
                ),
            ),
        ),
    ),
    EnvGroup(
        id="google",
        title="Email and calendar",
        blurb=(
            "A Google OAuth client plus a refresh token. All three are needed — the "
            "refresh token is the one that carries the consent, and the client pair "
            "is what it was issued against."
        ),
        unlocks="Reading your inbox, drafting replies, and real calendar events.",
        fields=(
            EnvField(key="GOOGLE_CLIENT_ID", label="Client ID", secret=False, required=True),
            EnvField(key="GOOGLE_CLIENT_SECRET", label="Client secret", required=True),
            EnvField(
                key="GOOGLE_REFRESH_TOKEN",
                label="Refresh token",
                required=True,
                help=(
                    "Issued once, offline access, scoped to Gmail and Calendar. Without "
                    "it the Email Hub reports not-connected and the calendar runs on "
                    "local SQLite alone."
                ),
            ),
        ),
    ),
    EnvGroup(
        id="twilio",
        title="Texting and calls",
        blurb=(
            "The account SID and auth token authenticate; a sender is what the "
            "message leaves from. A Messaging Service SID is preferred for texting "
            "because it survives renumbering, but voice has no equivalent, so placing "
            "a call needs a real number."
        ),
        unlocks="Sending SMS and placing voice calls — both behind the approval gate.",
        fields=(
            EnvField(
                key="TWILIO_ACCOUNT_SID",
                label="Account SID",
                secret=False,
                required=True,
                placeholder="AC…",
            ),
            EnvField(key="TWILIO_AUTH_TOKEN", label="Auth token", required=True),
            EnvField(
                key="TWILIO_PHONE_NUMBER",
                label="From number",
                secret=False,
                required=True,
                placeholder="+1…",
                help="E.164, with the country code. Required for calls.",
            ),
            EnvField(
                key="TWILIO_MESSAGING_SERVICE_SID",
                label="Messaging Service SID",
                secret=False,
                placeholder="MG…",
                help="Optional. Preferred for texting when you have one.",
            ),
        ),
    ),
    EnvGroup(
        id="research",
        title="Web research",
        blurb=(
            "Optional. Without a key, search falls back to a keyless DuckDuckGo "
            "scrape, which works and is brittle."
        ),
        unlocks="Clean, citable search results instead of scraped HTML.",
        fields=(EnvField(key="TAVILY_API_KEY", label="Tavily"),),
    ),
    EnvGroup(
        id="github",
        title="GitHub",
        blurb=(
            "Optional even for GitHub: public repositories work unauthenticated at 60 "
            "requests an hour, shared per machine by IP."
        ),
        unlocks="5000 requests an hour, and private repositories.",
        fields=(
            EnvField(
                key="GITHUB_TOKEN",
                label="Access token",
                placeholder="ghp_…",
                help=(
                    "Read-only `public_repo` is enough. There is no write path in this "
                    "app at all, so a token with write scope grants more than it can use."
                ),
            ),
        ),
    ),
    EnvGroup(
        id="social",
        title="Social publishing",
        blurb=(
            "Mastodon is the only platform wired for real sends, because it is the "
            "only one that needs nothing but a bearer token. X and LinkedIn store a "
            "draft and report published=false rather than pretending."
        ),
        unlocks="Publishing for real, once you approve the post.",
        fields=(
            EnvField(key="MASTODON_ACCESS_TOKEN", label="Access token"),
            EnvField(
                key="MASTODON_BASE_URL",
                label="Instance URL",
                secret=False,
                placeholder="https://mastodon.social",
                help="Defaults to mastodon.social. Set it to your own instance.",
            ),
        ),
    ),
    EnvGroup(
        id="browser",
        title="Remote browser",
        blurb=(
            "Optional. With neither set, the browser agent launches a local Chromium "
            "through Playwright, which is the normal case."
        ),
        unlocks="Driving a browser that lives somewhere other than this machine.",
        fields=(
            EnvField(
                key="BROWSER_WS_ENDPOINT",
                label="CDP websocket",
                secret=False,
                placeholder="ws://…",
            ),
            EnvField(key="BROWSERLESS_URL", label="Browserless URL", secret=False),
        ),
    ),
    EnvGroup(
        id="session",
        title="Session durability",
        blurb=(
            "Signs the role cookie. Left blank, a key is generated at each boot and "
            "every session is invalidated when the server restarts."
        ),
        unlocks="Staying signed in across restarts.",
        fields=(
            EnvField(
                key="CONCA_SECRET",
                label="Signing secret",
                restart=True,
                help=(
                    "Any long random string. Read once at import, so this one needs a "
                    "restart to take effect — everything else on this page is live "
                    "immediately."
                ),
            ),
        ),
    ),
)

#: Flattened for lookup. Writes outside this set are refused.
_FIELDS: dict[str, EnvField] = {f.key: f for g in CATALOGUE for f in g.fields}

WRITABLE_KEYS: frozenset[str] = frozenset(_FIELDS)


def _is_set(key: str) -> bool:
    """
    Whether a key counts as configured.

    A `YOUR_...` value is treated as absent, matching `tools._env` and
    `rotator._key_configured`. Six keys in the shipped `.env` are exactly that,
    and reporting them as connected would be a lie the ladder already disagrees
    with.
    """
    val = os.environ.get(key, "").strip()
    return bool(val) and not val.startswith("YOUR_")


def _hint(key: str, field: EnvField) -> str:
    """A glance-check that the right thing was pasted, without revealing it."""
    val = os.environ.get(key, "").strip()
    if not val or val.startswith("YOUR_"):
        return ""
    if not field.secret:
        return val
    return f"••••{val[-4:]}" if len(val) > 4 else "••••"


def _group_state(group: EnvGroup) -> GroupState:
    required = [f for f in group.fields if f.required]
    # A group with nothing required — GitHub, research, the remote browser — is on
    # as soon as anything in it is set, because that is what "optional" means here.
    gauge = required or list(group.fields)
    hits = sum(1 for f in gauge if _is_set(f.key))
    if hits == 0:
        return "off"
    return "on" if hits == len(gauge) else "partial"


def status() -> dict:
    """
    What is connected, for the setup UI. Contains no secret values.

    Read from `os.environ` rather than by re-parsing the file, because the
    environment is what the tools actually consult — if the two ever disagree, the
    environment is the truth and the file is a stale note. The one way they drift
    is a hand-edit made while the server is running, which a restart resolves.
    """
    return {
        "path": str(ENV_PATH),
        "writable": _writable(),
        "groups": [
            {
                "id": g.id,
                "title": g.title,
                "blurb": g.blurb,
                "unlocks": g.unlocks,
                "state": _group_state(g),
                "fields": [
                    {
                        "key": f.key,
                        "label": f.label,
                        "secret": f.secret,
                        "required": f.required,
                        "placeholder": f.placeholder,
                        "help": f.help,
                        "restart": f.restart,
                        "set": _is_set(f.key),
                        "hint": _hint(f.key, f),
                    }
                    for f in g.fields
                ],
            }
            for g in CATALOGUE
        ],
    }


def _writable() -> bool:
    """Whether saving can work at all, so the UI can say so before you type."""
    try:
        if ENV_PATH.exists():
            return os.access(ENV_PATH, os.W_OK)
        return os.access(ENV_PATH.parent, os.W_OK)
    except OSError:
        return False


def _quote(value: str) -> str:
    """
    Render a value as one assignment.

    Most credentials are bare tokens and are written unquoted, which keeps the file
    diffable by eye. Anything with a space or a `#` gets quoted, because dotenv
    treats an unquoted `#` as the start of a comment and would silently truncate
    the value at it.
    """
    if value == "":
        return ""
    if any(ch in value for ch in ' \t"\'#') or value != value.strip():
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def _line_re(key: str) -> re.Pattern[str]:
    return re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}\s*=", re.IGNORECASE)


def apply(values: dict[str, str]) -> dict:
    """
    Upsert `values` into `.env` and into the live environment.

    Line-oriented rather than parse-and-rewrite, for the same reason
    `/api/conca/save` takes text: a YAML or dotenv round-trip drops every comment,
    and the comments in `.env.example` are the documentation for what each key
    does. An existing assignment is replaced in place; a new key is appended under
    a header. Everything else in the file survives byte for byte.

    An empty value means *disconnect*: the assignment is blanked and the variable
    is removed from the environment. Being able to revoke a key from the same
    screen that set it is the difference between a settings page and a one-way
    funnel.

    Returns the keys that changed and the subset needing a restart. Raises
    `ValueError` on an unknown key or an unusable value — the caller turns that
    into a 400.
    """
    cleaned: dict[str, str] = {}
    for raw_key, raw_val in values.items():
        key = raw_key.strip().upper()
        if key not in _FIELDS:
            raise ValueError(f"{raw_key} is not a settable key")
        val = (raw_val or "").strip()
        if any(ch in val for ch in _FORBIDDEN):
            raise ValueError(f"{key} may not contain a line break")
        if len(val) > MAX_VALUE_LEN:
            raise ValueError(f"{key} is longer than {MAX_VALUE_LEN} characters")
        # A pasted placeholder is a no-op rather than an error: it is what the
        # shipped file already contains, and writing it back would only look like
        # progress.
        if val.startswith("YOUR_"):
            val = ""
        cleaned[key] = val

    if not cleaned:
        raise ValueError("no values supplied")

    original = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    lines = original.splitlines()
    remaining = dict(cleaned)

    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        for key in list(remaining):
            if _line_re(key).match(line):
                lines[i] = f"{key}={_quote(remaining.pop(key))}"
                break

    if remaining:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("# ── Added from setup ──")
        for key, val in remaining.items():
            lines.append(f"{key}={_quote(val)}")

    # Written to a sibling and moved into place, so an interrupted write cannot
    # leave a truncated file where every key used to be.
    tmp = ENV_PATH.with_name(ENV_PATH.name + ".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        # Best-effort; Windows has no equivalent bit and the move should still run.
        pass
    os.replace(tmp, ENV_PATH)

    for key, val in cleaned.items():
        if val:
            os.environ[key] = val
        else:
            os.environ.pop(key, None)

    return {
        "changed": sorted(cleaned),
        "restart_required": sorted(k for k in cleaned if _FIELDS[k].restart),
    }
