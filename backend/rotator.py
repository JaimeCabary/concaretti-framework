"""
ModelRotator — never-fail LLM routing.

A port of the V11 rotator: an ordered ladder of ~54 model/key pairs walked from
the top, where any 429 or hard error permanently retires that entry for the rest
of the process and execution continues down the list. Free tiers first, paid
last, and a deterministic local generator at the bottom so the ladder can never
be fully exhausted.

Four deliberate changes from the original, each a bug fix rather than a
redesign:

1. **Duplicates removed.** The original array listed `gemini-3.5-flash` three
   times (tiers 0, 5, 9) and `gemini-3.1-pro-preview` twice (tiers 2, 6). Since
   exhaustion is keyed on model id, retiring the first copy retired all of them
   — those lower tiers could never actually serve a request. Entries are now
   deduped on `(api_model, env_key)`, which is the pair that determines whether
   a fallback is genuinely independent.

2. **Synthetic ids separated from API names.** `gemini-3.5-flash__key2` is a
   rotator-local identity meaning "same model, second key". Sending that string
   to Google 404s. `id` is now the ladder identity and `api_model` is what goes
   on the wire.

3. **Stub tier added.** The original declared an `ollama` provider and
   health-checked it, but never added a single Ollama entry to the array, so the
   documented local fallback did not exist. A deterministic generator replaces
   it — no daemon to install, and it works with the network unplugged.

4. **Seven idle keys wired up.** `.env` carried OpenRouter, NVIDIA, GLM, Kimi,
   Perplexity, HuggingFace and Anthropic credentials that nothing read, because
   `_OPENAI_COMPAT_BASE` listed four providers. All seven speak the OpenAI
   chat-completions shape — Anthropic through its compatibility endpoint — so
   they cost base URLs and ladder rows rather than adapters. They sit in a
   clearly-marked tier below everything that has been observed working; the
   comment there explains why placement is the whole safety argument.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

Provider = Literal[
    # Verified against a real key.
    "gemini",
    "groq",
    "together",
    "mistral",
    "deepseek",
    "cohere",
    # Keys present in .env but never wired until now — see the unverified tier.
    "openrouter",
    "nvidia",
    "glm",
    "kimi",
    "perplexity",
    "huggingface",
    "anthropic",
    "stub",
]

STUB_MODEL_ID = "deterministic-stub"


@dataclass(frozen=True)
class ModelInfo:
    id: str
    provider: Provider
    context_window: int
    tier: Literal["free", "paid"]
    env_key: str | None
    supports_thinking: bool = False
    api_model: str = ""
    # Several OpenAI-compatible providers reject `response_format`. Without this
    # flag every JSON call to one of them 400s and burns a ladder attempt.
    supports_json_mode: bool = True

    def __post_init__(self) -> None:
        if not self.api_model:
            # Strip the synthetic __keyN suffix to get the real wire name.
            object.__setattr__(self, "api_model", re.sub(r"__key\d+$", "", self.id))


# ═══════════════════════════════════════════════════════════════════════════
# The ladder
# ═══════════════════════════════════════════════════════════════════════════

_LADDER: list[ModelInfo] = [
    # ── Gemini 3.5 Flash — newest flash, thinking, 1M ctx, three key slots ──
    ModelInfo("gemini-3.5-flash", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    ModelInfo("gemini-3.5-flash__key2", "gemini", 1_048_576, "free", "GEMINI_API_KEY_2", True),
    ModelInfo("gemini-3.5-flash__key3", "gemini", 1_048_576, "free", "GEMINI_API_KEY_3", True),
    # ── Gemini 3.1 Flash Lite — very high RPM ──
    ModelInfo("gemini-3.1-flash-lite", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    ModelInfo("gemini-3.1-flash-lite-preview", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    # ── Gemini 3.1 Pro — tool-optimised variant first ──
    ModelInfo("gemini-3.1-pro-preview-customtools", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    ModelInfo("gemini-3.1-pro-preview", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    # ── Gemini 3 previews ──
    ModelInfo("gemini-3-flash-preview", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    ModelInfo("gemini-3-pro-preview", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    # ── Auto-tracking aliases ──
    ModelInfo("gemini-flash-latest", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    ModelInfo("gemini-flash-lite-latest", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    ModelInfo("gemini-pro-latest", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    # ── Flash-Lite + Omni ──
    ModelInfo("gemini-3.5-flash-lite", "gemini", 1_048_576, "free", "GEMINI_API_KEY", True),
    ModelInfo("gemini-omni-flash-preview", "gemini", 131_072, "free", "GEMINI_API_KEY", True),
    # ── Gemma 4 — independent Google quota pool ──
    ModelInfo("gemma-4-31b-it", "gemini", 262_144, "free", "GEMINI_API_KEY", True),
    ModelInfo("gemma-4-26b-a4b-it", "gemini", 262_144, "free", "GEMINI_API_KEY", True),
    # ── Pinned stable revisions ──
    ModelInfo("gemini-3.5-flash-001", "gemini", 1_048_576, "free", "GEMINI_API_KEY"),
    ModelInfo("gemini-3.1-flash-lite-001", "gemini", 1_048_576, "free", "GEMINI_API_KEY"),
    # ── Groq × 5 — each model has its own quota pool, so true diversity ──
    ModelInfo("llama-3.3-70b-versatile", "groq", 128_000, "free", "GROQ_API_KEY"),
    ModelInfo("llama-3.1-70b-versatile", "groq", 128_000, "free", "GROQ_API_KEY"),
    ModelInfo("llama-3.1-8b-instant", "groq", 128_000, "free", "GROQ_API_KEY"),
    ModelInfo("gemma2-9b-it", "groq", 8_192, "free", "GROQ_API_KEY"),
    ModelInfo("mixtral-8x7b-32768", "groq", 32_768, "free", "GROQ_API_KEY"),
    # ── Together AI ──
    ModelInfo("Qwen/Qwen3-235B-A22B", "together", 40_960, "free", "TOGETHER_API_KEY"),
    ModelInfo("moonshotai/Kimi-K2-Instruct", "together", 131_072, "free", "TOGETHER_API_KEY"),
    # ── Mistral ──
    ModelInfo("mistral-small-latest", "mistral", 32_768, "free", "MISTRAL_API_KEY"),
    ModelInfo("mistral-medium-latest", "mistral", 32_768, "paid", "MISTRAL_API_KEY"),
    # ── Paid last resorts ──
    ModelInfo("deepseek-chat", "deepseek", 64_000, "paid", "DEEPSEEK_API_KEY"),
    ModelInfo("deepseek-reasoner", "deepseek", 64_000, "paid", "DEEPSEEK_API_KEY", True),
    ModelInfo("command-r-08-2024", "cohere", 128_000, "free", "COHERE_API_KEY"),
    ModelInfo("command-r-plus-08-2024", "cohere", 128_000, "paid", "COHERE_API_KEY"),
    # ═══════════════════════════════════════════════════════════════════════
    # Unverified tier — seven keys that were sitting in .env unread
    # ═══════════════════════════════════════════════════════════════════════
    #
    # Every entry above this line has been reached with a real key. Every entry
    # below it is a base URL and a model name written from documentation, not
    # from a successful call, so the ids may be wrong.
    #
    # That is why the tier sits *here* rather than higher up. A wrong id costs
    # one attempt and a rotate — `_raise_for_quota` turns the 404 into a plain
    # RuntimeError, `complete()` catches it and moves on — so the only price of a
    # bad guess is paid by requests that had already exhausted everything known
    # to work. Promote an entry once you have watched it answer.
    #
    # All seven speak the OpenAI chat-completions shape, Anthropic included via
    # its compatibility endpoint, so none of them needed a new adapter.
    #
    # ── OpenRouter — one key, 100+ models. `auto` picks for us, which also ──
    # ── makes it the one entry here that cannot break when a name changes.  ──
    ModelInfo("openrouter/auto", "openrouter", 128_000, "paid", "OPENROUTER_API_KEY"),
    ModelInfo("deepseek/deepseek-chat", "openrouter", 64_000, "paid", "OPENROUTER_API_KEY"),
    ModelInfo("meta-llama/llama-3.3-70b-instruct", "openrouter", 128_000, "paid", "OPENROUTER_API_KEY"),
    # ── NVIDIA NIM — free credits on signup ──
    ModelInfo("meta/llama-3.3-70b-instruct", "nvidia", 128_000, "free", "NVIDIA_API_KEY"),
    ModelInfo("nvidia/llama-3.1-nemotron-70b-instruct", "nvidia", 128_000, "free", "NVIDIA_API_KEY"),
    # ── Zhipu GLM — glm-4-flash is the free one ──
    ModelInfo("glm-4-flash", "glm", 128_000, "free", "GLM_API_KEY"),
    ModelInfo("glm-4-plus", "glm", 128_000, "paid", "GLM_API_KEY"),
    # ── Moonshot Kimi ──
    ModelInfo("moonshot-v1-32k", "kimi", 32_768, "paid", "KIMI_API_KEY"),
    ModelInfo("moonshot-v1-8k", "kimi", 8_192, "paid", "KIMI_API_KEY"),
    # ── Perplexity — answers carry live web results, which no other entry ──
    # ── here does. Rejects `response_format`; it has its own JSON scheme.  ──
    ModelInfo("sonar", "perplexity", 127_000, "paid", "PERPLEXITY_API_KEY", supports_json_mode=False),
    ModelInfo("sonar-pro", "perplexity", 200_000, "paid", "PERPLEXITY_API_KEY", supports_json_mode=False),
    # ── HuggingFace router ──
    ModelInfo("meta-llama/Llama-3.3-70B-Instruct", "huggingface", 128_000, "free", "HUGGINGFACE_API_KEY"),
    ModelInfo("Qwen/Qwen2.5-72B-Instruct", "huggingface", 32_768, "free", "HUGGINGFACE_API_KEY"),
    # ── Anthropic, last: the only tier here that bills per token with no free ──
    # ── allowance, so it should be reached only when all else has retired.   ──
    ModelInfo("claude-haiku-4-5-20251001", "anthropic", 200_000, "paid", "ANTHROPIC_API_KEY"),
    ModelInfo("claude-sonnet-5", "anthropic", 200_000, "paid", "ANTHROPIC_API_KEY", True),
    # ── Terminal tier: always available, no key, no network ──
    ModelInfo(STUB_MODEL_ID, "stub", 8_192, "free", None),
]


def _dedupe(ladder: list[ModelInfo]) -> list[ModelInfo]:
    """
    Keep the first occurrence of each `(api_model, env_key)` pair.

    Two entries sharing both fields are the same quota behind the same
    credential; the second can never serve a request the first could not.
    """
    seen: set[tuple[str, str | None]] = set()
    out: list[ModelInfo] = []
    for m in ladder:
        key = (m.api_model, m.env_key)
        if key in seen:
            continue
        seen.add(key)
        out.append(m)
    return out


# ═══════════════════════════════════════════════════════════════════════════
# Deterministic stub
# ═══════════════════════════════════════════════════════════════════════════

# Keyword routes for the offline stub, one per agent that owns a tool.
#
# This list is checked against `TOOL_REGISTRY` by a test, because it drifted
# once already: it held seven agents while fifteen had tools, so with no network
# a prompt aimed at `desktop`, `shopper` or `chain` fell through to the `research`
# default and ran a web search instead. That is worse than refusing — the gated
# actions live in exactly the agents that were unreachable, so `screen_capture`,
# `shop_checkout`, `chain_prepare_tx`, `social_post` and `browser_act` could not
# be demonstrated at all without a provider, and the system looked ungated
# offline when in fact it was unroutable.
#
# Ordering matters: `_route` returns every match, so the more specific agents are
# listed first and generic words are kept out of them. "buy" belongs to shopper,
# not to file, and "screen" must not be a research word.
_AGENT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "desktop": ("screen", "screenshot", "my display", "what am i looking at"),
    # "price of" is deliberately absent: it matched "stock price of NVDA" and
    # sent a quote request to the shopper, which the routing test caught.
    "shopper": ("buy", "shop", "purchase", "order", "cart", "checkout", "keyboard"),
    "market": ("stock", "ticker", "share price", "portfolio", "nasdaq", "earnings"),
    "chain": ("wallet", "solana", "crypto", "token", "on-chain", "blockchain"),
    "browser": ("browse", "website", "click", "navigate", "web page", "log in to"),
    "social": ("post", "tweet", "linkedin", "publish"),
    "github": ("github", "repo", "pull request", "commit"),
    "news": ("headlines", "what happened today", "briefing"),
    "research": ("research", "find", "search", "paper", "arxiv", "cite", "study"),
    "email": ("email", "inbox", "gmail", "reply", "draft", "send"),
    "calendar": ("calendar", "meeting", "schedule", "event", "exam", "deadline", "revision"),
    "sms": ("sms", "text", "message", "call", "phone"),
    "file": ("file", "write", "save", "document", "report", "docx", "pptx", "xlsx"),
    "scheduler": ("remind", "cron", "recurring", "every day", "weekly"),
    "therapy": ("feel", "stressed", "anxious", "overwhelmed", "hopeless", "struggling"),
}


class DeterministicStub:
    """
    Local, offline plan generator.

    Not a model — a keyword router that emits the same JSON envelope the real
    providers are asked for, so every screen renders and the SSE pipeline can be
    demonstrated end to end with no key and no network. Output is labelled as
    stub-sourced everywhere it surfaces, so it can never be mistaken for real
    model reasoning in a demo.
    """

    def _route(self, prompt: str) -> list[str]:
        low = prompt.lower()
        hits = [
            agent
            for agent, words in _AGENT_KEYWORDS.items()
            if any(w in low for w in words)
        ]
        return hits or ["research"]

    def _task_for(self, agent: str, low: str) -> tuple[str, str]:
        """Which of the agent's tools to propose, and how to describe it."""
        for words, task, description in _TASK_KEYWORDS.get(agent, ()):
            if any(w in low for w in words):
                return task, description
        return (
            _DEFAULT_TASK_TYPE.get(agent, "generic"),
            _STUB_DESCRIPTION.get(agent, f"Handle the {agent} portion of the request"),
        )

    def plan(self, prompt: str) -> dict[str, Any]:
        agents = self._route(prompt)
        low = prompt.lower()
        subtasks = []
        for i, agent in enumerate(agents[:4]):
            task, description = self._task_for(agent, low)
            subtasks.append(
                {
                    "id": f"st-{i + 1}",
                    "agent": agent,
                    "task_type": task,
                    "description": description,
                    "layer": 0 if i == 0 else 1,
                    "payload": {"prompt": prompt},
                }
            )
        return {
            "reasoning": (
                f"Routed on keyword match to {', '.join(agents)}. "
                "Planned locally — no model provider is configured."
            ),
            "subtasks": subtasks,
        }

    def thoughts(self, prompt: str) -> list[str]:
        agents = self._route(prompt)
        return [
            "Planning locally — no model provider is configured.",
            f"Prompt matched agent keywords: {', '.join(agents)}.",
            f"Emitting {len(agents[:4])} subtask(s) in dependency layers.",
            "Handing plan to the .conca check before any dispatch.",
        ]

    def approval_options(self, action: str, details: str) -> list[str]:
        base = _STUB_APPROVALS.get(action)
        if base:
            return base
        return [f"Allow this {action.replace('_', ' ')}", "Skip this step", "Cancel the task"]

    def complete(self, prompt: str) -> str:
        return json.dumps(self.plan(prompt))


# The first step the stub proposes for each agent, and every one of these is a
# real key in `TOOL_REGISTRY` — a name no tool emits falls through `resolve_tool`
# to None and reports "unsupported", which reads as a broken agent rather than an
# absent provider.
#
# Read-only wherever the agent has a read-only tool. `shopper` gets `shop_search`
# rather than `shop_checkout` because searching is genuinely the first step of
# buying, not because checkout is dangerous; `desktop` and `social` own only one
# tool each and both happen to be gated, which is how the HALO gate stays
# demonstrable with no network at all.
_DEFAULT_TASK_TYPE = {
    "desktop": "screen_capture",
    "shopper": "shop_search",
    "market": "quote",
    "chain": "wallet_balances",
    "browser": "browse_page",
    "social": "social_post",
    "github": "github_summary",
    "news": "news_digest",
    "research": "web_search",
    "email": "draft_reply",
    "calendar": "create_event",
    "sms": "draft_reply_sms",
    "file": "write_file",
    "scheduler": "set_reminder",
    "therapy": "reflect",
}

_STUB_DESCRIPTION = {
    "desktop": "Read the screen and describe what is on it",
    "shopper": "Search merchants for candidates within the stated budget",
    "market": "Fetch a live quote for the named symbol",
    "chain": "Read public balances for the given address",
    "browser": "Open the page and report what it contains",
    "social": "Draft the post for approval before anything is published",
    "github": "Summarise recent repository activity",
    "news": "Assemble a digest of current headlines",
    "research": "Search for relevant sources and summarise the findings",
    "email": "Draft a contextual reply for review",
    "calendar": "Create the requested calendar entry",
    "sms": "Draft an SMS reply for approval",
    "file": "Compile the requested document",
    "scheduler": "Register the recurring trigger",
    "therapy": "Respond supportively; this turn stays out of long-term memory",
}


# The second level of stub routing: which of an agent's tools to propose when the
# prompt names one. First match wins, and a miss falls back to the default above.
#
# This exists because of what end-to-end verification found. The defaults reach
# every agent, which looked like enough — but they reach exactly one tool each,
# and only three of the twelve HALO triggers happen to be a default. The other
# nine were unreachable with no provider configured, so asking the offline system
# to check out a cart ran `shop_search` and asking it to build a transaction ran
# `wallet_balances`. Nothing refused, because nothing gated was ever dispatched.
#
# That is the same failure as the `file_write`/`write_file` drift one layer up: a
# gate that cannot be reached is indistinguishable from a gate that is not there,
# and both read as "no refusal" in a transcript. `test_invariants` now asserts
# every trigger is reachable from here, which is the check that was missing.
#
# Keywords are only consulted for an agent the first level already selected, so
# common words are safe: "run" only steers `file`, "buy" only steers `market`.
_TASK_KEYWORDS: dict[str, tuple[tuple[tuple[str, ...], str, str], ...]] = {
    "shopper": (
        (
            ("check out", "checkout", "place the order", "buy it now", "pay for it"),
            "shop_checkout",
            "Fill the cart and stop at the approval gate before anything is paid",
        ),
        (
            ("track", "where is my order", "delivery status", "has it shipped"),
            "order_track",
            "Check the status of an open order",
        ),
        (
            ("compare", "which is better", "best value"),
            "shop_compare",
            "Score the candidates against the stated budget",
        ),
    ),
    "chain": (
        (
            ("prepare", "unsigned", "transfer", "build a tx", "send some"),
            "chain_prepare_tx",
            "Build an unsigned transaction for you to sign in your own wallet",
        ),
        (
            ("history", "past transactions", "recent activity"),
            "chain_history",
            "Read recent public activity for the address",
        ),
    ),
    "email": (
        (
            ("send", "reply to", "email them", "email her", "email him"),
            "send_email",
            "Send the email, which stops at the approval gate first",
        ),
        (("inbox", "unread", "list my"), "list_emails", "List recent mail"),
    ),
    "sms": (
        (
            ("call", "phone them", "ring them", "dial"),
            "make_call",
            "Place the call, which stops at the approval gate first",
        ),
        (
            ("send", "text them", "text her", "text him"),
            "send_sms",
            "Send the SMS, which stops at the approval gate first",
        ),
        (("list", "what did they say"), "list_messages", "List recent messages"),
    ),
    "calendar": (
        (
            ("cancel", "delete", "clear my", "call it off"),
            "delete_event",
            "Delete the event, which stops at the approval gate first",
        ),
        (
            ("free", "available", "availability"),
            "check_availability",
            "Check whether the slot is free",
        ),
        (
            ("what is on", "whats on", "what's on", "agenda", "tomorrow"),
            "fetch_today_tomorrow",
            "Read the next two days",
        ),
        (("find a time", "when can"), "find_meeting_time", "Find a workable slot"),
    ),
    "browser": (
        (
            ("click", "fill in", "log in", "sign in", "submit"),
            "browser_act",
            "Act on the page, which stops at the approval gate first",
        ),
        (
            ("screenshot", "what does it look like"),
            "screenshot_page",
            "Photograph the page",
        ),
    ),
    "file": (
        (
            ("execute", "run this", "run the script", "python"),
            "python_execute",
            "Run the snippet, which stops at the approval gate first",
        ),
        (
            ("scaffold", "new project", "set up a project"),
            "project_create",
            "Create the project, which stops at the approval gate first",
        ),
        (("read", "open the", "what is in"), "read_file", "Read the file"),
        (("list", "directory", "folder"), "list_dir", "List the directory"),
    ),
    "market": (
        (
            ("paper trade", "buy", "sell"),
            "paper_trade",
            "Record a simulated fill — nothing is executed anywhere",
        ),
        (
            ("portfolio", "positions", "p&l", "pnl", "how am i doing"),
            "portfolio",
            "Value the paper portfolio against live quotes",
        ),
        (
            ("fundamentals", "pe ratio", "market cap", "revenue"),
            "fundamentals",
            "Read the published fundamentals",
        ),
    ),
    "research": (
        (("arxiv", "preprint", "citation"), "arxiv_search", "Search arXiv"),
        (
            ("scrape", "read this page", "this url", "http"),
            "scrape_url",
            "Fetch the page and extract its text",
        ),
    ),
    "scheduler": (
        (
            ("what is scheduled", "list reminders", "my reminders", "cancel the reminder"),
            "list_scheduled",
            "List the registered triggers",
        ),
    ),
}

_STUB_APPROVALS = {
    "send_email": ["Send it now", "Save as draft instead", "Cancel"],
    "send_sms": ["Send the text", "Save the draft", "Cancel"],
    "file_write": ["Write the file", "Show me the content first", "Cancel"],
    "file_delete": ["Delete it", "Move to an archive folder instead", "Cancel"],
    "delete_event": ["Delete the event", "Cancel the event instead of deleting", "Keep it"],
    "python_execute": ["Run the code", "Show me the code first", "Cancel"],
    "script_execute": ["Run the script", "Dry-run it first", "Cancel"],
}


# ═══════════════════════════════════════════════════════════════════════════
# Rotator
# ═══════════════════════════════════════════════════════════════════════════


class RotationExhausted(RuntimeError):
    """Raised only if even the stub tier fails, which should be impossible."""


@dataclass
class CallResult:
    text: str
    model_id: str
    provider: str
    tier: str
    attempts: int
    stubbed: bool = False


class ModelRotator:
    def __init__(self, ladder: list[ModelInfo] | None = None) -> None:
        self.models = _dedupe(ladder if ladder is not None else _LADDER)
        self.exhausted: set[str] = set()
        self.stub = DeterministicStub()
        self._index = 0
        self._jump_to_first_active()

    # ── availability ─────────────────────────────────────────────────────

    def _key_configured(self, model: ModelInfo) -> bool:
        if model.env_key is None:
            return True  # stub tier
        val = os.environ.get(model.env_key, "").strip()
        return bool(val) and not val.startswith("YOUR_")

    def _usable(self, model: ModelInfo) -> bool:
        return model.id not in self.exhausted and self._key_configured(model)

    def active_models(self) -> list[ModelInfo]:
        return [m for m in self.models if self._usable(m)]

    def free_models(self) -> list[ModelInfo]:
        return [m for m in self.active_models() if m.tier != "paid"]

    def _jump_to_first_active(self) -> None:
        for i, m in enumerate(self.models):
            if self._usable(m):
                self._index = i
                return
        self._index = len(self.models) - 1  # stub

    # ── selection ────────────────────────────────────────────────────────

    def current(self) -> ModelInfo:
        m = self.models[self._index]
        if self._usable(m):
            return m
        return self.rotate()

    def rotate(self, *, free_only: bool = False) -> ModelInfo:
        """Advance to the next usable entry, wrapping once."""
        start = self._index
        for _ in range(len(self.models)):
            self._index = (self._index + 1) % len(self.models)
            m = self.models[self._index]
            if free_only and m.tier == "paid":
                continue
            if self._usable(m):
                return m
            if self._index == start:
                break
        # Everything retired — fall back to the stub, which never retires.
        self._index = len(self.models) - 1
        return self.models[self._index]

    def mark_exhausted(self, model_id: str) -> None:
        """Retire an entry for the life of the process."""
        if model_id != STUB_MODEL_ID:
            self.exhausted.add(model_id)

    def status(self) -> dict[str, Any]:
        cur = self.models[self._index]
        active = self.active_models()
        return {
            "current": cur.id,
            "current_provider": cur.provider,
            "ladder_size": len(self.models),
            "active_count": len(active),
            "providers_available": sorted({m.provider for m in active}),
            "exhausted": sorted(self.exhausted),
            "live_provider_configured": any(m.provider != "stub" for m in active),
        }

    # ── invocation ───────────────────────────────────────────────────────

    async def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        json_mode: bool = False,
        max_attempts: int = 6,
        temperature: float = 0.4,
    ) -> CallResult:
        """
        Run `prompt` against the ladder, walking down on failure.

        A 429 or quota error retires the entry permanently; a transient network
        error only advances past it. Either way the caller gets a result, because
        the stub tier terminates the walk.
        """
        attempts = 0
        last_error = ""

        while attempts < max_attempts:
            model = self.current()
            attempts += 1

            if model.provider == "stub":
                return CallResult(
                    text=self.stub.complete(prompt),
                    model_id=model.id,
                    provider="stub",
                    tier="free",
                    attempts=attempts,
                    stubbed=True,
                )

            try:
                text = await self._dispatch(
                    model, prompt, system=system, json_mode=json_mode, temperature=temperature
                )
                if text.strip():
                    return CallResult(
                        text=text,
                        model_id=model.id,
                        provider=model.provider,
                        tier=model.tier or "free",
                        attempts=attempts,
                    )
                last_error = "empty response"
                self.rotate()
            except _QuotaError as exc:
                last_error = str(exc)
                self.mark_exhausted(model.id)
                self.rotate()
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                self.rotate()

        # Out of attempts — answer from the stub rather than raising into the UI.
        return CallResult(
            text=self.stub.complete(prompt),
            model_id=STUB_MODEL_ID,
            provider="stub",
            tier="free",
            attempts=attempts,
            stubbed=True,
        )

    async def complete_vision(
        self,
        prompt: str,
        image_b64: str,
        *,
        system: str | None = None,
        mime_type: str = "image/png",
        max_attempts: int = 3,
        temperature: float = 0.2,
    ) -> CallResult:
        """
        Ask a question about an image.

        Only the Gemini entries are eligible, because `_call_gemini` is the one
        adapter with an image code path — so the discriminator is the provider,
        not a per-model capability flag that would have to be maintained across
        eighteen ladder rows.

        Two differences from `complete()`, both deliberate:

        **No stub fallback.** The stub composes text from keywords; asked what is
        on screen it would invent an answer, and a confident fabrication about the
        user's display is worse than an admission. So exhaustion returns
        `stubbed=True` with a sentence saying the screen was not read, and callers
        surface that rather than presenting it as an observation.

        **The shared cursor is left alone.** This walks a local list instead of
        `current()`/`rotate()`, so a vision call cannot reposition the ladder the
        text path is using. The `exhausted` set *is* shared, though — a 429 is a
        fact about the credential, not about the modality, and retiring it here
        correctly retires it for text.
        """
        candidates = [m for m in self.models if m.provider == "gemini" and self._usable(m)]
        attempts = 0
        last_error = "no vision-capable model configured"

        async with httpx.AsyncClient(timeout=60.0) as client:
            for model in candidates:
                if attempts >= max_attempts:
                    break
                attempts += 1
                key = os.environ.get(model.env_key or "", "").strip()
                try:
                    text = await self._call_gemini_vision(
                        client, model, key, prompt, system, image_b64, mime_type, temperature
                    )
                except _QuotaError as exc:
                    last_error = str(exc)
                    self.mark_exhausted(model.id)
                    continue
                except Exception as exc:
                    last_error = f"{type(exc).__name__}: {exc}"
                    continue

                if text.strip():
                    return CallResult(
                        text=text,
                        model_id=model.id,
                        provider=model.provider,
                        tier=model.tier or "free",
                        attempts=attempts,
                    )
                last_error = "empty response"

        return CallResult(
            text=(
                "The screen was not read — no vision-capable model was reachable "
                f"({last_error}). Nothing here describes what was captured."
            ),
            model_id=STUB_MODEL_ID,
            provider="stub",
            tier="free",
            attempts=attempts,
            stubbed=True,
        )

    async def _dispatch(
        self,
        model: ModelInfo,
        prompt: str,
        *,
        system: str | None,
        json_mode: bool,
        temperature: float,
    ) -> str:
        key = os.environ.get(model.env_key or "", "").strip()

        async with httpx.AsyncClient(timeout=45.0) as client:
            if model.provider == "gemini":
                return await self._call_gemini(
                    client, model, key, prompt, system, json_mode, temperature
                )
            if model.provider == "cohere":
                return await self._call_cohere(client, model, key, prompt, system, temperature)
            return await self._call_openai_compatible(
                client, model, key, prompt, system, json_mode, temperature
            )

    # ── provider adapters ────────────────────────────────────────────────

    @staticmethod
    def _raise_for_quota(status: int, body: str) -> None:
        if status == 429 or "quota" in body.lower() or "rate limit" in body.lower():
            raise _QuotaError(f"HTTP {status}: {body[:200]}")
        if status >= 400:
            raise RuntimeError(f"HTTP {status}: {body[:200]}")

    async def _call_gemini(
        self,
        client: httpx.AsyncClient,
        model: ModelInfo,
        key: str,
        prompt: str,
        system: str | None,
        json_mode: bool,
        temperature: float,
    ) -> str:
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model.api_model}:generateContent"
        )
        body: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": temperature},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"

        resp = await client.post(url, params={"key": key}, json=body)
        self._raise_for_quota(resp.status_code, resp.text)

        data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            return ""
        parts = candidates[0].get("content", {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts)

    async def _call_gemini_vision(
        self,
        client: httpx.AsyncClient,
        model: ModelInfo,
        key: str,
        prompt: str,
        system: str | None,
        image_b64: str,
        mime_type: str,
        temperature: float,
    ) -> str:
        """
        One `generateContent` call carrying an inline image alongside the prompt.

        The base64 is stripped of a `data:` prefix if one is present. Both the
        browser (`canvas.toDataURL`) and the Tauri capture path can hand over a
        full data URL, and Google wants only the payload — sending the prefix
        fails with a decode error that reads like a quota problem in the logs.
        """
        payload = image_b64.strip()
        if payload.startswith("data:"):
            _, _, payload = payload.partition(",")

        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model.api_model}:generateContent"
        )
        body: dict[str, Any] = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": mime_type, "data": payload}},
                    ],
                }
            ],
            "generationConfig": {"temperature": temperature},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}

        resp = await client.post(url, params={"key": key}, json=body)
        self._raise_for_quota(resp.status_code, resp.text)

        data = resp.json()
        cands = data.get("candidates") or []
        if not cands:
            return ""
        parts = cands[0].get("content", {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts)

    async def _call_openai_compatible(
        self,
        client: httpx.AsyncClient,
        model: ModelInfo,
        key: str,
        prompt: str,
        system: str | None,
        json_mode: bool,
        temperature: float,
    ) -> str:
        base = _OPENAI_COMPAT_BASE[model.provider]
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        body: dict[str, Any] = {
            "model": model.api_model,
            "messages": messages,
            "temperature": temperature,
        }
        if json_mode and model.supports_json_mode:
            body["response_format"] = {"type": "json_object"}

        resp = await client.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json=body,
        )
        self._raise_for_quota(resp.status_code, resp.text)

        choices = resp.json().get("choices") or []
        if not choices:
            return ""
        return choices[0].get("message", {}).get("content", "") or ""

    async def _call_cohere(
        self,
        client: httpx.AsyncClient,
        model: ModelInfo,
        key: str,
        prompt: str,
        system: str | None,
        temperature: float,
    ) -> str:
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        resp = await client.post(
            "https://api.cohere.com/v2/chat",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": model.api_model, "messages": messages, "temperature": temperature},
        )
        self._raise_for_quota(resp.status_code, resp.text)

        content = resp.json().get("message", {}).get("content") or []
        return "".join(c.get("text", "") for c in content)


class _QuotaError(RuntimeError):
    """Signals a 429/quota condition, which retires the entry permanently."""


_OPENAI_COMPAT_BASE: dict[str, str] = {
    "groq": "https://api.groq.com/openai/v1",
    "together": "https://api.together.xyz/v1",
    "mistral": "https://api.mistral.ai/v1",
    "deepseek": "https://api.deepseek.com/v1",
    # ── the unverified tier ──
    "openrouter": "https://openrouter.ai/api/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    # Zhipu and Moonshot each run a mainland-China host and an international one.
    # The international endpoints are used here because this deployment is not in
    # China; if a request times out rather than 4xx-ing, swap `api.z.ai` for
    # `open.bigmodel.cn` and `api.moonshot.ai` for `api.moonshot.cn`.
    "glm": "https://api.z.ai/api/paas/v4",
    "kimi": "https://api.moonshot.ai/v1",
    "perplexity": "https://api.perplexity.ai",
    "huggingface": "https://router.huggingface.co/v1",
    # Anthropic's OpenAI-compatibility layer, which accepts a Bearer token and
    # the standard chat-completions body. Using it is what keeps this a base-URL
    # entry instead of a fourth provider adapter.
    "anthropic": "https://api.anthropic.com/v1",
}


# ═══════════════════════════════════════════════════════════════════════════
# JSON coercion
# ═══════════════════════════════════════════════════════════════════════════

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def extract_json(text: str) -> dict[str, Any] | None:
    """
    Pull a JSON object out of a model response.

    Models wrap JSON in prose or code fences regardless of instructions, so
    parsing has to tolerate all three shapes before giving up.
    """
    if not text:
        return None

    candidates: list[str] = []
    fenced = _FENCE.search(text)
    if fenced:
        candidates.append(fenced.group(1))
    candidates.append(text)

    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])

    for cand in candidates:
        try:
            parsed = json.loads(cand.strip())
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            continue
    return None


_rotator: ModelRotator | None = None


def get_rotator() -> ModelRotator:
    global _rotator
    if _rotator is None:
        _rotator = ModelRotator()
    return _rotator
