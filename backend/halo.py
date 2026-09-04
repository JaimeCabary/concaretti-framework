"""
HALO Gate — Human-Agent Loop Oversight.

The pause between deciding to do something irreversible and doing it. When a
subtask's action is in `HALO_TRIGGERS`, execution suspends here until a human
answers, and the answer is what resumes it.

Three properties make it more than a confirm dialog:

**Contextual options.** Rather than yes/no, the gate asks a model to propose two
or three action-specific choices for *this* action on *this* payload — typically
approve, a safer alternative ("save as draft instead of sending"), and cancel.
Each option carries an explicit `approves` flag, so the outcome is never inferred
from button position.

**Mid-workflow injection.** The user can answer with free text instead of
picking. "Approve, but first check whether this file is referenced in the repo"
is classified into an approval plus a helper task, which runs and appends its
findings to the paused task's context before the original action resumes.

**Fail-closed.** A timeout, a malformed model response, or a lost connection all
resolve to *rejected*. The gate can only ever be opened by an explicit human
answer; no failure mode approves anything.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from rotator import ModelRotator, extract_json
from sse import SseBroker

DEFAULT_TIMEOUT_SECONDS = 300.0

OPTION_PROMPT = """\
A multi-agent system has paused before performing an irreversible action and \
needs the operator to decide.

Agent:   {agent}
Action:  {action}
Details: {details}
{context_block}
Propose exactly 2 or 3 choices the operator could reasonably take. Requirements:
- Exactly one option approves the action as described.
- At least one option is a genuinely safer alternative that still makes progress \
(for example: draft instead of send, archive instead of delete, dry-run instead \
of execute). Make it specific to this action, not generic.
- One option cancels.
- Labels must be short imperative phrases, at most six words.

Reply with JSON only:
{{"options": [{{"label": "...", "approves": true, "note": "what this does"}}]}}
"""

CLASSIFY_PROMPT = """\
An operator was asked to approve an agent action and replied with free text \
instead of choosing a preset option.

Action:  {action}
Details: {details}
Reply:   "{text}"

Decide:
1. Does the reply ultimately approve the action? (A conditional "yes, but check X \
first" is still an approval.)
2. Does it ask for additional work before proceeding? If so, which agent should \
do it and what is the task?

Available agents: research, email, calendar, file, sms, scheduler

Reply with JSON only:
{{"approves": true, "inject_agent": "research" or null, \
"inject_task": "concrete task description" or null, "reasoning": "one sentence"}}
"""


@dataclass
class ApprovalOption:
    label: str
    approves: bool
    note: str = ""


@dataclass
class InjectionDirective:
    """A helper task the operator asked for before the gated action proceeds."""

    agent: str
    task: str
    reasoning: str = ""
    result: str = ""


@dataclass
class ApprovalOutcome:
    approved: bool
    reason: str
    chosen_label: str = ""
    custom_text: str = ""
    injection: InjectionDirective | None = None


@dataclass
class ApprovalRequest:
    id: str
    session_id: str
    agent: str
    action: str
    details: str
    options: list[ApprovalOption]
    created_at: float = field(default_factory=time.time)
    status: Literal["pending", "approved", "rejected", "timeout"] = "pending"
    future: asyncio.Future[ApprovalOutcome] | None = None
    generated_by: str = ""

    def to_public(self) -> dict[str, Any]:
        """Wire form — deliberately excludes the future."""
        return {
            "id": self.id,
            "session_id": self.session_id,
            "agent": self.agent,
            "action": self.action,
            "details": self.details,
            "options": [
                {"label": o.label, "approves": o.approves, "note": o.note}
                for o in self.options
            ],
            "created_at": self.created_at,
            "status": self.status,
            "generated_by": self.generated_by,
        }


class HaloGate:
    def __init__(self, broker: SseBroker, rotator: ModelRotator) -> None:
        self._broker = broker
        self._rotator = rotator
        self._pending: dict[str, ApprovalRequest] = {}

    # ── option generation ────────────────────────────────────────────────

    async def _generate_options(
        self, agent: str, action: str, details: str, context: str
    ) -> tuple[list[ApprovalOption], str]:
        context_block = f"\nRelevant context:\n{context[:1200]}\n" if context else ""
        prompt = OPTION_PROMPT.format(
            agent=agent, action=action, details=details, context_block=context_block
        )

        try:
            result = await self._rotator.complete(prompt, json_mode=True, max_attempts=3)
            parsed = extract_json(result.text)
            source = result.model_id
        except Exception:
            parsed, source = None, "stub-fallback"

        options: list[ApprovalOption] = []
        if parsed and isinstance(parsed.get("options"), list):
            for raw in parsed["options"][:3]:
                if not isinstance(raw, dict):
                    continue
                label = str(raw.get("label", "")).strip()
                if not label:
                    continue
                options.append(
                    ApprovalOption(
                        label=label[:60],
                        approves=bool(raw.get("approves", False)),
                        note=str(raw.get("note", ""))[:160],
                    )
                )

        # A response with no approving option would make the gate impossible to
        # open, so fall back rather than presenting a dead end.
        if not options or not any(o.approves for o in options):
            options = self._stub_options(action)
            source = f"{source} → stub (unusable options)"

        # Guarantee an explicit refusal path regardless of what the model said.
        if not any(not o.approves for o in options):
            options.append(ApprovalOption("Cancel", approves=False, note="Abort this step"))

        return options, source

    def _stub_options(self, action: str) -> list[ApprovalOption]:
        labels = self._rotator.stub.approval_options(action, "")
        out: list[ApprovalOption] = []
        for i, label in enumerate(labels[:3]):
            out.append(ApprovalOption(label=label, approves=(i == 0)))
        return out

    # ── the gate ─────────────────────────────────────────────────────────

    async def request_approval(
        self,
        session_id: str,
        agent: str,
        action: str,
        details: str,
        *,
        context: str = "",
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        on_injection: Any = None,
    ) -> ApprovalOutcome:
        """
        Suspend until the operator answers.

        `on_injection` is an optional async callable `(agent, task) -> str` used
        to run a helper task the operator asked for. It is injected rather than
        imported to keep this module free of any dependency on the agent layer.
        """
        options, source = await self._generate_options(agent, action, details, context)

        req = ApprovalRequest(
            id=f"halo-{uuid.uuid4().hex[:12]}",
            session_id=session_id,
            agent=agent,
            action=action,
            details=details,
            options=options,
            generated_by=source,
        )
        req.future = asyncio.get_running_loop().create_future()
        self._pending[req.id] = req

        self._broker.publish(session_id, "halo_request", req.to_public())
        self._broker.activity(
            session_id, f"Paused for approval: {agent} wants to {action}"
        )

        try:
            outcome = await asyncio.wait_for(req.future, timeout=timeout)
        except asyncio.TimeoutError:
            req.status = "timeout"
            outcome = ApprovalOutcome(
                approved=False,
                reason=f"No response within {int(timeout)}s — refused by default",
            )
            self._broker.publish(
                session_id,
                "halo_resolved",
                {"id": req.id, "approved": False, "reason": outcome.reason},
            )
        except asyncio.CancelledError:
            req.status = "rejected"
            self._pending.pop(req.id, None)
            raise
        else:
            # Run any helper task the operator asked for before the gated action
            # proceeds — the whole point of a conditional approval.
            if outcome.injection and outcome.approved and on_injection is not None:
                inj = outcome.injection
                self._broker.activity(
                    session_id,
                    f"Injecting {inj.agent} task before resuming: {inj.task}",
                )
                try:
                    inj.result = await on_injection(inj.agent, inj.task)
                except Exception as exc:
                    inj.result = f"[injection failed: {type(exc).__name__}: {exc}]"
                self._broker.publish(
                    session_id,
                    "halo_resolved",
                    {
                        "id": req.id,
                        "approved": True,
                        "reason": outcome.reason,
                        "injection": {
                            "agent": inj.agent,
                            "task": inj.task,
                            "result": inj.result[:2000],
                        },
                    },
                )
        finally:
            self._pending.pop(req.id, None)

        return outcome

    # ── resolution ───────────────────────────────────────────────────────

    async def resolve(
        self,
        approval_id: str,
        *,
        choice_index: int | None = None,
        custom_text: str | None = None,
    ) -> dict[str, Any]:
        """
        Answer a pending gate, by option index or free text.

        Called from the HTTP layer, so it validates rather than trusting input:
        an unknown id or an out-of-range index is a client error, not a crash.
        """
        req = self._pending.get(approval_id)
        if req is None:
            return {"ok": False, "error": "unknown or already-resolved approval id"}
        if req.future is None or req.future.done():
            return {"ok": False, "error": "approval already resolved"}

        if custom_text and custom_text.strip():
            outcome = await self._resolve_custom(req, custom_text.strip())
        elif choice_index is not None:
            if not (0 <= choice_index < len(req.options)):
                return {"ok": False, "error": f"choice_index out of range (0..{len(req.options) - 1})"}
            option = req.options[choice_index]
            outcome = ApprovalOutcome(
                approved=option.approves,
                reason=f'Operator chose "{option.label}"',
                chosen_label=option.label,
            )
        else:
            return {"ok": False, "error": "provide either choice_index or custom_text"}

        req.status = "approved" if outcome.approved else "rejected"
        req.future.set_result(outcome)

        if not outcome.injection:
            self._broker.publish(
                req.session_id,
                "halo_resolved",
                {
                    "id": req.id,
                    "approved": outcome.approved,
                    "reason": outcome.reason,
                    "chosen": outcome.chosen_label,
                },
            )

        return {
            "ok": True,
            "approved": outcome.approved,
            "reason": outcome.reason,
            "injection": (
                {"agent": outcome.injection.agent, "task": outcome.injection.task}
                if outcome.injection
                else None
            ),
        }

    async def _resolve_custom(
        self, req: ApprovalRequest, text: str
    ) -> ApprovalOutcome:
        """Classify a free-text answer into an approval plus optional helper task."""
        prompt = CLASSIFY_PROMPT.format(action=req.action, details=req.details, text=text)

        parsed: dict[str, Any] | None = None
        try:
            result = await self._rotator.complete(prompt, json_mode=True, max_attempts=3)
            parsed = extract_json(result.text)
        except Exception:
            parsed = None

        if parsed is None:
            # Cannot establish intent, so cannot treat it as consent.
            return ApprovalOutcome(
                approved=False,
                reason=(
                    "Could not interpret the free-text reply; refused by default. "
                    "Pick an option to proceed."
                ),
                custom_text=text,
            )

        approves = bool(parsed.get("approves", False))
        injection: InjectionDirective | None = None
        agent = parsed.get("inject_agent")
        task = parsed.get("inject_task")
        if approves and isinstance(agent, str) and isinstance(task, str) and agent and task:
            injection = InjectionDirective(
                agent=agent.strip().lower(),
                task=task.strip(),
                reasoning=str(parsed.get("reasoning", "")),
            )

        return ApprovalOutcome(
            approved=approves,
            reason=str(parsed.get("reasoning", "Interpreted from operator's reply")),
            custom_text=text,
            injection=injection,
        )

    # ── introspection ────────────────────────────────────────────────────

    def list_pending(self, session_id: str | None = None) -> list[dict[str, Any]]:
        reqs = self._pending.values()
        if session_id:
            reqs = [r for r in reqs if r.session_id == session_id]
        return [r.to_public() for r in reqs]


_gate: HaloGate | None = None


def get_gate(broker: SseBroker, rotator: ModelRotator) -> HaloGate:
    global _gate
    if _gate is None:
        _gate = HaloGate(broker, rotator)
    return _gate
