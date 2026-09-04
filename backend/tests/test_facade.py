"""
The facade and the operator tier.

Two things worth testing here that the other files cannot reach. First, that
`conca` really is a facade — importing it must not break the bare-name imports the
implementation modules use between themselves, which is the one way a package
directory could plausibly go wrong. Second, that `check_conformance` fails when
the boundary actually drifts, because a checker that cannot fail is worse than no
checker: it reads as coverage.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import conca  # noqa: E402
import operator_notes  # noqa: E402
from security import load_policy  # noqa: E402

POLICY_PATH = Path(__file__).parent.parent / ".conca"


@pytest.fixture(scope="module")
def policy():
    return load_policy(POLICY_PATH)


# ═══════════════════════════════════════════════════════════════════════════
# The facade
# ═══════════════════════════════════════════════════════════════════════════


def test_every_exported_name_resolves() -> None:
    """
    `__all__` is a promise. A name in it that does not exist is an ImportError
    for whoever writes `from conca import *`, and nothing else would catch it.
    """
    missing = [name for name in conca.__all__ if not hasattr(conca, name)]
    assert not missing, f"__all__ promises names that do not exist: {missing}"


def test_the_documented_aliases_are_the_real_classes() -> None:
    """The architecture documents say Policy and Memory; the classes are not."""
    assert conca.Policy is conca.ConcaPolicy
    assert conca.Memory is conca.MemoryStore


def test_the_facade_re_exports_rather_than_reimplements() -> None:
    """
    Identity, not equality. If a symbol were redefined inside the package the
    two would compare equal in some cases and still be a second implementation
    to keep in sync.
    """
    import security
    import tools

    assert conca.requires_halo is security.requires_halo
    assert conca.TOOL_REGISTRY is tools.TOOL_REGISTRY
    assert conca.HALO_TRIGGERS is security.HALO_TRIGGERS


def test_conformance_passes_on_the_shipped_policy(policy) -> None:
    assert conca.check_conformance(policy) == []


def test_conformance_catches_an_orphaned_gate(policy, monkeypatch) -> None:
    """
    The checker must fail when the boundary drifts.

    This reproduces the exact bug that shipped: a gate named for a task type no
    tool emits. If this test passes with the assertion inverted, the checker is
    decoration.
    """
    monkeypatch.setattr(
        conca, "HALO_TRIGGERS", conca.HALO_TRIGGERS | {"file_write"}, raising=True
    )
    problems = conca.check_conformance(policy)
    assert problems, "drift went undetected"
    assert "file_write" in problems[0]
    assert "gate nothing" in problems[0] or "gates nothing" in problems[0]


def test_conformance_catches_an_agent_with_no_kill_switch(policy) -> None:
    """A tool whose agent the policy never declares cannot be switched off."""
    stripped = policy.model_copy(deep=True)
    stripped.agent_permissions = {
        k: v for k, v in stripped.agent_permissions.items() if k != "research"
    }
    problems = conca.check_conformance(stripped)
    assert any("research" in p for p in problems)


def test_inventory_reports_a_coherent_runtime(policy) -> None:
    inv = conca.inventory(policy)
    assert inv["tools"] == len(conca.TOOL_REGISTRY)
    assert inv["halo_gated_actions"] == len(conca.HALO_TRIGGERS)
    assert inv["agents_enabled"] <= inv["agents_declared"]
    assert inv["conformance_problems"] == []
    # Reachable can never exceed the ladder it is measured against.
    assert inv["ladder_slots_reachable"] <= inv["ladder_slots"]


def test_gated_actions_matches_the_trigger_set() -> None:
    assert set(conca.gated_actions()) == set(conca.HALO_TRIGGERS)


# ═══════════════════════════════════════════════════════════════════════════
# The operator tier
# ═══════════════════════════════════════════════════════════════════════════


def test_a_missing_notes_file_is_not_an_error(tmp_path: Path) -> None:
    """The tier is optional. A fresh install has no notes and must still run."""
    assert operator_notes.load_operator_notes(tmp_path / "absent.md") == ""


def test_notes_are_read_and_the_header_comment_is_stripped(tmp_path: Path) -> None:
    p = tmp_path / "OPERATOR.md"
    p.write_text(
        "<!-- do not put secrets here -->\n# Standing notes\n\n- Draft in British English.\n",
        encoding="utf-8",
    )
    body = operator_notes.load_operator_notes(p)
    assert "British English" in body
    assert "do not put secrets" not in body, "header is for the human, not the model"


def test_an_edit_lands_without_a_restart(tmp_path: Path) -> None:
    """
    The cache keys on (mtime, size), so a changed file must be re-read.

    Written with a size change rather than only a content change, because a
    same-size same-second overwrite is exactly the case a naive mtime cache
    misses and there is no point pretending otherwise in a test.
    """
    p = tmp_path / "OPERATOR.md"
    p.write_text("- first\n", encoding="utf-8")
    assert "first" in operator_notes.load_operator_notes(p)
    p.write_text("- second, and rather longer than the first\n", encoding="utf-8")
    assert "second" in operator_notes.load_operator_notes(p)


def test_oversized_notes_are_truncated_not_refused(tmp_path: Path) -> None:
    """
    Dropping the operator's standing instructions because they got long would be
    the worse failure, so the cap truncates and says it truncated.
    """
    p = tmp_path / "OPERATOR.md"
    p.write_text("x" * (operator_notes.MAX_NOTES_CHARS + 500), encoding="utf-8")
    body = operator_notes.load_operator_notes(p)
    assert len(body) <= operator_notes.MAX_NOTES_CHARS + 40
    assert body.endswith("[notes truncated]")


def test_status_reports_presence_and_size_but_not_the_text(tmp_path: Path) -> None:
    """
    `/api/conca/status` is reachable by a non-loopback caller under the public
    role. The operator's standing notes are their own text and there is no reason
    for a status payload to hand them back over the network.
    """
    p = tmp_path / "OPERATOR.md"
    p.write_text("- my consultant is Dr Ashworth at the Royal Free\n", encoding="utf-8")
    status = operator_notes.notes_status(p)
    assert status["present"] is True
    assert status["chars"] > 0
    assert "Ashworth" not in str(status)


def test_the_shipped_notes_file_exists_and_warns_about_secrets() -> None:
    """
    The file goes verbatim to a third-party provider on every dispatch. That is
    the point of it and also its one sharp edge, so the warning has to be in the
    file the operator opens, not in a docstring they will never see.
    """
    shipped = Path(__file__).parent.parent / "OPERATOR.md"
    assert shipped.exists(), "the operator tier ships with a seed file"
    raw = shipped.read_text(encoding="utf-8")
    assert "secret" in raw.lower()
    assert ".env" in raw, "the warning must say where credentials do belong"
