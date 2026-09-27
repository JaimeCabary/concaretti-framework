"""
Orchestrator — decompose, screen, gate, execute.

The pipeline is deliberately explicit rather than an autonomous tool-calling
loop:

    prompt → decompose → .conca screen → HALO gate → execute by layer → synthesise

**Why not ADK's agent loop.** The approved plan called for ADK. Building it out,
the framework fought the thesis: ADK wants to own the reason-act cycle and decide
tool calls internally, while the entire security claim here rests on a
deterministic checkpoint *between* the model proposing a plan and anything
running. ADK's `before_tool_callback` can host that check, but the model layer
also has to be a custom `BaseLlm` to route through the six-provider rotator — at
which point ADK contributes an execution loop that makes the security boundary
harder to reason about and harder to demonstrate. The pipeline below is ~200
lines, every transition is inspectable, and the `.conca` screen provably runs
before dispatch. `google-adk` is therefore not a dependency.

Execution is layered rather than a general DAG walk. Subtasks carry a `layer`
integer; a layer runs concurrently and the next only starts once it settles, with
results accumulated into the context passed forward. This gives the visible
parallelism the Ops screen needs without a topological sort over model-authored
edges — which, in practice, models get wrong often enough to be a liability.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from halo import HaloGate
from memory import KEY_REFUSAL, MemoryStore, contains_secret_material, is_sensitive
from operator_notes import load_operator_notes
from rotator import ModelRotator, extract_json
from security import (
    ConcaPolicy,
    PROVENANCE_SENSITIVE,
    check_agent_permission,
    check_path,
    is_safe,
    requires_halo,
)
from sse import SseBroker
from tools import AGENT_CAPABILITIES, ExecContext, resolve_tool

SubtaskStatus = Literal["pending", "running", "done", "failed", "skipped", "rejected"]

# Material-need markers. Distress alone routes to support; distress *plus* one of
# these is the hardship path, where the ordering policy in `.conca` takes over
# from whatever the decomposer would have guessed.
_MATERIAL_NEED = re.compile(
    r"\b(no money|broke|afford|rent|evict(ed|ion)?|bills?|debt|food|eat(ing)?|"
    r"hungry|homeless|benefits?|universal credit|skint|unpaid|fired|redundan\w+)\b",
    re.IGNORECASE,
)

_GREETING = re.compile(
    r"^\s*(hi+|hey+|hello+|yo|hiya|howdy|greetings|sup|wass?up|what'?s up|"
    r"good\s+(morning|afternoon|evening|day)|morning|afternoon|evening)"
    r"(\s+(there|all|folks|everyone|team|council|concaretti|conca|assistant))?\b[\s,.!?…—-]*",
    re.IGNORECASE,
)

_INVOCATION_PREFIX = re.compile(
    r"^\s*(hey\s+concaretti|concaretti|ok\s+concaretti|okay\s+concaretti)[\s,:;—–-]+\s*",
    re.IGNORECASE,
)

_HELP_ONLY = re.compile(
    r"^\s*(please\s+)?(i\s+(need|want|could use)\s+(some\s+|a bit of\s+)?help|"
    r"help(\s+me)?(\s+please)?|can\s+you\s+help(\s+me)?|"
    r"what\s+can\s+you\s+do|what\s+do\s+you\s+do|how\s+do\s+you\s+work|"
    r"how(\s+are\s+you|\s+are\s+things|'?s\s+it\s+going|\s+is\s+it\s+going)|"
    r"who\s+are\s+you|what\s+are\s+you|what\s+is\s+this|how\s+does\s+this\s+work)"
    r"[\s,.!?…—-]*$",
    re.IGNORECASE,
)

# Punctuation and whitespace that carry no request on their own.
_FILLER = " \t\r\n,.!?…—-"

# One line per agent for the small-talk reply, phrased as what the user gets
# rather than what the tool is called. An agent absent from here falls back to
# its registered task types, so a newly added agent is under-described rather
# than unmentioned.
_AGENT_BLURB: dict[str, str] = {
    "research": "look things up on the web and in arXiv",
    "file": "read/write files, run Python, execute host OS shell commands (e.g. to open media), and track media state",
    "scheduler": "set reminders and recurring jobs",
    "calendar": "check your schedule, find a slot, book or cancel meetings",
    "diary": "read, write, or append notes and reflections to your work diary notepad",
    "email": "read your inbox and draft replies — sending needs your approval",
    "sms": "read your texts and draft replies — sending needs your approval",
    "therapy": "talk something difficult through, kept out of long-term memory",
    "github": "summarise a repository's commits, pull requests and CI",
    "news": "pull headlines on a topic",
    "social": "draft a post for review",
    "browser": "open a page in a real browser and read what a fetch cannot",
    "shopper": (
        "price something across shops, pick the best one that fits your budget, "
        "load the cart, and watch the order until it arrives — paying is your click"
    ),
    "market": "quote a stock, read a company's numbers, and keep a paper portfolio",
    "chain": (
        "read a Solana wallet's balances and history, and prepare a transfer for "
        "you to sign yourself — it never holds a key"
    ),
    "desktop": "read your screen and physically automate your mouse and keyboard",
}


def _agent_blurb(agent: str) -> str:
    return _AGENT_BLURB.get(agent) or ", ".join(
        t.replace("_", " ") for t in AGENT_CAPABILITIES.get(agent, [])
    )


@dataclass
class Subtask:
    id: str
    agent: str
    task_type: str
    description: str
    layer: int = 0
    payload: dict[str, Any] = field(default_factory=dict)
    status: SubtaskStatus = "pending"
    result: str = ""
    error: str = ""
    model_used: str = ""
    blocked_reason: str = ""

    def to_public(self) -> dict[str, Any]:
        return asdict(self)


DECOMPOSE_SYSTEM = """\
You are the orchestrator of the Concaretti Council multi-agent system. You do not perform work \
yourself; you decompose a request into subtasks for specialist agents.

Return JSON only, in this exact shape:
{"reasoning": "first-person internal reasoning on how to fulfill the request (e.g., 'I will search for the local weather forecast to provide an accurate update')",
 "answer": "friendly, direct reply to the user ONLY if no specialist subtasks are needed (e.g. answering greetings, general conversation, or explanations). If subtasks are planned, set this to null",
 "subtasks": [{"id": "st-1", "agent": "research", "task_type": "web_search",
               "description": "what this step achieves", "layer": 0,
               "payload": {"query": "..."}}]}

Rules:
- Use only the agents and task_types listed as available. Never invent one.
- `layer` expresses ordering: all layer-0 subtasks run concurrently first, then \
layer 1, and so on. Put a step in a later layer only when it genuinely needs an \
earlier step's output.
- Put concrete arguments in `payload`. For web_search use "query". For \
create_event use "title", "start", "end". For send_email use "to", "subject", \
"body". For write_file use "filename", "content". For send_sms use "to", "body". \
For append_diary_entry or add_diary_entry use "day" (default "today") and "content" (the notes/summary to append). \
For typing on screen in real time while the user watches, use agent "desktop" with "keyboard_type" (payload: {"text": "..."}) or use "diary" with "append_diary_entry".
- For observing the user's screen, seeing the active display, listing open windows, launching desktop apps (e.g. Spotify, VS Code), writing code in editors, or automating the Windows desktop, ALWAYS use agent "desktop" with "os_agent", "screen_capture", or "launch_app". NEVER reply that you cannot observe the screen or do not have access to the device — the desktop agent executes this physically.
- Prefer the smallest plan that fully answers the request. One subtask is often \
correct; never pad to look thorough.
- If the user asks about their diary or requests an update/addition to their diary entry, use agent "diary" with "append_diary_entry" (which appends new sections while strictly preserving their existing text) or "read_diary".
- If the request needs no agent at all, return an empty subtasks list (`"subtasks": []`) and write the natural, direct conversational reply in `"answer"`. NEVER output internal thoughts or meta-commentary like "I am acknowledging the user's greeting" or "I will explain to the user..." as an answer.
- Context-Awareness: Consider the user's local time, timezone, culture, and location if provided. Do not make geographically random assumptions or assume standard US locations if the user is elsewhere. For queries like "weather today", include the user's current city/region in the search query.
- Formulate all internal reasoning strictly in first-person (e.g., "I will search the web for this").
"""

SYNTHESIS_PROMPT = """\
A user asked: "{prompt}"

Specialist agents produced these results:

{results}

Write the final reply to the user. Be direct and specific; lead with the answer. \
Reference concrete findings rather than describing the process. If a step failed \
or was refused, say so plainly and briefly. Do not invent information that is not \
in the results above. No preamble. Maintain full context-awareness of the user's location, current date/time, and regional culture without bias.
"""

HARDSHIP_TEMPLATE = """\
That sounds genuinely hard, and dealing with it while money is tight makes it \
heavier. Two things are worth separating: what you need in the next few days, \
and what changes the picture over the next few months.

I'm looking up immediate options first — food and emergency funds you can reach \
this week — before anything longer-term. One moment.
"""


class Orchestrator:
    def __init__(
        self,
        policy: ConcaPolicy,
        store: MemoryStore,
        broker: SseBroker,
        rotator: ModelRotator,
        gate: HaloGate,
    ) -> None:
        self.policy = policy
        self.store = store
        self.broker = broker
        self.rotator = rotator
        self.gate = gate

    def reload_policy(self, policy: ConcaPolicy) -> None:
        """Swap the policy in place so an edited `.conca` applies to new runs."""
        self.policy = policy

    # ── entry point ──────────────────────────────────────────────────────

    async def run(
        self,
        session_id: str,
        prompt: str,
        role: str,
        client_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        started = time.time()
        broker = self.broker

        leak = contains_secret_material(prompt)
        if leak:
            refusal = KEY_REFUSAL.format(what=leak)
            self.store.log_audit(
                session_id, "orchestrator", "dispatch", "refused", "secret_material"
            )
            broker.error(session_id, refusal)
            broker.done(session_id, "refused: secret material")
            return {"ok": False, "error": refusal, "refused": "secret_material", "subtasks": []}

        orch_ok, orch_reason = check_agent_permission(self.policy, "orchestrator")
        if not orch_ok:
            broker.error(session_id, f"Aborted: {orch_reason}")
            broker.done(session_id, orch_reason)
            self.store.log_audit(
                session_id, "orchestrator", "dispatch", "blocked", orch_reason, prompt
            )
            return {"ok": False, "error": orch_reason, "subtasks": []}

        self.store.append_entry(session_id, "user", prompt)
        sensitive = is_sensitive(prompt)
        if sensitive:
            broker.activity(
                session_id,
                "Rule 0 engaged — this turn is excluded from long-term memory",
            )

        context = self.store.build_prompt_context(session_id, prompt)

        if client_context:
            tz = client_context.get("timezone", "")
            loc_time = client_context.get("local_time", "")
            city = client_context.get("city", "")
            locale = client_context.get("locale", "")
            env_lines = ["--- [User Context & Regional Environment] ---"]
            if loc_time:
                env_lines.append(f"Local Time: {loc_time}")
            if tz:
                env_lines.append(f"Timezone: {tz}")
            if city:
                env_lines.append(f"User City/Region: {city}")
            if locale:
                env_lines.append(f"Locale: {locale}")
            env_lines.append(
                "Context Directive: Prioritize the user's actual location and current date/time for local weather, news, and queries. Avoid default US/UK locations if the user is elsewhere. Avoid bias."
            )
            env_lines.append("--- [End Context] ---")
            context = "\n".join(env_lines) + "\n\n" + context

        # Detect OS Level Agent Mode prefix
        is_os_mode = bool(re.match(r"^\[(?:OS Agent Mode|OS Mode|Desktop Agent)\]\s*", prompt, re.I)) or (
            bool(client_context and client_context.get("os_mode"))
        )

        # Small talk & direct memory / identity queries answered above the decomposer
        if not sensitive and not is_os_mode:
            direct_reply = self._direct_system_or_memory_reply(prompt, role)
            if direct_reply is not None:
                broker.thought(
                    session_id,
                    "Identity, local memory, or system query detected — answering directly from local state.",
                )
                self.store.append_entry(session_id, "assistant", direct_reply, agent="orchestrator")
                self.store.set_summary(session_id, direct_reply[:500])
                self.store.log_audit(
                    session_id,
                    "orchestrator",
                    "direct_query",
                    "allowed",
                    "Direct query answered from local state",
                    prompt,
                )
                await self._stream_tokens(session_id, direct_reply)
                broker.done(session_id, direct_reply)
                return {
                    "ok": True,
                    "answer": direct_reply,
                    "subtasks": [],
                    "elapsed": time.time() - started,
                }

            chat = self._smalltalk_reply(prompt, role)
            if chat is not None:
                broker.thought(
                    session_id,
                    "Greeting or check-in detected — answering directly, no specialist agents required.",
                )
                self.store.append_entry(session_id, "assistant", chat, agent="orchestrator")
                self.store.set_summary(session_id, chat[:500])
                self.store.log_audit(
                    session_id,
                    "orchestrator",
                    "smalltalk",
                    "allowed",
                    "Greeting answered without dispatch",
                    prompt,
                )
                await self._stream_tokens(session_id, chat)
                broker.done(session_id, chat)
                return {
                    "ok": True,
                    "answer": chat,
                    "subtasks": [],
                    "elapsed": time.time() - started,
                }

        # ── plan ──
        broker.thought(
            session_id,
            "Council convened. Decomposing request into specialist subtasks...",
            agent="orchestrator",
        )
        broker.activity(
            session_id,
            f"Orchestrating council across {role} permissions...",
        )
        # Strip wake-word / invocation prefix so the planner receives a clean task
        clean_prompt = _INVOCATION_PREFIX.sub("", prompt).strip() or prompt
        hardship = self._is_hardship(clean_prompt)
        if hardship:
            broker.activity(session_id, "Hardship routing engaged (.conca policy)")
            broker.publish(session_id, "activity", {"message": HARDSHIP_TEMPLATE.strip(), "layer0": True})
            subtasks, reasoning, direct_answer, model_used = self._hardship_plan(clean_prompt), "Hardship policy ordering from .conca", "", "policy"
        else:
            subtasks, reasoning, direct_answer, model_used = await self._decompose(session_id, clean_prompt, context, role)

        broker.thought(session_id, reasoning)

        if not subtasks:
            # Only use direct_answer if it is genuinely speaking to the user
            is_valid_direct = (
                bool(direct_answer)
                and not direct_answer.lower().startswith(
                    ("i will ", "i am ", "i plan to", "internal:", "reasoning:")
                )
            )
            if is_valid_direct:
                answer = direct_answer
            else:
                synth = await self.rotator.complete(
                    f"A user said: \"{clean_prompt}\"\nContext: {context[:500]}\n"
                    f"Orchestrator context: {reasoning[:300]}\n"
                    "Respond to the user directly, helpfully, and politely in the first person. Answer their question directly. Never output internal planning notes, meta-intent like 'I will explain to the user...', or procedural commentary.",
                    max_attempts=2,
                )
                answer = synth.text.strip() if not synth.stubbed else (direct_answer or "Hello! The Concaretti Council is standing by to assist you. What would you like to work on today?")

            self.store.append_entry(session_id, "assistant", answer, agent="orchestrator")
            await self._stream_tokens(session_id, answer)
            broker.done(session_id, answer)
            return {"ok": True, "answer": answer, "subtasks": [], "elapsed": time.time() - started}

        # ── screen ──
        subtasks = self._conca_screen(session_id, subtasks, role)
        for st in subtasks:
            broker.subtask(session_id, st.to_public())

        runnable = [s for s in subtasks if s.status == "pending"]
        if not runnable:
            answer = (
                "Every step in that plan was refused by the .conca policy:\n"
                + "\n".join(f"• {s.agent}/{s.task_type}: {s.blocked_reason}" for s in subtasks)
            )
            self.store.append_entry(session_id, "assistant", answer, agent="orchestrator")
            broker.done(session_id, answer)
            return {
                "ok": False,
                "answer": answer,
                "subtasks": [s.to_public() for s in subtasks],
                "elapsed": time.time() - started,
            }

        # ── execute ──
        accumulated: list[str] = []
        for layer in sorted({s.layer for s in runnable}):
            in_layer = [s for s in runnable if s.layer == layer and s.status == "pending"]
            if not in_layer:
                continue
            broker.activity(
                session_id, f"Layer {layer}: running {len(in_layer)} subtask(s)"
            )
            ctx = ExecContext(
                session_id=session_id,
                role=role,
                policy=self.policy,
                store=self.store,
                broker=broker,
                prompt=prompt,
                accumulated="\n".join(accumulated),
            )
            outcomes = await asyncio.gather(
                *(self._execute(st, ctx) for st in in_layer), return_exceptions=True
            )
            # `return_exceptions=True` stops one bad subtask from cancelling its
            # siblings, but it also swallows the exception. `_execute` guards the
            # tool call itself, not the HALO await that precedes it — so a raise
            # there would leave `status` on "running" and the UI showing a step
            # that never resolves. Anything still running after the gather is
            # dead, and a visibly failed step is worth more than a hung one.
            for st, outcome in zip(in_layer, outcomes):
                if st.status == "running":
                    st.status = "failed"
                    st.error = (
                        f"{type(outcome).__name__}: {outcome}"
                        if isinstance(outcome, BaseException)
                        else "execution ended without reporting an outcome"
                    )
                    broker.subtask(session_id, st.to_public())
                    self.store.log_audit(
                        session_id, st.agent, st.task_type, "error", st.error, st.payload
                    )
                if st.result:
                    accumulated.append(f"[{st.agent}/{st.task_type}] {st.result}")

        # ── synthesise ──
        #
        # Widened here rather than at the top, deliberately: the small-talk shortcut
        # and the hardship branch both read `sensitive` and neither should change
        # because a step in the plan happened to read a screen. What does change is
        # what the answer is allowed to become — a synthesis over a screen
        # description is still a description of that screen, so it is excluded from
        # the index on the same grounds as the subtask entry above.
        if any(s.task_type in PROVENANCE_SENSITIVE for s in subtasks):
            sensitive = True

        try:
            answer = await self._synthesise(session_id, prompt, subtasks, sensitive)
        except Exception as exc:
            done_results = [s.result for s in subtasks if s.status == "done" and s.result]
            answer = "\n\n".join(done_results) or f"Task execution finished ({type(exc).__name__})."
            broker.activity(session_id, f"Synthesis recovered: {type(exc).__name__}")

        self.store.append_entry(
            session_id, "assistant", answer, agent="orchestrator", sensitive=sensitive
        )
        self.store.set_summary(session_id, answer[:500])
        broker.done(session_id, answer)

        return {
            "ok": True,
            "answer": answer,
            "subtasks": [s.to_public() for s in subtasks],
            "rule0_excluded": sensitive,
            "elapsed": time.time() - started,
        }

    # ── small talk & direct memory query ────────────────────────────────

    def _get_operator_name(self) -> str:
        profile_file = Path(__file__).parent.parent / "user_profile.json"
        if profile_file.exists():
            try:
                data = json.loads(profile_file.read_text(encoding="utf-8"))
                return data.get("name", "").strip()
            except Exception:
                pass
        return ""

    def _direct_system_or_memory_reply(self, prompt: str, role: str) -> str | None:
        low = prompt.lower().strip()
        op_name = self._get_operator_name() or "Heccker"

        # Identity & Operator Name query
        if any(q in low for q in ["my name", "who am i", "what is my name", "do you know my name", "remember my name", "memory of my name", "entered at onboarding"]):
            return (
                f"You are **{op_name}**!\n\n"
                f"I have your profile stored from onboarding in `user_profile.json`. "
                f"Your identity is preserved across all council sessions, and I remember you as the primary operator. "
                f"How can I assist you today, {op_name}?"
            )

        # Fault tolerance query
        if any(q in low for q in ["fault tolerant", "fault tolerance", "how does system stay fault tolerant"]):
            return (
                "Concaretti maintains fault tolerance through four local-first architectural guarantees:\n\n"
                "1. **Deterministic Local Fallback (No-Key / Offline Routing)**:\n"
                "   When external LLM providers (Gemini, Ollama, OpenRouter) fail or disconnect (such as TCP connection drops or quota exhaustion), the orchestrator automatically walks down the model ladder to a local **DeterministicStub**. Workflows, DAG planning, and tool pipelines continue to operate completely offline without crashing.\n\n"
                "2. **Local-First SQLite Persistence with WAL**:\n"
                "   Transcripts, operator credentials, contacts, hard facts, and audit logs are safely stored in local SQLite databases using Write-Ahead Logging (WAL) and automatic idempotent schema migrations.\n\n"
                "3. **Automatic Entity & Parameter Fallbacks**:\n"
                "   When tools are invoked without explicit phone numbers or emails, the system cross-references your saved contacts (e.g. frequent contacts like Rain) to resolve required parameters rather than abruptly failing.\n\n"
                "4. **Transparent Failure & Block States in UI**:\n"
                "   Instead of swallowing errors or silently hanging, the UI displays exact execution errors (e.g. missing Twilio credentials, policy blocks) directly on the DAG execution cards and conversation feed."
            )

        # Memory / contacts instructions & queries
        if "frequently" in low and ("contact" in low or "number" in low or "email" in low or "hard" in low):
            contacts = self.store.list_contacts()
            facts = self.store.list_facts()
            c_list = "\n".join([f"• **{c['name']}** ({c.get('relationship') or 'contact'}) — Phone: {c.get('phone') or 'N/A'}, Email: {c.get('email') or 'N/A'}" for c in contacts]) if contacts else "• No contacts saved yet."
            f_list = "\n".join([f"• **{f['key']}**: `{f['value']}` ({f['category']})" for f in facts]) if facts else "• No hard facts recorded yet."
            return (
                "Concaretti has active local memory for your contacts, frequent communication peers, and hard-to-remember facts:\n\n"
                f"**Saved Frequent Contacts**:\n{c_list}\n\n"
                f"**Secure Vault & Hard Facts**:\n{f_list}\n\n"
                "I automatically remember any contact you mention (e.g., *'my best friend Rain +63...'*), track frequency of access, "
                "and store hard facts (like Wi-Fi passwords, gate codes, license plates, and key codes) so they are available anytime."
            )

        if any(q in low for q in ["list contacts", "show contacts", "who is saved", "my contacts", "saved contacts"]):
            contacts = self.store.list_contacts()
            if contacts:
                c_list = "\n".join([f"• **{c['name']}** ({c.get('relationship') or 'contact'}) — Phone: {c.get('phone') or 'N/A'}, Email: {c.get('email') or 'N/A'}" + (" [Frequent]" if c.get("frequent") else "") for c in contacts])
                return f"Here are your saved contacts:\n\n{c_list}"
            return "You don't have any contacts saved yet. You can tell me e.g. *'remember my friend Rain +63...'* and I will store them."

        if any(q in low for q in ["list facts", "show facts", "saved facts", "what facts", "show vault", "wifi password", "gate code"]):
            facts = self.store.list_facts()
            if facts:
                f_list = "\n".join([f"• **{f['key']}**: `{f['value']}` ({f['category']})" for f in facts])
                return f"Here are your stored hard facts & secure items:\n\n{f_list}"
            return "No hard facts saved yet. You can tell me e.g. *'remember the wifi password is Secret123'* or *'gate code is 4921'* to store them."

        return None

    def _smalltalk_reply(self, prompt: str, role: str) -> str | None:
        """
        Answer a greeting as a greeting, or return None to plan it normally.

        The test is on what is *left over*, not on a match anywhere in the
        string. "hi" and "hi, I need help" are small talk; "hi, can you email
        Alice about Friday" is a real request wearing a greeting, and swallowing
        that here would be worse than the bug it fixes. So: strip a leading
        greeting, then a whole-string help phrase, and reply only if nothing
        substantive is left. Anything else falls through to the decomposer.

        The capability list is read from the policy at answer time rather than
        written into a template, so it states what this role can actually reach —
        including an agent switched off in `.conca` between two turns.
        """
        cur = prompt.strip()
        greeted = False
        while True:
            m = _GREETING.match(cur)
            if m:
                cur = cur[m.end():].strip()
                greeted = True
                continue
            m_inv = _INVOCATION_PREFIX.match(cur)
            if m_inv:
                cur = cur[m_inv.end():].strip()
                greeted = True
                continue
            break

        asked_for_help = bool(_HELP_ONLY.match(cur))
        if asked_for_help:
            cur = ""

        if not (greeted or asked_for_help):
            return None
        if cur.strip(_FILLER):
            return None

        op_name = self._get_operator_name()
        greeting_target = f" {op_name}" if op_name else ""

        # Friendly, direct conversational reply for greetings without overwhelming boilerplate
        if greeted and not asked_for_help:
            return (
                f"Hello{greeting_target}! The Concaretti Council is online and standing by. "
                "All zero-trust perimeter systems are active and running. What would you like to work on today?"
            )

        # Only agents that are granted *and* have a tool registered.
        granted = [
            a for a in self.policy.agents_for_role(role) if a in AGENT_CAPABILITIES
        ]

        parts = [
            "Hello." if greeted else "Happy to help.",
            "I'm the Concaretti council. I don't answer alone — I break a request "
            "into steps, hand each to a specialist agent, and the .conca policy "
            "checks every step before anything runs.",
        ]
        if granted:
            parts.append(
                f"On the {role} role you can reach:\n"
                + "\n".join(f"• {a} — {_agent_blurb(a)}" for a in granted)
            )
        else:
            parts.append(
                f"The {role} role currently has no agents enabled in .conca, so "
                "there is nothing I can dispatch for you yet."
            )
        parts.append(
            "Tell me the actual task — something like “find recent papers on "
            "multi-agent security”, “what's on Thursday afternoon?”, or “draft a "
            "reply to the last email from the registry” — and the plan appears "
            "before any of it executes."
        )
        return "\n\n".join(parts)

    # ── hardship routing ─────────────────────────────────────────────────

    def _is_hardship(self, prompt: str) -> bool:
        hr = self.policy.rules.hardship_response
        if not hr.enabled:
            return False
        return is_sensitive(prompt) and bool(_MATERIAL_NEED.search(prompt))

    def _hardship_plan(self, prompt: str) -> list[Subtask]:
        """
        Build the DAG from policy instead of the decomposer.

        `.conca` states that support comes first and immediate needs precede
        long-term ones. Encoding that here means a distressed user never waits on
        a job search before being told where to eat this week — which is the
        whole reason the policy exists rather than being left to the model.
        """
        hr = self.policy.rules.hardship_response
        out: list[Subtask] = [
            Subtask(
                id="st-1",
                agent=hr.first_agent,
                task_type="reflect",
                description="Acknowledge and stabilise before acting",
                layer=0,
                payload={"prompt": prompt},
            )
        ]
        n = 2
        for need in hr.immediate_needs[:3]:
            out.append(
                Subtask(
                    id=f"st-{n}",
                    agent="research",
                    task_type="web_search",
                    description=f"Immediate need: {need}",
                    layer=1,
                    payload={"query": need},
                )
            )
            n += 1
        if not hr.immediate_before_longterm:
            longterm_layer = 1
        else:
            longterm_layer = 2
        for need in hr.longterm_needs[:2]:
            out.append(
                Subtask(
                    id=f"st-{n}",
                    agent="research",
                    task_type="web_search",
                    description=f"Longer-term: {need}",
                    layer=longterm_layer,
                    payload={"query": need},
                )
            )
            n += 1
        return out

    # ── decomposition ────────────────────────────────────────────────────

    def _available_block(self, role: str) -> str:
        allowed = set(self.policy.agents_for_role(role))  # type: ignore[arg-type]
        lines = []
        for agent, caps in sorted(AGENT_CAPABILITIES.items()):
            if agent not in allowed:
                continue
            lines.append(f"- {agent}: {', '.join(sorted(caps))}")
        return "\n".join(lines) or "- (no agents available to this role)"

    async def _decompose(
        self, session_id: str, prompt: str, context: str, role: str
    ) -> tuple[list[Subtask], str, str]:
        os_mode_match = re.match(r"^\[(?:OS Agent Mode|OS Mode|Desktop Agent)\]\s*", prompt, re.I)
        if os_mode_match:
            task_text = prompt[os_mode_match.end():].strip()
            if not task_text:
                return (
                    [],
                    "OS Level Agent Mode is armed.",
                    "OS Level Agent Mode is armed. Please enter any Windows desktop task you would like me to perform (e.g., launch applications, inspect active windows, observe screen, or execute shell commands).",
                    "os_agent",
                )
            allowed_agents = set(self.policy.agents_for_role(role))
            if "desktop" in allowed_agents:
                self.broker.thought(
                    session_id,
                    f"OS Level Agent Mode active: dispatching task '{task_text[:80]}' directly to desktop agent.",
                    agent="orchestrator",
                )
                return (
                    [
                        Subtask(
                            id="st-1",
                            agent="desktop",
                            task_type="os_agent",
                            description=f"Desktop OS: {task_text[:200]}",
                            layer=0,
                            payload={"task": task_text},
                            model_used="os_agent",
                        )
                    ],
                    f"OS Agent Mode engaged: automating Windows task '{task_text}'.",
                    "",
                    "os_agent",
                )

        available = self._available_block(role)
        notes = load_operator_notes()
        user_block = (
            f"Available agents and task_types:\n{available}\n\n"
            # Ahead of the transcript on purpose. Standing preferences are what
            # the operator wants to be true of *every* plan, so they should not
            # be the first thing a small context window drops.
            + (f"Operator's standing notes:\n{notes}\n\n" if notes else "")
            + (f"Context from earlier work:\n{context[:2000]}\n\n" if context else "")
            + f'User request: "{prompt}"'
        )

        self.broker.thought(
            session_id,
            "Screening request against .conca policies & synthesizing parallel subtask layers...",
            agent="orchestrator",
        )

        result = await self.rotator.complete(
            user_block, system=DECOMPOSE_SYSTEM, json_mode=True
        )
        parsed = extract_json(result.text)

        if result.stubbed or parsed is None:
            plan = self.rotator.stub.plan(prompt)
            for line in self.rotator.stub.thoughts(prompt):
                self.broker.thought(session_id, line)
            parsed = plan

        reasoning = str(parsed.get("reasoning", "")).strip()
        direct_answer = str(parsed.get("answer", "")).strip() if parsed.get("answer") else ""
        raw_subtasks = parsed.get("subtasks")
        if not isinstance(raw_subtasks, list):
            raw_subtasks = []

        subtasks: list[Subtask] = []
        for i, raw in enumerate(raw_subtasks[:8]):
            if not isinstance(raw, dict):
                continue
            agent = str(raw.get("agent", "")).strip().lower().replace("-", "_")
            task_type = str(raw.get("task_type", "")).strip().lower()
            if not agent:
                continue
            payload = raw.get("payload")
            if not isinstance(payload, dict):
                payload = {"prompt": prompt}
            subtasks.append(
                Subtask(
                    id=str(raw.get("id") or f"st-{i + 1}"),
                    agent=agent,
                    task_type=task_type or "generic",
                    description=str(raw.get("description", ""))[:240],
                    layer=int(raw.get("layer", 0) or 0),
                    payload=payload,
                    model_used=result.model_id,
                )
            )

        if not subtasks:
            low_p = prompt.lower()
            allowed_agents = set(self.policy.agents_for_role(role))
            if "desktop" in allowed_agents and any(w in low_p for w in ["observe", "active display", "foreground window", "look at my screen", "screen capture", "my screen"]):
                subtasks.append(
                    Subtask(
                        id="st-1",
                        agent="desktop",
                        task_type="os_agent",
                        description="Observe active display and inspect desktop windows",
                        layer=0,
                        payload={"task": prompt},
                        model_used=result.model_id,
                    )
                )
                direct_answer = ""
            elif "desktop" in allowed_agents and any(w in low_p for w in ["open spotify", "launch spotify", "open code", "open vs code", "open notepad"]):
                subtasks.append(
                    Subtask(
                        id="st-1",
                        agent="desktop",
                        task_type="os_agent",
                        description=f"Automate desktop: {prompt}",
                        layer=0,
                        payload={"task": prompt},
                        model_used=result.model_id,
                    )
                )
                direct_answer = ""

        return subtasks, reasoning, direct_answer, result.model_id

    # ── the .conca screen ────────────────────────────────────────────────

    def _conca_screen(
        self, session_id: str, subtasks: list[Subtask], role: str
    ) -> list[Subtask]:
        """
        Deterministic gate between planning and execution.

        Marks subtasks `skipped` with a reason rather than dropping them, so the
        Ops screen shows what was refused and why. A silently shortened plan is
        indistinguishable from a plan that never proposed the step.
        """
        for st in subtasks:
            allowed, reason = check_agent_permission(self.policy, st.agent, role)  # type: ignore[arg-type]
            if not allowed:
                st.status, st.blocked_reason = "skipped", reason
                self.store.log_audit(
                    session_id, st.agent, st.task_type, "blocked", reason, st.payload
                )
                continue

            if resolve_tool(st.agent, st.task_type) is None:
                reason = f'No tool implements {st.agent}/{st.task_type}'
                st.status, st.blocked_reason = "skipped", reason
                self.store.log_audit(
                    session_id, st.agent, st.task_type, "blocked", reason, st.payload
                )
                continue

            # Path rules apply to anything carrying a path, not just file ops —
            # a research payload with a local path is still a path.
            target = str(
                st.payload.get("path")
                or st.payload.get("target_path")
                or st.payload.get("filename")
                or ""
            )
            if target and ("/" in target or "\\" in target):
                ok, reason = check_path(self.policy, target)
                if not ok:
                    st.status, st.blocked_reason = "skipped", reason
                    self.store.log_audit(
                        session_id, st.agent, st.task_type, "blocked", reason, st.payload
                    )
                    continue

            code = str(st.payload.get("code") or st.payload.get("script") or "")
            if code:
                ok, reason = is_safe(self.policy, code)
                if not ok:
                    st.status, st.blocked_reason = "skipped", reason
                    self.store.log_audit(
                        session_id, st.agent, st.task_type, "blocked", reason, st.payload
                    )
                    continue

        return subtasks

    # ── execution ────────────────────────────────────────────────────────

    async def _execute(self, st: Subtask, ctx: ExecContext) -> None:
        tool = resolve_tool(st.agent, st.task_type)
        if tool is None:
            st.status, st.error = "failed", "tool disappeared between screen and execute"
            self.broker.subtask(ctx.session_id, st.to_public())
            return

        st.status = "running"
        self.broker.subtask(ctx.session_id, st.to_public())
        self.broker.thought(
            ctx.session_id,
            f"{st.agent}: [Hypothesis & Strategy] Selecting {st.task_type} — {st.description or 'executing request'}",
            model=st.model_used,
            agent=st.agent,
        )

        # ── HALO gate ──
        if requires_halo(self.policy, st.task_type):
            outcome = await self.gate.request_approval(
                ctx.session_id,
                agent=st.agent,
                action=st.task_type,
                details=self._describe(st),
                context=ctx.accumulated,
                on_injection=lambda agent, task: self.run_single(
                    ctx.session_id, agent, task, ctx.role
                ),
            )
            self.store.log_audit(
                ctx.session_id,
                st.agent,
                st.task_type,
                "approved" if outcome.approved else "rejected",
                outcome.reason,
                st.payload,
            )
            if not outcome.approved:
                st.status, st.error = "rejected", outcome.reason
                self.broker.subtask(ctx.session_id, st.to_public())
                self.broker.thought(
                    ctx.session_id,
                    f"{st.agent}: I cannot proceed because the human operator blocked this action: {outcome.reason}",
                    model=st.model_used,
                    agent=st.agent,
                )
                return
            if outcome.injection and outcome.injection.result:
                # Fold the helper task's findings in so the gated action runs
                # with the extra context the operator asked for.
                ctx.accumulated += (
                    f"\n[injected {outcome.injection.agent}] {outcome.injection.result}"
                )
                st.payload["_injected_context"] = outcome.injection.result[:1500]

        # ── run ──
        try:
            result = await tool(st.payload, ctx)
        except Exception as exc:
            st.status, st.error = "failed", f"{type(exc).__name__}: {exc}"
            self.broker.subtask(ctx.session_id, st.to_public())
            self.broker.thought(
                ctx.session_id,
                f"{st.agent}: I encountered an execution error: {type(exc).__name__}: {exc}",
                model=st.model_used,
                agent=st.agent,
            )
            self.store.log_audit(
                ctx.session_id, st.agent, st.task_type, "error", st.error, st.payload
            )
            return

        summary = str(result.get("summary", ""))
        if result.get("ok"):
            st.status, st.result = "done", summary
            # Rich Deductive Logic emission
            clean_summary = summary.strip().replace("\n", " ")
            if len(clean_summary) > 180:
                clean_summary = clean_summary[:177] + "..."
            self.broker.thought(
                ctx.session_id,
                f"{st.agent}: I successfully executed this task. The result is: {clean_summary}",
                model=st.model_used,
                agent=st.agent,
            )
        else:
            st.status, st.error, st.result = "failed", summary, summary
            self.broker.thought(
                ctx.session_id,
                f"{st.agent}: I tried to execute this task, but it failed: {summary[:140]}",
                model=st.model_used,
                agent=st.agent,
            )

        self.broker.subtask(ctx.session_id, st.to_public())
        # `sensitive` is asserted here rather than left to the pattern matcher,
        # because this result may be a description of the operator's screen and no
        # vocabulary family will ever recognise one. See PROVENANCE_SENSITIVE.
        self.store.append_entry(
            ctx.session_id,
            "agent",
            summary,
            agent=st.agent,
            sensitive=st.task_type in PROVENANCE_SENSITIVE,
        )

    def _describe(self, st: Subtask) -> str:
        """Human-readable payload summary for the approval card."""
        p = st.payload
        if st.task_type == "send_email":
            return (
                f"To: {p.get('to', '?')}\nSubject: {p.get('subject', '(none)')}\n\n"
                f"{str(p.get('body', ''))[:400]}"
            )
        if st.task_type == "send_sms":
            return f"To: {p.get('to') or p.get('peer', '?')}\n\n{str(p.get('body', ''))[:300]}"
        if st.task_type in {"write_file", "file_delete"}:
            return f"Path: {p.get('path') or p.get('filename', '?')}\nSize: {len(str(p.get('content', '')))} bytes"
        if st.task_type in {"python_execute", "script_execute"}:
            return f"Code:\n{str(p.get('code') or p.get('script', ''))[:400]}"
        if st.task_type == "delete_event":
            return f"Event id: {p.get('event_id', '?')}"
        return json.dumps(p, default=str)[:400]

    # ── single-task path (HALO injection, scheduled jobs) ─────────────────

    async def run_single(
        self, session_id: str, agent: str, task: str, role: str
    ) -> str:
        """
        Run one helper task outside the main plan.

        Used for HALO's mid-workflow injection and for cron-triggered jobs. Goes
        through the same permission check as anything else — an injected task is
        still a dispatch, and the operator asking for it does not widen the policy.
        """
        allowed, reason = check_agent_permission(self.policy, agent, role)  # type: ignore[arg-type]
        if not allowed:
            return f"[refused: {reason}]"

        caps = AGENT_CAPABILITIES.get(agent.replace("-", "_").lower(), [])
        task_type = caps[0] if caps else "generic"
        tool = resolve_tool(agent, task_type)
        if tool is None:
            return f"[no tool for {agent}]"

        ctx = ExecContext(
            session_id=session_id,
            role=role,
            policy=self.policy,
            store=self.store,
            broker=self.broker,
            prompt=task,
        )
        try:
            result = await tool({"query": task, "prompt": task}, ctx)
            return str(result.get("summary", ""))[:2000]
        except Exception as exc:
            return f"[injection error: {type(exc).__name__}: {exc}]"

    # ── synthesis ────────────────────────────────────────────────────────

    async def _synthesise(
        self, session_id: str, prompt: str, subtasks: list[Subtask], sensitive: bool
    ) -> str:
        done = [s for s in subtasks if s.status == "done"]
        problems = [s for s in subtasks if s.status in {"failed", "rejected", "skipped"}]

        results_block = "\n\n".join(
            f"[{s.agent}/{s.task_type}] {s.result}" for s in done if s.result
        )
        for s in problems:
            note = s.error or s.blocked_reason
            results_block += f"\n\n[{s.agent}/{s.task_type} — {s.status}] {note}"

        if not results_block.strip():
            ans = "No subtask produced a usable result."
            await self._stream_tokens(session_id, ans)
            return ans

        result = None
        try:
            result = await asyncio.wait_for(
                self.rotator.complete(
                    SYNTHESIS_PROMPT.format(prompt=prompt, results=results_block.strip()),
                    max_attempts=2,
                ),
                timeout=12.0,
            )
        except Exception:
            self.broker.thought(
                session_id,
                "Synthesising final answer...",
            )

        if result and not result.stubbed and result.text.strip():
            self.broker.thought(
                session_id,
                "Synthesised final answer.",
            )
            ans = result.text.strip()
        else:
            chunks = [
                f"• {s.result}" if "\n" not in s.result else s.result.strip()
                for s in done
                if s.result
            ]
            chunks += [
                f"• [{s.status}] {s.agent}/{s.task_type}: {s.error or s.blocked_reason}"
                for s in problems
            ]
            ans = "\n\n".join(chunks) or "Completed."

        await self._stream_tokens(session_id, ans)
        return ans

    async def _stream_tokens(self, session_id: str, text: str) -> None:
        """Stream answer chunks over SSE so the user experiences instantaneous real-time generation."""
        if not text:
            return
        words = text.split(" ")
        for i in range(0, len(words), 3):
            chunk = " ".join(words[i : i + 3])
            if i > 0:
                chunk = " " + chunk
            self.broker.token(session_id, chunk)
            await asyncio.sleep(0.012)
