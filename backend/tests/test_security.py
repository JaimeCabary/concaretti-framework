"""
Tests for the .conca engine and shell normalizer.

These exist to make the security claims checkable rather than asserted. Each
obfuscation case in the architecture reference's normalizer table appears here as
a test, so "nine strategies" is a fact about the code and not a table in a
document.

    uv run pytest -v
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from memory import SENSITIVE_PATTERNS, is_sensitive  # noqa: E402
from security import (  # noqa: E402
    HALO_TRIGGERS,
    ConcaPolicy,
    ShellNormalizer,
    canonical_path,
    check_agent_permission,
    check_file_size,
    check_path,
    is_safe,
    load_policy,
    requires_halo,
)

POLICY_PATH = Path(__file__).parent.parent / ".conca"


@pytest.fixture(scope="module")
def policy() -> ConcaPolicy:
    return load_policy(POLICY_PATH)


@pytest.fixture(scope="module")
def norm() -> ShellNormalizer:
    return ShellNormalizer()


# ═══════════════════════════════════════════════════════════════════════════
# Policy loading
# ═══════════════════════════════════════════════════════════════════════════


def test_policy_loads(policy: ConcaPolicy) -> None:
    assert policy.version == 1
    assert policy.off_limits_paths, "off_limits.paths must not be empty"
    assert policy.allowed_paths, "allowed_paths must not be empty"


def test_disabled_agents_are_refused(policy: ConcaPolicy) -> None:
    """
    Agents cut from this build must be actively refused, not merely absent.

    `browser` used to be on this list and is deliberately not any more. It was
    disabled on the grounds that ".conca can only screen what it can see, and a
    driven browser hides the payload"; that objection was answered by making the
    browser screenable rather than by leaving it off — the URL is checked before
    navigation, extraction is read-only, and `browser_act` is HALO-gated. The
    assertion moved to `test_enabled_agents_pass` rather than being deleted.
    """
    for agent in ("deploy", "chaos", "coding", "health"):
        ok, reason = check_agent_permission(policy, agent)
        assert not ok, f"{agent} should be disabled"
        assert "disabled" in reason


def test_enabled_agents_pass(policy: ConcaPolicy) -> None:
    for agent in (
        "orchestrator",
        "research",
        "calendar",
        "file",
        "browser",
        "shopper",
        "market",
        "chain",
        "desktop",
    ):
        ok, _ = check_agent_permission(policy, agent)
        assert ok, f"{agent} should be enabled"


def test_agent_name_normalisation(policy: ConcaPolicy) -> None:
    """`file-code` and `file_code` must resolve to the same switch."""
    assert check_agent_permission(policy, "research")[0]
    assert check_agent_permission(policy, "RESEARCH")[0]


# ═══════════════════════════════════════════════════════════════════════════
# Role scoping
# ═══════════════════════════════════════════════════════════════════════════


def test_public_role_is_minimal(policy: ConcaPolicy) -> None:
    agents = policy.agents_for_role("public")
    assert agents == ["research"], f"public tier should only have research, got {agents}"


def test_student_cannot_send_email_or_sms(policy: ConcaPolicy) -> None:
    for agent in ("email", "sms"):
        ok, reason = check_agent_permission(policy, agent, role="student")
        assert not ok
        assert "student" in reason


def test_staff_has_full_grant(policy: ConcaPolicy) -> None:
    agents = policy.agents_for_role("staff")
    assert {"email", "sms", "calendar", "research", "file"} <= set(agents)


def test_role_grant_cannot_exceed_global_switch(policy: ConcaPolicy) -> None:
    """
    A role grant must never re-enable a globally disabled agent.

    This is the property that makes the two layers safe to reason about
    independently: role lists can only ever narrow.
    """
    mutated = policy.model_copy(deep=True)
    mutated.role_permissions["staff"] = [*mutated.role_permissions["staff"], "deploy"]
    assert "deploy" not in mutated.agents_for_role("staff")
    ok, _ = check_agent_permission(mutated, "deploy", role="staff")
    assert not ok


# ═══════════════════════════════════════════════════════════════════════════
# Path rules
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "target",
    [
        r"C:\Windows\System32\drivers\etc\hosts",
        r"C:\Windows",
        "~/.ssh/id_rsa",
        "/private/secrets.txt",
        "/finance/payroll.xlsx",
        r"C:\Users\Admin\AppData\Local\Temp\evil.exe",
    ],
)
def test_off_limits_paths_refused(policy: ConcaPolicy, target: str) -> None:
    allowed, reason = check_path(policy, target)
    assert not allowed, f"{target} should be refused"
    assert "off-limits" in reason


@pytest.mark.parametrize(
    "target",
    [
        r"C:\Users\Admin\Desktop\report.docx",
        r"C:\Users\Admin\Documents\notes.txt",
        r"C:\Users\Admin\Downloads\paper.pdf",
    ],
)
def test_allowed_paths_permitted(policy: ConcaPolicy, target: str) -> None:
    allowed, _ = check_path(policy, target)
    assert allowed, f"{target} should be permitted"


def test_allow_list_is_deny_by_default(policy: ConcaPolicy) -> None:
    """A path nobody mentioned is refused, not permitted."""
    allowed, reason = check_path(policy, r"C:\Users\Admin\Music\track.mp3")
    assert not allowed
    assert "outside" in reason


def test_traversal_cannot_escape_allow_list(policy: ConcaPolicy) -> None:
    """`..` must be collapsed before comparison, or the allow-list is theatre."""
    allowed, _ = check_path(
        policy, r"C:\Users\Admin\Desktop\..\..\..\Windows\System32\cmd.exe"
    )
    assert not allowed


def test_home_variable_and_tilde_agree() -> None:
    assert canonical_path("~/.ssh") == canonical_path(
        os.path.expanduser("~") + "/.ssh"
    )


def test_file_size_limit(policy: ConcaPolicy) -> None:
    ok, _ = check_file_size(policy, "x" * 1024)
    assert ok
    too_big = "x" * (policy.rules.max_file_size_mb * 1024 * 1024 + 1)
    ok, reason = check_file_size(policy, too_big)
    assert not ok
    assert "limit" in reason


# ═══════════════════════════════════════════════════════════════════════════
# Shell normalizer — one test per documented strategy
# ═══════════════════════════════════════════════════════════════════════════


def test_strategy_1_hex_decode(norm: ShellNormalizer) -> None:
    assert "rm" in norm.normalize(r"\x72\x6d -rf /tmp/x")


def test_strategy_2_octal_decode(norm: ShellNormalizer) -> None:
    assert "rm" in norm.normalize(r"\162\155 -rf /tmp/x")


def test_strategy_3_ansi_c_decode(norm: ShellNormalizer) -> None:
    assert "rm" in norm.normalize(r"$'\x72\x6d' -rf /tmp/x")


def test_strategy_4_base64_unwrap(norm: ShellNormalizer) -> None:
    # "rm -rf /tmp/x" base64-encoded, piped through base64 -d into a shell.
    assert "rm" in norm.normalize("echo cm0gLXJmIC90bXAveA== | base64 -d | bash")


def test_strategy_5_adjacent_quote_concat(norm: ShellNormalizer) -> None:
    assert "rm" in norm.normalize("r''m -rf /tmp/x")


def test_strategy_6_quote_stripping(norm: ShellNormalizer) -> None:
    assert "rm" in norm.normalize("""'r'"m" -rf /tmp/x""")


def test_strategy_7_variable_expansion(norm: ShellNormalizer) -> None:
    out = norm.normalize("cat $HOME/.ssh/id_rsa")
    assert ".ssh" in out
    assert "$HOME" not in out


def test_strategy_8_alias_resolution(norm: ShellNormalizer) -> None:
    assert "rm" in norm.normalize("r=rm; $r -rf /tmp/x")


def test_strategy_8_chained_alias_indirection(norm: ShellNormalizer) -> None:
    """Multi-hop indirection must resolve, not stop after one substitution."""
    assert "rm" in norm.normalize("a=rm; b=$a; $b -rf /tmp/x")


def test_strategy_9_relative_path_collapse(norm: ShellNormalizer) -> None:
    assert "/etc/passwd" in norm.normalize("cat ../../etc/passwd")


def test_chain_flattening_selects_payload(norm: ShellNormalizer) -> None:
    """`ls && rm -rf /` reports as the destructive half."""
    assert norm.normalize("ls && rm -rf /tmp/x").startswith("rm")


def test_all_segments_are_inspected(norm: ShellNormalizer) -> None:
    """
    Every segment of a chain must be visible to the checker.

    Flattening to a single "most dangerous" string is fine for display, but a
    checker that only saw that string would miss a second hostile segment.
    """
    segments = norm.segments("echo hello && cat ~/.ssh/id_rsa && ls")
    assert len(segments) == 3
    assert any(".ssh" in s for s in segments)


# ═══════════════════════════════════════════════════════════════════════════
# End-to-end command verdicts
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "command",
    [
        r"rm -rf C:\Windows\System32",
        r"\x72\x6d -rf C:\Windows",
        "cat $HOME/.ssh/id_rsa",
        "cat ~/.ssh/id_rsa",
        "r=rm; $r -rf ~/.ssh",
        "echo cm0gLXJmIH4vLnNzaA== | base64 -d | bash",
        "cat /private/secrets.txt",
        "rm -rf ../../Windows",
    ],
)
def test_hostile_commands_refused(policy: ConcaPolicy, command: str) -> None:
    allowed, reason = is_safe(policy, command)
    assert not allowed, f"should have refused: {command}"
    assert reason


@pytest.mark.parametrize(
    "command",
    [
        r"type C:\Users\Admin\Desktop\notes.txt",
        r"python C:\Users\Admin\Documents\script.py",
        "echo hello",
    ],
)
def test_benign_commands_permitted(policy: ConcaPolicy, command: str) -> None:
    allowed, reason = is_safe(policy, command)
    assert allowed, f"should have permitted: {command} ({reason})"


def test_destructive_verb_without_target_is_refused(policy: ConcaPolicy) -> None:
    """
    A bare `rm` implicitly targets the working directory.

    Under an allow-list this must be refused rather than permitted for lacking an
    argument to inspect.
    """
    allowed, reason = is_safe(policy, "rm -rf")
    assert not allowed
    assert "no explicit target" in reason


# ═══════════════════════════════════════════════════════════════════════════
# HALO triggers
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "action",
    [
        "send_email",
        "send_sms",
        "make_call",
        "social_post",
        "write_file",
        "python_execute",
        "project_create",
        "delete_event",
    ],
)
def test_irreversible_actions_require_halo(policy: ConcaPolicy, action: str) -> None:
    assert requires_halo(policy, action), f"{action} must be gated"


def test_halo_triggers_are_all_registered_task_types() -> None:
    """
    Every gated name must be a task type some tool actually answers to.

    This test exists because its absence hid a real hole. The list used to gate
    `file_write`, `file_delete`, `script_execute`, `deploy_to_vercel` and
    `git_commit_push` — none of which are registered task types. The tool that
    writes files is `write_file`, so `requires_halo` returned False for it and
    every file write ran ungated, while `write_file`'s own docstring claimed it
    was "reached only after HALO approval". The old version of this test asserted
    on the same wrong names, so it passed throughout.

    `requires_halo` is exact membership, not a prefix or fuzzy match, so a name
    that no tool emits is not a stricter gate — it is no gate at all, wearing the
    costume of one.
    """
    from tools import TOOL_REGISTRY

    registered = {task_type for _agent, task_type in TOOL_REGISTRY}
    orphaned = HALO_TRIGGERS - registered
    assert not orphaned, (
        f"HALO_TRIGGERS names nothing in TOOL_REGISTRY: {sorted(orphaned)}. "
        "These gate nothing while appearing to."
    )


@pytest.mark.parametrize("action", ["web_search", "list_events", "draft_reply", "read_file"])
def test_read_only_actions_are_not_gated(policy: ConcaPolicy, action: str) -> None:
    """Gating harmless actions trains operators to click through approvals."""
    assert not requires_halo(policy, action)


def test_browsing_is_not_gated_but_acting_in_the_page_is(policy: ConcaPolicy) -> None:
    """
    Reading a page is research; clicking and typing in one is an outward action.

    The distinction matters because the whole reason `.conca` disabled the
    browser was that a driven browser is a second execution surface. Fetching
    and extracting text is no more dangerous than `scrape_url`; submitting a
    form is.
    """
    assert not requires_halo(policy, "browse_page")
    assert not requires_halo(policy, "screenshot_page")
    assert requires_halo(policy, "browser_act")


def test_confirm_flag_cannot_remove_a_gate(policy: ConcaPolicy) -> None:
    """
    Turning off `confirm_before_send_email` must not ungate sending.

    Membership in HALO_TRIGGERS is the floor; the rule flag can only add.
    """
    mutated = policy.model_copy(deep=True)
    mutated.rules.confirm_before_send_email = False
    assert "send_email" in HALO_TRIGGERS
    assert requires_halo(mutated, "send_email")


# ═══════════════════════════════════════════════════════════════════════════
# Rule 0
# ═══════════════════════════════════════════════════════════════════════════


def test_rule0_has_five_pattern_families() -> None:
    assert len(SENSITIVE_PATTERNS) == 5


@pytest.mark.parametrize(
    "text",
    [
        "I've been feeling really depressed lately",
        "my anxiety has been awful",
        "I want to die",
        "I feel hopeless and worthless",
        "I had a panic attack yesterday",
        "I'm seeing a therapist next week",
        "I'm struggling and can't go on",
        "dealing with grief after a loss",
        "I feel so lonely",
    ],
)
def test_sensitive_text_detected(text: str) -> None:
    assert is_sensitive(text), f"should be Rule-0 sensitive: {text}"


@pytest.mark.parametrize(
    "text",
    [
        "Find me papers on distributed consensus",
        "Schedule a meeting for Tuesday at 3pm",
        "Email the team about Friday's demo",
        "Write a report on agent architectures",
    ],
)
def test_ordinary_text_not_flagged(text: str) -> None:
    """
    Over-triggering is its own failure: it would silently disable recall for
    ordinary work.
    """
    assert not is_sensitive(text), f"should not be flagged: {text}"
