"""
.conca zero-trust policy engine + shell command normalizer.

Security is enforced at the process boundary, not at the prompt level. Every
check here runs *after* the model has produced a plan and *before* anything
executes, so a stochastic LLM cannot talk its way past it — there is no prompt
that makes `check_path` return True for `C:\\Windows\\System32`.

Two halves:

  ConcaPolicy      Typed view of the .conca YAML: agent kill-switches, role
                   scoping, path deny/allow lists, behavioural flags.

  ShellNormalizer  Strips nine classes of obfuscation off a command so path
                   rules match what the command will *actually do*, not what
                   it looks like. `\\x72\\x6d -rf /` and `rm -rf /` reduce to
                   the same string before the deny-list is consulted.
"""

from __future__ import annotations

import base64
import binascii
import os
import posixpath
import re
import urllib.parse
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field

Role = Literal["public", "student", "staff"]

# Actions that must not run without explicit human sign-off. Ported from the
# original conca-check node's trigger set, plus send_sms/make_call for the Telecom
# path and social_post — a publish is outward-facing and effectively irreversible,
# which is the same property that puts send_email on this list.
#
# These are **registered task types** from `TOOL_REGISTRY`, matched by exact
# membership. A name here that no tool answers to gates nothing, and — worse —
# reads as though it does. `test_halo_triggers_are_registered` asserts the two
# sets agree, because the failure mode is silent: `write_file` sat in this list as
# `file_write` and file writes went through ungated while the docstring claimed
# otherwise.
HALO_TRIGGERS: frozenset[str] = frozenset(
    {
        "send_email",
        "send_sms",
        "make_call",
        "social_post",
        "project_create",
        "write_file",
        "python_execute",
        "delete_event",
        # In-page actions only. `browse_page` and `screenshot_page` are reads and
        # are deliberately absent: gating every navigation would make the browser
        # unusable and train the operator to approve without reading, which costs
        # more safety than it buys. Clicking and typing in a live page is where a
        # driven browser stops being a reader and starts being an actor.
        "browser_act",
        # Money and pixels.
        #
        # `shop_checkout` spends; `chain_prepare_tx` builds a transaction that,
        # once signed, cannot be recalled by anyone. `shop_search`, `shop_compare`,
        # `order_track`, `quote`, `fundamentals`, `portfolio`, `wallet_balances`
        # and `chain_history` are all reads and are deliberately absent, for the
        # same reason `browse_page` is.
        #
        # `paper_trade` is absent on a different argument: it moves no money and
        # touches no venue, so gating it would be theatre — and theatre is the
        # thing that erodes a gate. Every payload it returns carries `paper: true`
        # so the UI cannot dress a simulation up as an execution.
        "shop_checkout",
        "chain_prepare_tx",
        # Reading the operator's screen is a capability, not a query: whatever is
        # visible at that moment — a password manager, someone else's message —
        # becomes model input. Gated even though it is nominally a read.
        "screen_capture",
    }
)

# Task types whose output is Rule-0 sensitive because of where it came from, not
# because of what it says.
#
# Rule 0 normally reads the text: `memory.is_sensitive` matches five families of
# distress vocabulary, and anything it matches is written to the transcript but
# never embedded. That works because distress announces itself in words.
#
# A description of the operator's screen does not. "The invoice shows £4,000 owed
# to Ashworth Ltd" contains no pattern any family will ever hold, and it is exactly
# the sentence that must not become a vector row a later session can retrieve. The
# operator chose to show one frame to one model; embedding the description turns
# that into a permanent, searchable fact about them.
#
# So there are two sources of truth for the same exclusion — content and
# provenance — and this set is the second. Like `HALO_TRIGGERS` these are exact
# `TOOL_REGISTRY` task types, and for the same reason: a name here that no tool
# emits excludes nothing while reading as though it does.
PROVENANCE_SENSITIVE: frozenset[str] = frozenset({"screen_capture"})

# Command verbs that make a shell segment interesting enough to treat as the
# "payload" when a chain is flattened, and to hard-refuse regardless of path.
_DESTRUCTIVE_VERBS: frozenset[str] = frozenset(
    {
        "rm", "rmdir", "del", "delete", "erase", "remove", "remove-item", "ri", "rd",
        "format", "mkfs", "dd", "shred", "wipe", "purge", "destroy", "unlink",
        "takeown", "icacls", "attrib", "reg", "regedit", "diskpart",
        "shutdown", "taskkill", "killall", "chown", "chmod",
    }
)


# ═══════════════════════════════════════════════════════════════════════════
# Policy model
# ═══════════════════════════════════════════════════════════════════════════


class SecurityOverrides(BaseModel):
    autonomous_interactivity: bool = False
    financial_transactions: bool = False
    deep_data_parsing: bool = False
    meeting_attendance: bool = False


class ConnectorDef(BaseModel):
    name: str
    mcp: str
    token: str | None = None


class HardshipResponse(BaseModel):
    enabled: bool = False
    first_agent: str = "therapy"
    parallel_after_therapy: list[str] = Field(default_factory=list)
    immediate_before_longterm: bool = True
    immediate_needs: list[str] = Field(default_factory=list)
    longterm_needs: list[str] = Field(default_factory=list)


class ConcaRules(BaseModel):
    default_save_path: str = ""
    confirm_before_send_email: bool = True
    confirm_before_send_sms: bool = True
    # Voice is separate from SMS, and defaults to on for the same reason: a call
    # is louder, less deniable, and cannot be unsent.
    confirm_before_call: bool = True
    max_file_size_mb: int = 50

    # How far the shopper agent is allowed to carry a purchase.
    #
    #   handoff     — fills the cart, then stops at the payment page for you to
    #                 click. No card ever enters the system. The default, and the
    #                 only mode that works while `financial_transactions` is false.
    #   autonomous  — types the card itself, through `POST /api/shopper/secret`:
    #                 RAM only, 180-second TTL, single use, screenshots suppressed
    #                 for the entry step.
    #   wallet      — pays on-chain; the agent builds an unsigned transaction and
    #                 you sign it in your own wallet.
    #
    # All three exist because all three were asked for. What separates them is not
    # code but the deliberateness of reaching them: the two that can move money
    # need this key *and* `security_overrides.financial_transactions`, so enabling
    # spend is two edits to a file a human reads, in a repo that records the diff.
    checkout_mode: str = "handoff"

    # Whether the desktop overlay may photograph the screen.
    #
    #   off — the Tauri command refuses; no pixels are captured at all
    #   ask — every capture opens a HALO gate first (the default)
    #   on  — captures without a gate; still never written to disk
    #
    # `ask` rather than `on` by default because a screen is not a document you
    # chose to share: it holds whatever happened to be in front of you.
    screen_capture: str = "ask"

    hardship_response: HardshipResponse = Field(default_factory=HardshipResponse)


class ScheduleDef(BaseModel):
    id: str | None = None
    cron: str
    prompt: str


class ConcaPolicy(BaseModel):
    """Parsed .conca. Unknown top-level keys are kept in `extra` for display."""

    version: int = 1
    security_overrides: SecurityOverrides = Field(default_factory=SecurityOverrides)
    agent_permissions: dict[str, str] = Field(default_factory=dict)
    role_permissions: dict[str, list[str]] = Field(default_factory=dict)
    connectors: list[ConnectorDef] = Field(default_factory=list)
    off_limits: dict[str, list[str]] = Field(default_factory=dict)
    allowed_paths: list[str] = Field(default_factory=list)
    blocked_domains: list[str] = Field(default_factory=list)
    rules: ConcaRules = Field(default_factory=ConcaRules)
    schedules: list[ScheduleDef] = Field(default_factory=list)

    # ── convenience accessors ────────────────────────────────────────────
    @property
    def off_limits_paths(self) -> list[str]:
        """Tolerates both `off_limits: {paths: [...]}` and `off_limits_paths`."""
        return list(self.off_limits.get("paths", []))

    def enabled_agents(self) -> list[str]:
        return sorted(k for k, v in self.agent_permissions.items() if v == "enabled")

    def agents_for_role(self, role: Role | None) -> list[str]:
        """Intersection of the role's grant list and the global kill-switches."""
        if role is None:
            return []
        granted = set(self.role_permissions.get(role, []))
        return sorted(a for a in granted if self.agent_permissions.get(a) == "enabled")


class PolicyViolation(Exception):
    """Raised when a requested action is refused by .conca."""

    def __init__(self, reason: str, *, rule: str = "unknown") -> None:
        super().__init__(reason)
        self.reason = reason
        self.rule = rule


DEFAULT_POLICY_PATH = Path(__file__).parent / ".conca"


def load_policy(path: str | Path = DEFAULT_POLICY_PATH) -> ConcaPolicy:
    """Read and validate .conca. Raises if the file is missing or malformed."""
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f".conca policy file not found at {p}")
    raw: dict[str, Any] = yaml.safe_load(p.read_text(encoding="utf-8")) or {}

    # Accept the flat `off_limits_paths` spelling some older files used.
    if "off_limits_paths" in raw and "off_limits" not in raw:
        raw["off_limits"] = {"paths": raw.pop("off_limits_paths")}

    return ConcaPolicy.model_validate(raw)


# ═══════════════════════════════════════════════════════════════════════════
# Path canonicalisation
# ═══════════════════════════════════════════════════════════════════════════


def canonical_path(raw: str) -> str:
    """
    Reduce a path to a single comparable form.

    Expands `~` and environment variables, unifies separators, collapses `..`
    and `.`, and lowercases on Windows. Both sides of every comparison go
    through this, so `$HOME/.ssh`, `~/.ssh` and `C:\\Users\\Admin\\.ssh` all
    land on the same string.
    """
    if not raw:
        return ""
    p = raw.strip().strip('"').strip("'")
    p = os.path.expanduser(os.path.expandvars(p))
    p = p.replace("\\", "/")
    # Preserve a leading UNC-ish double slash only if it was there originally.
    p = posixpath.normpath(p)
    if os.name == "nt":
        p = p.lower()
    return p


def _is_within(child: str, parent: str) -> bool:
    """True when `child` is `parent` or sits underneath it."""
    if not child or not parent:
        return False
    return child == parent or child.startswith(parent.rstrip("/") + "/")


# ═══════════════════════════════════════════════════════════════════════════
# Policy checks
# ═══════════════════════════════════════════════════════════════════════════


def check_agent_permission(
    policy: ConcaPolicy, agent: str, role: Role | None = None
) -> tuple[bool, str]:
    """
    Verify an agent may be dispatched at all, and by this role.

    Agent names are normalised on `-` → `_` so `file-code` and `file_code`
    resolve to the same switch.
    """
    key = agent.replace("-", "_").strip().lower()

    if policy.agent_permissions.get(key) != "enabled":
        state = policy.agent_permissions.get(key, "not declared")
        return False, f'Agent "{agent}" is {state} in .conca'

    if role is not None:
        if key not in policy.role_permissions.get(role, []):
            return False, f'Role "{role}" may not dispatch agent "{agent}"'

    return True, "permitted"


def check_path(policy: ConcaPolicy, target_path: str) -> tuple[bool, str]:
    """
    Apply the deny-list, then the allow-list.

    Returns `(allowed, reason)`. The deny-list always wins. When
    `allowed_paths` is non-empty it becomes deny-by-default: a path that
    matches nothing in it is refused even if no deny rule mentioned it.
    """
    if not target_path:
        return True, "no path in payload"

    canon = canonical_path(target_path)

    for off in policy.off_limits_paths:
        if _is_within(canon, canonical_path(off)):
            return False, f'Path "{target_path}" is off-limits per .conca ({off})'

    if policy.allowed_paths:
        for allowed in policy.allowed_paths:
            if _is_within(canon, canonical_path(allowed)):
                return True, f"within allowed_paths ({allowed})"
        return False, f'Path "{target_path}" is outside .conca allowed_paths'

    return True, "no allow-list configured"


def check_file_size(policy: ConcaPolicy, content: str | bytes) -> tuple[bool, str]:
    """Enforce `rules.max_file_size_mb` before a write is attempted."""
    size = len(content.encode("utf-8") if isinstance(content, str) else content)
    limit = policy.rules.max_file_size_mb * 1024 * 1024
    if size > limit:
        mb = size / (1024 * 1024)
        return False, (
            f"Payload is {mb:.1f}MB, over the "
            f"{policy.rules.max_file_size_mb}MB .conca limit"
        )
    return True, "within size limit"


# Hosts that are never fetched, regardless of `.conca`. Loopback and link-local
# are here rather than only in the policy file because the reason they are
# dangerous is structural: a browser agent that can be talked into fetching
# `http://127.0.0.1:8000/api/conca/raw` is reading the policy that governs it
# using the server's own credentials, and `169.254.169.254` is the standard cloud
# metadata endpoint. A user editing `blocked_domains` down to nothing should not
# be able to open those.
_ALWAYS_BLOCKED_HOSTS: frozenset[str] = frozenset(
    {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "169.254.169.254"}
)

_PRIVATE_V4_PREFIXES: tuple[str, ...] = (
    "10.", "192.168.", "127.", "169.254.",
    *(f"172.{n}." for n in range(16, 32)),
)


def check_url(policy: ConcaPolicy, url: str) -> tuple[bool, str]:
    """
    Whether the browser agent may navigate to `url`.

    Returns `(allowed, reason)`. This is the screen that lets `.conca` enable the
    browser at all: the original objection was that a driven browser is an
    unscreenable execution surface, and this is the screen.

    Three refusals, in order of how badly they'd go wrong:

    1. **Scheme.** Only http and https. `file://` would turn the browser into a
       filesystem reader that bypasses `check_path` entirely, and `javascript:`
       into an evaluator.
    2. **Loopback and private ranges.** Server-side request forgery: the browser
       runs next to the API, so `localhost` from its perspective is *this app*,
       not the user's machine as a model might assume.
    3. **The policy's own `blocked_domains`**, matched on host suffix so one entry
       covers subdomains.
    """
    raw = (url or "").strip()
    if not raw:
        return False, "no URL supplied"

    parsed = urllib.parse.urlparse(raw if "//" in raw else f"https://{raw}")
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        return False, f'Scheme "{scheme or "none"}" is refused — http and https only'

    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return False, f'Could not read a hostname out of "{url}"'

    if host in _ALWAYS_BLOCKED_HOSTS or host.startswith(_PRIVATE_V4_PREFIXES):
        return False, (
            f'Host "{host}" is loopback or private — the browser runs beside the '
            "API, so this would be a request to Concaretti itself"
        )

    for blocked in policy.blocked_domains:
        b = blocked.strip().lower().lstrip("*.").rstrip(".")
        if b and (host == b or host.endswith(f".{b}")):
            return False, f'Host "{host}" is blocked per .conca ({blocked})'

    return True, f"{host} is not blocked"


def requires_halo(policy: ConcaPolicy, action: str) -> bool:
    """
    Whether an action needs human sign-off.

    Membership in HALO_TRIGGERS is the floor; the `confirm_before_*` rules can
    only ever be used to *keep* a gate, never to remove one that the trigger
    set mandates.

    `screen_capture` is the one exception, and it is an exception on purpose rather
    than by omission. The three modes in `rules.screen_capture` are a mode
    selector for a capability, not a confirmation preference: `off` means no pixels
    are read at all, `ask` gates every frame, and `on` is the operator saying they
    have pre-authorised this class of action for this session of work — which is a
    thing a person is entitled to decide about their own display, in a file only
    they can edit.

    Two things keep that from being a hole. It is **exact-match on `on`**, so a
    typo, a `true`, a `yes` or an empty value all resolve to gating; the unknown
    value fails towards asking. And `off` is not enforced here at all — a gate
    cannot express "never" — so it is enforced by refusal at the route and again at
    the tool boundary, where a refusal actually stops something.
    """
    if action == "send_email":
        return policy.rules.confirm_before_send_email or "send_email" in HALO_TRIGGERS
    if action == "send_sms":
        return policy.rules.confirm_before_send_sms or "send_sms" in HALO_TRIGGERS
    if action == "make_call":
        return policy.rules.confirm_before_call or "make_call" in HALO_TRIGGERS
    if action == "screen_capture":
        mode = str(getattr(policy.rules, "screen_capture", "ask") or "").strip().lower()
        return mode != "on"
    return action in HALO_TRIGGERS


# ═══════════════════════════════════════════════════════════════════════════
# Shell normalizer
# ═══════════════════════════════════════════════════════════════════════════


class ShellNormalizer:
    """
    Nine obfuscation-stripping rewrites, applied in a fixed order.

    Order is deliberate: escapes are decoded first so that later stages can
    see the characters they need to match, quote noise is removed before
    variable and alias resolution, and path collapsing runs last so it
    operates on fully-resolved text.

        1. hex decode            \\x72\\x6d -rf /      → rm -rf /
        2. octal decode          \\162\\155 -rf /      → rm -rf /
        3. ANSI-C decode         $'\\x72\\x6d'         → rm
        4. base64 unwrap         echo cm0=|base64 -d  → rm
        5. adjacent-quote concat r''m -rf /           → rm -rf /
        6. quote strip           r'"'"'m' -rf         → rm -rf
        7. variable expansion    $HOME/.ssh/id_rsa    → ~/.ssh/id_rsa
        8. alias resolution      r=rm; $r -rf /       → rm -rf /
        9. path normalisation    ../../etc/passwd     → /etc/passwd
    """

    _HEX = re.compile(r"\\x([0-9a-fA-F]{2})")
    _OCTAL = re.compile(r"\\([0-7]{2,3})")
    _ANSI_C = re.compile(r"\$'((?:[^'\\]|\\.)*)'")
    _BASE64_PIPE = re.compile(
        r"""(?:echo|printf)\s+(['"]?)([A-Za-z0-9+/=\s]{4,}?)\1\s*\|\s*"""
        r"""base64\s+(?:-d|-D|--decode)\b""",
        re.IGNORECASE,
    )
    _ADJACENT_QUOTES = re.compile(r"""(?<=\w)(''|"")(?=\w)""")
    _QUOTE_SANDWICH = re.compile(r"""'"'"'""")
    _ASSIGNMENT = re.compile(
        r"""(?:^|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*)=(['"]?)([^\s;&|'"]+)\2"""
    )
    _VAR_REF = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?")
    _SEGMENT_SPLIT = re.compile(r"\s*(?:\|\||&&|;|\||\n)\s*")
    _PATHLIKE = re.compile(r"""(?<![\w-])((?:[A-Za-z]:[\\/]|~|\.\.?/|/)[^\s;&|'"]*)""")

    # Variables we resolve to a stable form rather than this machine's value,
    # so a policy written as `~/.ssh` matches `$HOME/.ssh` on any host.
    _SYMBOLIC_VARS = {
        "HOME": "~",
        "USERPROFILE": "~",
        "HOMEPATH": "~",
    }

    # ── individual strategies ────────────────────────────────────────────

    def _decode_hex(self, cmd: str) -> str:
        return self._HEX.sub(lambda m: chr(int(m.group(1), 16)), cmd)

    def _decode_octal(self, cmd: str) -> str:
        def sub(m: re.Match[str]) -> str:
            try:
                return chr(int(m.group(1), 8))
            except ValueError:
                return m.group(0)

        return self._OCTAL.sub(sub, cmd)

    def _decode_ansi_c(self, cmd: str) -> str:
        def sub(m: re.Match[str]) -> str:
            inner = m.group(1)
            inner = self._decode_hex(inner)
            inner = self._decode_octal(inner)
            return inner

        return self._ANSI_C.sub(sub, cmd)

    def _unwrap_base64(self, cmd: str) -> str:
        def sub(m: re.Match[str]) -> str:
            payload = re.sub(r"\s+", "", m.group(2))
            try:
                decoded = base64.b64decode(payload, validate=True)
                return decoded.decode("utf-8", errors="replace")
            except (binascii.Error, ValueError):
                return m.group(0)

        out = self._BASE64_PIPE.sub(sub, cmd)
        # A decoded payload is frequently piped straight into a shell; the
        # trailing `| bash` carries no further meaning once unwrapped.
        return re.sub(r"\s*\|\s*(?:ba|z|k|)sh\b", "", out, flags=re.IGNORECASE)

    def _concat_adjacent_quotes(self, cmd: str) -> str:
        out = self._QUOTE_SANDWICH.sub("", cmd)
        return self._ADJACENT_QUOTES.sub("", out)

    def _strip_quotes(self, cmd: str) -> str:
        return cmd.replace("'", "").replace('"', "")

    def _expand_variables(self, cmd: str) -> str:
        def sub(m: re.Match[str]) -> str:
            name = m.group(1)
            if name in self._SYMBOLIC_VARS:
                return self._SYMBOLIC_VARS[name]
            return os.environ.get(name, m.group(0))

        return self._VAR_REF.sub(sub, cmd)

    def _resolve_aliases(self, cmd: str) -> str:
        """
        Substitute shell-local assignments into later references.

        Runs to a fixed point so chained indirection (`a=rm; b=$a; $b -rf /`)
        collapses rather than stopping after one hop.
        """
        out = cmd
        for _ in range(5):
            aliases = {m.group(1): m.group(3) for m in self._ASSIGNMENT.finditer(out)}
            if not aliases:
                break

            # Transitively resolve alias dependencies (e.g. b=$a where a=rm -> b=rm)
            for _ in range(len(aliases)):
                for k, v in list(aliases.items()):
                    if v.startswith("$"):
                        ref = v.lstrip("${").rstrip("}")
                        if ref in aliases:
                            aliases[k] = aliases[ref]

            def sub(m: re.Match[str]) -> str:
                return aliases.get(m.group(1), m.group(0))

            replaced = self._VAR_REF.sub(sub, out)
            # Drop the assignment statements themselves once consumed.
            replaced = self._ASSIGNMENT.sub("", replaced)
            replaced = re.sub(r"^\s*[;&|]+\s*", "", replaced).strip()
            if replaced == out:
                break
            out = replaced
        return out

    def _normalise_paths(self, cmd: str) -> str:
        def sub(m: re.Match[str]) -> str:
            return canonical_path(m.group(1))

        return self._PATHLIKE.sub(sub, cmd)

    # ── pipeline ─────────────────────────────────────────────────────────

    def _apply_all(self, cmd: str) -> str:
        for stage in (
            self._decode_hex,
            self._decode_octal,
            self._decode_ansi_c,
            self._unwrap_base64,
            self._concat_adjacent_quotes,
            self._strip_quotes,
            self._expand_variables,
            self._resolve_aliases,
            self._normalise_paths,
        ):
            cmd = stage(cmd)
        return re.sub(r"\s+", " ", cmd).strip()

    def segments(self, cmd: str) -> list[str]:
        """
        Every normalised segment of a chained command.

        `is_safe` scans all of these — checking only the "most dangerous" one
        would let `rm -rf ~/.ssh && ls` hide its second half.
        """
        normalised = self._apply_all(cmd)
        parts = [s.strip() for s in self._SEGMENT_SPLIT.split(normalised)]
        return [p for p in parts if p]

    def normalize(self, cmd: str) -> str:
        """
        Single normalised form, with a chain flattened to its payload.

        Chain flattening picks the destructive segment when there is one, which
        is what makes `ls && rm -rf /` report as `rm -rf /`.
        """
        parts = self.segments(cmd)
        if not parts:
            return ""
        for part in parts:
            head = part.split()[0] if part.split() else ""
            if head.lower() in _DESTRUCTIVE_VERBS:
                return part
        return parts[0]

    def is_destructive(self, cmd: str) -> tuple[bool, str]:
        """Whether any segment leads with a destructive verb."""
        for part in self.segments(cmd):
            tokens = part.split()
            if tokens and tokens[0].lower() in _DESTRUCTIVE_VERBS:
                return True, tokens[0].lower()
        return False, ""


_NORMALIZER = ShellNormalizer()


def normalize_command(cmd: str) -> str:
    """Module-level convenience wrapper around the shared normalizer."""
    return _NORMALIZER.normalize(cmd)


def is_safe(policy: ConcaPolicy, cmd: str) -> tuple[bool, str]:
    """
    Deobfuscate a command, then judge every segment against .conca.

    Refuses when any segment touches an off-limits path, or when a destructive
    verb targets a path outside `allowed_paths`. This is the check that stands
    between a model-authored shell string and the OS.
    """
    segments = _NORMALIZER.segments(cmd)
    if not segments:
        return True, "empty command"

    for segment in segments:
        tokens = segment.split()
        verb = tokens[0].lower() if tokens else ""
        destructive = verb in _DESTRUCTIVE_VERBS

        for match in ShellNormalizer._PATHLIKE.finditer(segment):
            candidate = match.group(1)

            for off in policy.off_limits_paths:
                if _is_within(canonical_path(candidate), canonical_path(off)):
                    return False, (
                        f'Command targets off-limits path "{candidate}" '
                        f"(.conca rule: {off}) — normalized as: {segment}"
                    )

            if destructive and policy.allowed_paths:
                allowed, reason = check_path(policy, candidate)
                if not allowed:
                    return False, (
                        f'Destructive command "{verb}" targets "{candidate}" '
                        f"which is {reason} — normalized as: {segment}"
                    )

        # A destructive verb with no explicit path is still refused when an
        # allow-list exists, because its implicit target is the process CWD.
        if destructive and policy.allowed_paths:
            if not ShellNormalizer._PATHLIKE.search(segment):
                return False, (
                    f'Destructive command "{verb}" has no explicit target; '
                    f"refused under deny-by-default — normalized as: {segment}"
                )

    return True, f"cleared {len(segments)} segment(s)"
