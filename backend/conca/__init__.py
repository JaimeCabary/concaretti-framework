"""
Concaretti — an agent runtime where capability is granted by a file, not a prompt.

This package is a facade. Every symbol below is re-exported from the module that
already implements it, so importing `conca` moves no code and breaks no existing
import. What it adds is a single surface that states what the runtime *is*, in
the order the pieces actually run:

    policy  ->  plan  ->  screen  ->  gate  ->  execute  ->  remember

    from conca import load_policy, requires_halo, Orchestrator

    policy = load_policy(".conca")          # capability, declared
    requires_halo(policy, "send_email")     # -> True. irreversible, needs a human
    requires_halo(policy, "web_search")     # -> False. a read

The one claim
-------------
A model's output is a suggestion. In this runtime it is screened by
`security.py` — a deterministic function with no model in it — before any tool is
entered, and the twelve task types that cannot be undone suspend for a person
first. Generative randomness does not negotiate with a `frozenset`.

Two asymmetries hold that up, and both are tested rather than asserted:

  * A policy flag can *add* a gate and cannot remove one. `HALO_TRIGGERS`
    membership is the floor; `confirm_before_send_email: false` does not ungate
    sending.
  * A provenance flag can *add* sensitivity and cannot remove it. Rule 0's
    content check and its provenance check are OR-ed, so marking a turn
    `sensitive=False` over distressed text does nothing.

The failure this package exists to prevent
------------------------------------------
`HALO_TRIGGERS` compares action names by exact string membership. It once
contained `file_write` while the registered tool was `write_file`. Five gate
names matched no tool, so every file write ran ungated, the policy file read as
though writes were gated, and `write_file`'s own docstring claimed HALO
protection. Nothing errored. The test that was meant to catch it asserted on the
same wrong names and passed.

So `conca.check_conformance()` is part of the public surface, not a test helper.
A declarative permission layer that names actions as strings is void whenever a
string is wrong, and it fails towards permitting. Call it in your own suite:

    from conca import check_conformance
    def test_policy_and_registry_agree():
        assert check_conformance(load_policy(".conca")) == []

See `README.md` in this directory for the full contract.
"""

from __future__ import annotations

import sys
from pathlib import Path

# The implementation modules sit one level up and import each other by bare name
# (`from security import ...`). Adding the parent to the path keeps that working
# whether `conca` is imported from the backend directory or from outside it.
_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from agents import Orchestrator, Subtask  # noqa: E402
from auth import current_role, require_local, require_staff  # noqa: E402
from halo import (  # noqa: E402
    ApprovalOption,
    ApprovalOutcome,
    ApprovalRequest,
    HaloGate,
    InjectionDirective,
    get_gate,
)
from memory import (  # noqa: E402
    SENSITIVE_PATTERNS,
    ContextEntry,
    MemoryStore,
    get_store,
    is_sensitive,
    matched_rule0_families,
)
from operator_notes import load_operator_notes, notes_status  # noqa: E402
from rotator import (  # noqa: E402
    CallResult,
    ModelRotator,
    RotationExhausted,
    get_rotator,
)
from security import (  # noqa: E402
    HALO_TRIGGERS,
    PROVENANCE_SENSITIVE,
    ConcaPolicy,
    PolicyViolation,
    ShellNormalizer,
    check_agent_permission,
    check_file_size,
    check_path,
    check_url,
    is_safe,
    load_policy,
    normalize_command,
    requires_halo,
)
from sse import SseBroker, get_broker  # noqa: E402
from tools import (  # noqa: E402
    AGENT_CAPABILITIES,
    TOOL_REGISTRY,
    ExecContext,
    redact_secrets,
    resolve_tool,
)

__version__ = "0.1.0"

# `Policy` and `Memory` are the names the architecture documents use; the classes
# are `ConcaPolicy` and `MemoryStore`. Alias rather than rename, so both spellings
# resolve and no existing import breaks.
Policy = ConcaPolicy
Memory = MemoryStore


def check_conformance(policy: ConcaPolicy) -> list[str]:
    """
    Assert that the policy's vocabulary and the executor's vocabulary agree.

    Returns a list of human-readable problems; empty means the boundary is
    coherent. Three classes of drift are detectable, and all three are silent at
    runtime:

      1. A gated task type no tool emits. Gates nothing while reading as a gate.
         This is the one that already shipped.
      2. A provenance-excluded task type no tool emits. Excludes nothing.
      3. A tool whose agent the policy never declares. Not a hole today —
         `check_agent_permission` refuses an unknown agent — but it means the
         kill switch for that capability is not a line anyone can find, which
         defeats the point of declaring capability in a file.

    The reverse direction is deliberately not checked. A registered task type
    absent from `HALO_TRIGGERS` is not necessarily a bug; most tools are reads
    and gating them would train the operator to click through approvals. Whether
    a given action is irreversible is a human judgement made when the tool is
    written, and this function does not pretend to make it.
    """
    problems: list[str] = []
    registered_tasks = {task for _agent, task in TOOL_REGISTRY}
    registered_agents = {agent for agent, _task in TOOL_REGISTRY}

    orphan_gates = sorted(HALO_TRIGGERS - registered_tasks)
    if orphan_gates:
        problems.append(
            f"HALO_TRIGGERS names {len(orphan_gates)} task type(s) no tool emits, "
            f"so they gate nothing while appearing to: {orphan_gates}"
        )

    orphan_provenance = sorted(PROVENANCE_SENSITIVE - registered_tasks)
    if orphan_provenance:
        problems.append(
            f"PROVENANCE_SENSITIVE names {len(orphan_provenance)} task type(s) no "
            f"tool emits, so they exclude nothing: {orphan_provenance}"
        )

    undeclared = sorted(registered_agents - set(policy.agent_permissions))
    if undeclared:
        problems.append(
            f"{len(undeclared)} agent(s) own tools but have no switch in the policy, "
            f"so their capability cannot be revoked by editing it: {undeclared}"
        )

    return problems


def gated_actions() -> list[str]:
    """The task types that suspend for a human, sorted. Twelve, at present."""
    return sorted(HALO_TRIGGERS)


def capabilities() -> dict[str, list[str]]:
    """Agent -> the task types it owns. Derived from the registry, not declared."""
    return {agent: sorted(tasks) for agent, tasks in AGENT_CAPABILITIES.items()}


def inventory(policy: ConcaPolicy | None = None) -> dict[str, object]:
    """
    Counted facts about this runtime, for a status page or a paper's table.

    Every figure is measured at call time rather than written down, because a
    number in a document drifts from the code and a number derived from the code
    cannot.
    """
    policy = policy or load_policy()
    rotator = get_rotator()
    status = rotator.status()
    return {
        "version": __version__,
        "tools": len(TOOL_REGISTRY),
        "agents_with_tools": len(AGENT_CAPABILITIES),
        "agents_declared": len(policy.agent_permissions),
        "agents_enabled": len(policy.enabled_agents()),
        "halo_gated_actions": len(HALO_TRIGGERS),
        "rule0_pattern_families": len(SENSITIVE_PATTERNS),
        "provenance_excluded": len(PROVENANCE_SENSITIVE),
        "ladder_slots": status.get("ladder_size"),
        "ladder_slots_reachable": status.get("active_count"),
        "providers_available": status.get("providers_available"),
        "conformance_problems": check_conformance(policy),
    }


__all__ = [
    # policy
    "ConcaPolicy",
    "Policy",
    "load_policy",
    "requires_halo",
    "check_agent_permission",
    "check_path",
    "check_file_size",
    "check_url",
    "is_safe",
    "normalize_command",
    "ShellNormalizer",
    "PolicyViolation",
    "HALO_TRIGGERS",
    "PROVENANCE_SENSITIVE",
    # gate
    "HaloGate",
    "get_gate",
    "ApprovalRequest",
    "ApprovalOutcome",
    "ApprovalOption",
    "InjectionDirective",
    # orchestration
    "Orchestrator",
    "Subtask",
    "TOOL_REGISTRY",
    "AGENT_CAPABILITIES",
    "ExecContext",
    "resolve_tool",
    "redact_secrets",
    # models
    "ModelRotator",
    "get_rotator",
    "CallResult",
    "RotationExhausted",
    # memory
    "MemoryStore",
    "Memory",
    "get_store",
    "ContextEntry",
    "is_sensitive",
    "matched_rule0_families",
    "SENSITIVE_PATTERNS",
    "load_operator_notes",
    "notes_status",
    # transport and identity
    "SseBroker",
    "get_broker",
    "current_role",
    "require_staff",
    "require_local",
    # introspection
    "check_conformance",
    "gated_actions",
    "capabilities",
    "inventory",
    "__version__",
]
