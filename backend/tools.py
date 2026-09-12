"""
Agent tool implementations.

Every tool is an async callable with the same shape:

    async def tool(payload: dict, ctx: ExecContext) -> dict

returning `{"ok": bool, "summary": str, ...}`. Uniformity is what lets the
orchestrator dispatch, audit, and narrate tools without special-casing any of
them.

Two rules hold throughout:

**Enforcement lives at the tool boundary, not in the prompt.** Any tool that
touches the filesystem or a shell re-checks `.conca` immediately before acting,
even though the orchestrator already checked during planning. Planning-time
checks catch a bad plan; boundary checks catch a payload mutated after planning.
Both are cheap.

**Missing credentials degrade, they do not raise.** A tool with no API key
returns `ok: False` with an explanatory summary and, where sensible, writes to
local SQLite instead. A demo on a train should show a working Calendar screen
backed by local storage rather than a stack trace.
"""

from __future__ import annotations

import asyncio
import base64
import html
import json
import os
import re
import sys
import subprocess
import time
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any

import httpx
import subprocess
import mss
import pyautogui
import psutil

from memory import KEY_REFUSAL, MemoryStore, contains_secret_material
from rotator import get_rotator
from security import (
    ConcaPolicy,
    canonical_path,
    check_file_size,
    check_path,
    check_url,
    is_safe,
    normalize_command,
)
from sse import SseBroker


@dataclass
class ExecContext:
    session_id: str
    role: str
    policy: ConcaPolicy
    store: MemoryStore
    broker: SseBroker
    prompt: str = ""
    accumulated: str = ""

    def note(self, message: str) -> None:
        self.broker.activity(self.session_id, message)


def _ok(summary: str, **extra: Any) -> dict[str, Any]:
    return {"ok": True, "summary": summary, **extra}


def _fail(summary: str, **extra: Any) -> dict[str, Any]:
    return {"ok": False, "summary": summary, **extra}


def _env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    return "" if val.startswith("YOUR_") else val


# ═══════════════════════════════════════════════════════════════════════════
# Secret redaction
# ═══════════════════════════════════════════════════════════════════════════

# A run of 13–19 digits, tolerating the spaces and hyphens people type cards with.
_DIGIT_RUN = re.compile(r"\d(?:[ -]?\d){12,18}")


def _luhn_ok(digits: str) -> bool:
    """
    The check digit every payment card carries.

    Used as the discriminator rather than length alone because 16-digit runs are
    not rare — order numbers, IMEIs, account references — and masking all of them
    would gut the very step descriptions that make a browser run auditable. Luhn
    has a 1-in-10 false-positive rate on random digits, which is the right way
    round: it over-masks occasionally and under-masks almost never.
    """
    total, alt = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def redact_secrets(text: str) -> str:
    """
    Replace card numbers in `text` with `•••• 1234`.

    Applied to anything a tool *returns*, not just to what it logs. That
    distinction is the whole point: `log_audit` already stores only a SHA-256 of
    the payload, but a tool's return value travels much further — into the result
    summary, out over SSE to the browser, into `ctx.accumulated`, and from there
    into `context_entries` and the embedding index. A number scrubbed from the
    audit trail but left in the summary has not been protected at all.

    (And a hash would not protect a PAN regardless: sixteen digits is 10^16
    candidates, which is an afternoon of brute force, so the answer has to be not
    storing it rather than storing it obscured.)

    Last four digits survive because they are what lets a human confirm the agent
    used the card they meant, and are not sensitive on their own — every receipt
    prints them.
    """
    if not text:
        return text

    def _mask(match: re.Match[str]) -> str:
        raw = match.group(0)
        digits = re.sub(r"[^0-9]", "", raw)
        if not _luhn_ok(digits):
            return raw
        return f"•••• {digits[-4:]}"

    return _DIGIT_RUN.sub(_mask, text)


# ═══════════════════════════════════════════════════════════════════════════
# Research
# ═══════════════════════════════════════════════════════════════════════════


async def web_search(payload: dict, ctx: ExecContext) -> dict:
    """Search via Tavily. Falls back to a DuckDuckGo HTML scrape with no key."""
    query = str(payload.get("query") or payload.get("prompt") or "").strip()
    if not query:
        return _fail("no query supplied")

    key = _env("TAVILY_API_KEY")
    if key:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    "https://api.tavily.com/search",
                    json={
                        "api_key": key,
                        "query": query,
                        "max_results": 5,
                        "search_depth": "basic",
                        "include_answer": True,
                    },
                )
            if resp.status_code == 200:
                data = resp.json()
                results = [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "snippet": (r.get("content") or "")[:400],
                    }
                    for r in data.get("results", [])[:5]
                ]
                answer = data.get("answer") or ""
                lines = [f"• {r['title']} — {r['url']}" for r in results]
                return _ok(
                    (answer or f"{len(results)} results for '{query}'")
                    + ("\n" + "\n".join(lines) if lines else ""),
                    results=results,
                    provider="tavily",
                )
        except Exception as exc:
            ctx.note(f"Tavily failed ({type(exc).__name__}); trying fallback search")

    return await _duckduckgo_fallback(query)


async def _duckduckgo_fallback(query: str) -> dict:
    """Keyless best-effort search. Brittle by nature; used only as a backstop."""
    try:
        async with httpx.AsyncClient(
            timeout=15.0, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}
        ) as client:
            resp = await client.get(
                "https://html.duckduckgo.com/html/", params={"q": query}
            )
        hits = re.findall(
            r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
            resp.text,
            re.DOTALL,
        )[:5]
        results = [
            {"title": _clean_text(t), "url": _unwrap_ddg(u), "snippet": ""}
            for u, t in hits
        ]
        if not results:
            return _fail(f"no results found for '{query}'")
        return _ok(
            f"{len(results)} results for '{query}':\n"
            + "\n".join(f"• {r['title']} — {r['url']}" for r in results),
            results=results,
            provider="duckduckgo-fallback",
        )
    except Exception as exc:
        return _fail(f"search unavailable: {type(exc).__name__}: {exc}")


def _clean_text(fragment: str) -> str:
    """Strip tags, then decode entities — in that order, and only once.

    The scrape reads raw HTML, so a title arrives as `&#x27;I Need Help&#x27;`
    with `<b>` wrappers around the matched terms. Unescaping before stripping
    would let an escaped `&lt;b&gt;` become a real tag for the stripper to eat;
    doing it after means the text is treated as text, which is what it is.
    """
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def _unwrap_ddg(href: str) -> str:
    """
    Recover the destination from DuckDuckGo's redirect wrapper.

    Results come back as `//duckduckgo.com/l/?uddg=<percent-encoded>&rut=<hash>`.
    Handed on verbatim that is worse than useless: it is unreadable, it is longer
    than any panel is wide, and it points at a tracker rather than the source. So
    take `uddg`, decode it once, and discard the rest. Anything that doesn't
    match the wrapper shape is returned unchanged — DDG also emits direct hrefs,
    and a guess at their structure would corrupt them.

    The href is unescaped first because it was read out of raw HTML, where the
    separator is `&amp;` rather than `&`. Left escaped, `parse_qs` reads the
    following key as `amp;rut` — harmless while `uddg` happens to come first, and
    a silent miss the day it doesn't.
    """
    clean = html.unescape(href)
    if "uddg=" not in clean:
        return clean
    target = urllib.parse.parse_qs(urllib.parse.urlsplit(clean).query).get("uddg", [""])[0]
    return target or clean


async def scrape_url(payload: dict, ctx: ExecContext) -> dict:
    url = str(payload.get("url", "")).strip()
    if not url.startswith(("http://", "https://")):
        return _fail("a valid http(s) url is required")
    try:
        async with httpx.AsyncClient(
            timeout=20.0, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}
        ) as client:
            resp = await client.get(url)
        text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", resp.text, flags=re.DOTALL)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return _ok(f"Scraped {len(text)} chars from {url}", content=text[:6000], url=url)
    except Exception as exc:
        return _fail(f"scrape failed: {type(exc).__name__}: {exc}")


async def arxiv_search(payload: dict, ctx: ExecContext) -> dict:
    """Query the arXiv Atom API — no key required."""
    query = str(payload.get("query") or payload.get("prompt") or "").strip()
    if not query:
        return _fail("no query supplied")
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                "http://export.arxiv.org/api/query",
                params={"search_query": f"all:{query}", "max_results": 5},
            )
        entries = re.findall(r"<entry>(.*?)</entry>", resp.text, re.DOTALL)
        papers = []
        for e in entries:
            title = re.search(r"<title>(.*?)</title>", e, re.DOTALL)
            link = re.search(r"<id>(.*?)</id>", e, re.DOTALL)
            summary = re.search(r"<summary>(.*?)</summary>", e, re.DOTALL)
            papers.append(
                {
                    "title": re.sub(r"\s+", " ", title.group(1)).strip() if title else "",
                    "url": link.group(1).strip() if link else "",
                    "abstract": (
                        re.sub(r"\s+", " ", summary.group(1)).strip()[:400]
                        if summary
                        else ""
                    ),
                }
            )
        if not papers:
            return _fail(f"no arXiv papers for '{query}'")
        return _ok(
            f"{len(papers)} arXiv papers:\n"
            + "\n".join(f"• {p['title']} — {p['url']}" for p in papers),
            papers=papers,
        )
    except Exception as exc:
        return _fail(f"arXiv query failed: {type(exc).__name__}: {exc}")


# ═══════════════════════════════════════════════════════════════════════════
# Google credentials (Email + Calendar)
# ═══════════════════════════════════════════════════════════════════════════


def _google_credentials():
    """
    Build OAuth credentials from a stored refresh token.

    Returns None when unconfigured so callers can degrade rather than raise.
    """
    client_id = _env("GOOGLE_CLIENT_ID")
    client_secret = _env("GOOGLE_CLIENT_SECRET")
    refresh_token = _env("GOOGLE_REFRESH_TOKEN")
    if not (client_id and client_secret and refresh_token):
        return None
    try:
        from google.oauth2.credentials import Credentials

        return Credentials(
            token=None,
            refresh_token=refresh_token,
            client_id=client_id,
            client_secret=client_secret,
            token_uri="https://oauth2.googleapis.com/token",
            scopes=[
                "https://www.googleapis.com/auth/gmail.readonly",
                "https://www.googleapis.com/auth/gmail.send",
                "https://www.googleapis.com/auth/gmail.compose",
                "https://www.googleapis.com/auth/calendar",
            ],
        )
    except Exception:
        return None


def _google_service(api: str, version: str):
    creds = _google_credentials()
    if creds is None:
        return None
    try:
        from googleapiclient.discovery import build

        return build(api, version, credentials=creds, cache_discovery=False)
    except Exception:
        return None


# ═══════════════════════════════════════════════════════════════════════════
# Email
# ═══════════════════════════════════════════════════════════════════════════


async def list_emails(payload: dict, ctx: ExecContext) -> dict:
    max_results = int(payload.get("max_results", 10))

    def _work() -> dict:
        service = _google_service("gmail", "v1")
        if service is None:
            return _fail(
                "Gmail not connected — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / "
                "GOOGLE_REFRESH_TOKEN to enable the Email Hub",
                messages=[],
                connected=False,
            )
        try:
            listing = (
                service.users()
                .messages()
                .list(userId="me", maxResults=max_results, labelIds=["INBOX"])
                .execute()
            )
            out = []
            for ref in listing.get("messages", []):
                try:
                    msg = (
                        service.users()
                        .messages()
                        .get(
                            userId="me",
                            id=ref["id"],
                            format="metadata",
                            metadataHeaders=["From", "Subject", "Date"],
                        )
                        .execute()
                    )
                    headers = {
                        h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])
                    }
                    out.append(
                        {
                            "id": ref["id"],
                            "from": headers.get("From", ""),
                            "subject": headers.get("Subject", "(no subject)"),
                            "date": headers.get("Date", ""),
                            "snippet": msg.get("snippet", "")[:240],
                            "unread": "UNREAD" in msg.get("labelIds", []),
                        }
                    )
                except Exception:
                    continue
            return _ok(f"{len(out)} inbox messages", messages=out, connected=True)
        except Exception as err:
            return _fail(
                f"Gmail connection error: {err}",
                messages=[],
                connected=False,
            )

    return await asyncio.to_thread(_work)


async def get_email(payload: dict, ctx: ExecContext) -> dict:
    """Fetch the full payload of a single email and extract its body."""
    msg_id = payload.get("id")
    if not msg_id:
        return _fail("no email id provided")

    def _work() -> dict:
        service = _google_service("gmail", "v1")
        if service is None:
            return _fail("Gmail not connected")
        try:
            msg = (
                service.users()
                .messages()
                .get(userId="me", id=msg_id, format="full")
                .execute()
            )
            
            # Helper to extract body from MIME parts
            import base64
            def extract_body(payload_part):
                if payload_part.get("mimeType") == "text/plain":
                    data = payload_part.get("body", {}).get("data", "")
                    if data:
                        return base64.urlsafe_b64decode(data).decode("utf-8", errors="ignore")
                elif payload_part.get("mimeType") == "text/html":
                    data = payload_part.get("body", {}).get("data", "")
                    if data:
                        return base64.urlsafe_b64decode(data).decode("utf-8", errors="ignore")
                
                parts = payload_part.get("parts", [])
                text_body = ""
                html_body = ""
                for part in parts:
                    body = extract_body(part)
                    if part.get("mimeType") == "text/plain" and body:
                        text_body = body
                    elif part.get("mimeType") == "text/html" and body:
                        html_body = body
                return html_body if html_body else text_body

            body_content = extract_body(msg.get("payload", {}))
            
            headers = {
                h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])
            }
            
            # If the user opens an unread email, we can optionally mark it as read here.
            # But the user specifically wanted local states to update, so we'll just return it.
            
            return _ok(
                "email fetched", 
                message={
                    "id": msg["id"],
                    "from": headers.get("From", ""),
                    "subject": headers.get("Subject", "(no subject)"),
                    "date": headers.get("Date", ""),
                    "body": body_content,
                    "unread": "UNREAD" in msg.get("labelIds", []),
                }
            )
        except Exception as err:
            return _fail(f"Failed to fetch email: {err}")
            
    return await asyncio.to_thread(_work)


async def draft_reply(payload: dict, ctx: ExecContext) -> dict:
    """
    Compose a reply without sending it.

    Drafting is intentionally outside the HALO trigger set: nothing leaves the
    machine, so gating it would train the operator to click through approvals.
    """
    body = str(payload.get("body", "")).strip()
    to = str(payload.get("to", "")).strip()
    subject = str(payload.get("subject", "")).strip()
    if not body:
        return _fail("nothing to draft — empty body")
    return _ok(
        f"Draft prepared for {to or 'recipient'}: {subject or '(no subject)'}",
        draft={"to": to, "subject": subject, "body": body},
        sent=False,
    )


async def send_email(payload: dict, ctx: ExecContext) -> dict:
    """Send via Gmail. Reached only after the HALO gate has approved."""
    to = str(payload.get("to", "")).strip()
    subject = str(payload.get("subject", "")).strip()
    body = str(payload.get("body", "")).strip()
    if not to or not body:
        return _fail("`to` and `body` are both required")

    def _work() -> dict:
        service = _google_service("gmail", "v1")
        if service is None:
            return _fail(
                "Gmail not connected — email was NOT sent. Approval was recorded; "
                "configure Google OAuth to complete delivery.",
                delivered=False,
            )
        try:
            mime = MIMEText(body)
            mime["to"] = to
            mime["subject"] = subject or "(no subject)"
            raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
            sent = (
                service.users().messages().send(userId="me", body={"raw": raw}).execute()
            )
            return _ok(f"Email delivered to {to}", message_id=sent.get("id"), delivered=True)
        except Exception as err:
            return _fail(f"Gmail delivery error: {err}", delivered=False)

    result = await asyncio.to_thread(_work)
    ctx.store.log_audit(
        ctx.session_id,
        "email",
        "send_email",
        decision="executed" if result["ok"] else "failed",
        reason=result["summary"],
        payload={"to": to, "subject": subject},
    )
    return result


# ═══════════════════════════════════════════════════════════════════════════
# Calendar
# ═══════════════════════════════════════════════════════════════════════════


def _parse_when(value: Any, default_offset_hours: float = 24.0) -> float:
    """
    Coerce a model-supplied time into a unix timestamp.

    Models emit ISO strings, epoch numbers, and phrases like "tomorrow 3pm"
    interchangeably, so all three are accepted and anything unparseable falls
    back to a sensible offset rather than failing the whole subtask.
    """
    now = time.time()
    if isinstance(value, (int, float)) and value > 1_000_000_000:
        return float(value)

    text = str(value or "").strip()
    if not text:
        return now + default_offset_hours * 3600

    try:
        cleaned = text.replace("Z", "+00:00")
        return datetime.fromisoformat(cleaned).timestamp()
    except ValueError:
        pass

    low = text.lower()
    base = datetime.now()
    day_offset = 1 if "tomorrow" in low else 0
    if "next week" in low:
        day_offset = 7

    hour_match = re.search(r"(\d{1,2})\s*(am|pm)", low)
    hour24_match = re.search(r"\b(\d{1,2}):(\d{2})\b", low)
    hour, minute = 9, 0
    if hour_match:
        hour = int(hour_match.group(1)) % 12
        if hour_match.group(2) == "pm":
            hour += 12
    elif hour24_match:
        hour, minute = int(hour24_match.group(1)), int(hour24_match.group(2))

    target = (base + timedelta(days=day_offset)).replace(
        hour=hour, minute=minute, second=0, microsecond=0
    )
    if target.timestamp() < now:
        target += timedelta(days=1)
    return target.timestamp()


async def create_event(payload: dict, ctx: ExecContext) -> dict:
    """
    Create an event.

    Writes to Google Calendar when connected and always mirrors into local
    SQLite, so the Calendar and Timetable screens render identically online and
    off.
    """
    title = str(payload.get("title") or payload.get("summary") or "Untitled event").strip()
    start_ts = _parse_when(payload.get("start"))
    end_ts = _parse_when(payload.get("end"), default_offset_hours=25.0)
    if end_ts <= start_ts:
        end_ts = start_ts + 3600
    description = str(payload.get("description", ""))
    kind = str(payload.get("kind", "event")).lower()

    google_id: str | None = None
    synced = False

    def _push() -> str | None:
        service = _google_service("calendar", "v3")
        if service is None:
            return None
        created = (
            service.events()
            .insert(
                calendarId="primary",
                body={
                    "summary": title,
                    "description": description,
                    "start": {"dateTime": datetime.fromtimestamp(start_ts).isoformat()},
                    "end": {"dateTime": datetime.fromtimestamp(end_ts).isoformat()},
                },
            )
            .execute()
        )
        return created.get("id")

    try:
        google_id = await asyncio.to_thread(_push)
        synced = google_id is not None
    except Exception as exc:
        ctx.note(f"Google Calendar sync failed ({type(exc).__name__}); stored locally")

    event = ctx.store.add_event(
        title=title,
        start_ts=start_ts,
        end_ts=end_ts,
        description=description,
        kind=kind,
        source="google" if synced else "local",
        event_id=google_id,
    )
    when = datetime.fromtimestamp(start_ts).strftime("%a %d %b, %H:%M")
    return _ok(
        f'Created "{title}" on {when}'
        + ("" if synced else " (stored locally — Google Calendar not connected)"),
        event=event,
        synced=synced,
    )


async def list_events(payload: dict, ctx: ExecContext) -> dict:
    days = float(payload.get("days", 14))
    start_ts = _parse_when(payload.get("start"), 0.0) if payload.get("start") else time.time()
    end_ts = start_ts + days * 86_400
    kinds = payload.get("kinds")
    events = ctx.store.list_events(
        start_ts, end_ts, kinds if isinstance(kinds, list) else None
    )
    if not events:
        return _ok("No events in range", events=[])
    lines = [
        f"• {datetime.fromtimestamp(e['start_ts']).strftime('%a %d %b %H:%M')} — {e['title']}"
        for e in events[:15]
    ]
    return _ok(f"{len(events)} event(s):\n" + "\n".join(lines), events=events)


async def check_availability(payload: dict, ctx: ExecContext) -> dict:
    start_ts = _parse_when(payload.get("start"))
    end_ts = _parse_when(payload.get("end"), default_offset_hours=25.0)
    clashes = ctx.store.list_events(start_ts, end_ts)
    if clashes:
        titles = ", ".join(c["title"] for c in clashes[:4])
        return _ok(f"Busy — {len(clashes)} clash(es): {titles}", free=False, clashes=clashes)
    return _ok("That window is free", free=True, clashes=[])


async def find_meeting_time(payload: dict, ctx: ExecContext) -> dict:
    """
    First free slot inside working hours.

    Scans forward in 30-minute steps rather than solving an optimisation problem:
    for a personal calendar the first viable slot is almost always the answer.
    """
    duration = float(payload.get("duration_mins", 60)) * 60
    horizon_days = float(payload.get("within_days", 7))
    now = time.time()
    horizon = now + horizon_days * 86_400
    busy = ctx.store.list_events(now, horizon)

    cursor = now
    step = 1800
    while cursor + duration <= horizon:
        dt = datetime.fromtimestamp(cursor)
        if 9 <= dt.hour < 18 and dt.weekday() < 5:
            slot_end = cursor + duration
            if not any(
                b["start_ts"] < slot_end and b["end_ts"] > cursor for b in busy
            ):
                return _ok(
                    f"Free slot: {dt.strftime('%a %d %b %H:%M')} "
                    f"for {int(duration / 60)} min",
                    start_ts=cursor,
                    end_ts=slot_end,
                )
        cursor += step
    return _fail(f"No {int(duration / 60)}-minute slot found within {horizon_days:g} days")


async def delete_event(payload: dict, ctx: ExecContext) -> dict:
    """Delete an event. Reached only after HALO approval."""
    event_id = str(payload.get("event_id", "")).strip()
    if not event_id:
        return _fail("event_id is required")

    def _remote() -> bool:
        service = _google_service("calendar", "v3")
        if service is None:
            return False
        service.events().delete(calendarId="primary", eventId=event_id).execute()
        return True

    remote_ok = False
    try:
        remote_ok = await asyncio.to_thread(_remote)
    except Exception:
        remote_ok = False

    local_ok = ctx.store.delete_event(event_id)
    ctx.store.log_audit(
        ctx.session_id,
        "calendar",
        "delete_event",
        decision="executed" if (local_ok or remote_ok) else "not_found",
        reason=f"remote={remote_ok} local={local_ok}",
        payload={"event_id": event_id},
    )
    if not (local_ok or remote_ok):
        return _fail(f"No event matched id {event_id}")
    return _ok(f"Deleted event {event_id}", remote=remote_ok, local=local_ok)


async def fetch_today_tomorrow(payload: dict, ctx: ExecContext) -> dict:
    now = time.time()
    events = ctx.store.list_events(now, now + 2 * 86_400)
    if not events:
        return _ok("Nothing scheduled for today or tomorrow", events=[])
    lines = [
        f"• {datetime.fromtimestamp(e['start_ts']).strftime('%a %H:%M')} — {e['title']}"
        for e in events
    ]
    return _ok("Next 48 hours:\n" + "\n".join(lines), events=events)


# ═══════════════════════════════════════════════════════════════════════════
# SMS / Telecom
# ═══════════════════════════════════════════════════════════════════════════


def _twilio_creds() -> tuple[str, str]:
    return _env("TWILIO_ACCOUNT_SID"), _env("TWILIO_AUTH_TOKEN")


def _twilio_origin() -> dict[str, str]:
    """
    The `from` half of a Twilio request, as kwargs.

    A Messaging Service is preferred over a bare number when both are set: it is
    what a Twilio console hands you first, it survives adding or renumbering
    senders without a redeploy, and it is the only form that works for accounts
    with no purchasable local number — which is the situation for the +234 number
    configured here. `from_` remains supported because voice has no equivalent.
    """
    service = _env("TWILIO_MESSAGING_SERVICE_SID")
    if service:
        return {"messaging_service_sid": service}
    number = _env("TWILIO_PHONE_NUMBER")
    return {"from_": number} if number else {}


# The Twilio error codes a young account actually hits, in plain language.
#
# Deliberately short. A full table would be a copy of Twilio's docs that goes
# stale, and every code not listed here still surfaces with its number and
# Twilio's own message — which beats a wrong guess. What earns a line is a
# failure whose fix is a specific console setting the reader would otherwise
# have to search for.
_TWILIO_CODES: dict[int, str] = {
    20003: "authentication failed — check TWILIO_AUTH_TOKEN.",
    21211: "that number is not valid E.164 — it needs the + and country code.",
    21215: "calling this country is not enabled. Voice → Dialing Permissions.",
    21219: "trial account — verify this number under Verified Caller IDs first.",
    21408: "texting this country is not enabled. Messaging → Geo Permissions.",
    21606: "the sender cannot send SMS — check the Messaging Service has a number in it.",
    21608: "trial account — texts only reach verified numbers.",
    30007: "the carrier filtered the message as spam.",
    30032: "the toll-free number is not verified yet.",
    30034: "the number is not registered for A2P 10DLC — carrier registration is still pending.",
    63038: "the trial account's daily message limit is used up.",
}


def _twilio_error(exc: Exception) -> tuple[str, str]:
    """
    A Twilio failure as `(thread status, sentence)`.

    `TwilioRestException` stringifies to a multi-line HTTP dump with a docs URL
    in it. That is the wrong thing to put in a chat bubble, and it buries the
    only field that says what to do: the numeric code. So the code becomes the
    status the Telecom thread displays, and the sentence explains it.

    The exception is read by duck-typing rather than by catching the class,
    because `twilio` is imported lazily on the send path — nothing here should
    need the SDK installed in order to report that it isn't.
    """
    code = getattr(exc, "code", None)
    # `.msg` is Twilio's own one-line description; `str(exc)` is the dump. Take
    # the first line of whichever is available so a bubble stays one line.
    detail = (str(getattr(exc, "msg", "") or exc).strip().splitlines() or [""])[0]

    if not isinstance(code, int):
        return f"failed: {type(exc).__name__}", f"{type(exc).__name__}: {detail}"
    return f"failed: Twilio {code}", f"Twilio {code} — {_TWILIO_CODES.get(code, detail)}"


async def send_sms(payload: dict, ctx: ExecContext) -> dict:
    """
    Send a text via Twilio. Reached only after HALO approval.

    Outbound is recorded locally regardless of delivery outcome, so the Telecom
    thread reflects intent even when Twilio is unreachable — and the recorded
    status says plainly which happened.
    """
    to = str(payload.get("to") or payload.get("peer") or "").strip()
    body = str(payload.get("body") or payload.get("message") or "").strip()
    if not to or not body:
        return _fail("`to` and `body` are both required")

    sid, token = _twilio_creds()
    origin = _twilio_origin()

    if not (sid and token and origin):
        msg = ctx.store.add_sms("outbound", to, body, status="unsent-no-credentials")
        return _fail(
            "Twilio not configured — message recorded locally but NOT delivered. "
            "Set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN plus either "
            "TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER.",
            message=msg.__dict__,
            delivered=False,
        )

    def _work() -> str:
        from twilio.rest import Client

        client = Client(sid, token)
        sent = client.messages.create(to=to, body=body, **origin)
        return sent.sid

    try:
        twilio_sid = await asyncio.to_thread(_work)
        msg = ctx.store.add_sms("outbound", to, body, status="delivered")
        ctx.store.log_audit(
            ctx.session_id,
            "sms",
            "send_sms",
            decision="executed",
            reason=f"twilio sid {twilio_sid}",
            payload={"to": to},
        )
        return _ok(f"SMS delivered to {to}", message=msg.__dict__, delivered=True, twilio_sid=twilio_sid)
    except Exception as exc:
        status, sentence = _twilio_error(exc)
        msg = ctx.store.add_sms("outbound", to, body, status=status)
        ctx.store.log_audit(
            ctx.session_id,
            "sms",
            "send_sms",
            decision="failed",
            reason=str(exc)[:300],
            payload={"to": to},
        )
        return _fail(
            f"Not delivered — {sentence} The text is saved in the thread.",
            message=msg.__dict__,
            delivered=False,
        )


def _twiml(script: str) -> str:
    """
    Wrap a line of speech as TwiML.

    Twilio fetches call instructions from a URL by default, which would mean
    running a public webhook just to say one sentence. `twiml=` passes the
    document inline instead, so a call needs no ingress and no tunnel — the whole
    reason this works from a laptop.

    The script is XML-escaped: it is model-authored text landing inside a
    document Twilio parses, and an unescaped `&` alone would make the call fail.
    """
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Response><Say voice=\"Polly.Joanna\">{html.escape(script)}</Say></Response>"
    )


async def make_call(payload: dict, ctx: ExecContext) -> dict:
    """
    Place a voice call via Twilio and speak a line. Reached only after HALO.

    Voice cannot use a Messaging Service, so this needs a real
    `TWILIO_PHONE_NUMBER` even when texting is going out through an MG SID — the
    error says so explicitly rather than reporting a generic misconfiguration.

    Recorded in the same thread as texts with `kind="call"`, so the Telecom panel
    shows one ordered history per contact instead of two parallel ones.
    """
    to = str(payload.get("to") or payload.get("peer") or "").strip()
    script = str(
        payload.get("script") or payload.get("say") or payload.get("body") or ""
    ).strip()
    if not to:
        return _fail("`to` is required")
    if not script:
        return _fail("`script` is required — what should the call say?")

    sid, token = _twilio_creds()
    from_num = _env("TWILIO_PHONE_NUMBER")

    if not (sid and token and from_num):
        msg = ctx.store.add_sms(
            "outbound", to, script, status="unplaced-no-credentials", kind="call"
        )
        missing = (
            "TWILIO_PHONE_NUMBER (voice cannot use a Messaging Service SID)"
            if sid and token
            else "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER"
        )
        return _fail(
            f"Twilio not configured — call recorded locally but NOT placed. Set {missing}.",
            message=msg.__dict__,
            placed=False,
        )

    def _work() -> str:
        from twilio.rest import Client

        client = Client(sid, token)
        call = client.calls.create(to=to, from_=from_num, twiml=_twiml(script))
        return call.sid

    try:
        call_sid = await asyncio.to_thread(_work)
        # "ringing", not "delivered": calls.create returns as soon as Twilio
        # queues the call, long before anyone answers. Claiming delivery here
        # would be a guess.
        msg = ctx.store.add_sms("outbound", to, script, status="ringing", kind="call")
        ctx.store.log_audit(
            ctx.session_id,
            "sms",
            "make_call",
            decision="executed",
            reason=f"twilio call sid {call_sid}",
            payload={"to": to},
        )
        return _ok(
            f"Calling {to} — Twilio is dialling now",
            message=msg.__dict__,
            placed=True,
            twilio_sid=call_sid,
        )
    except Exception as exc:
        status, sentence = _twilio_error(exc)
        msg = ctx.store.add_sms("outbound", to, script, status=status, kind="call")
        ctx.store.log_audit(
            ctx.session_id,
            "sms",
            "make_call",
            decision="failed",
            reason=str(exc)[:300],
            payload={"to": to},
        )
        return _fail(
            f"Not placed — {sentence} The script is saved in the thread.",
            message=msg.__dict__,
            placed=False,
        )


async def list_messages(payload: dict, ctx: ExecContext) -> dict:
    threads = ctx.store.list_sms_threads()
    total = sum(len(t["messages"]) for t in threads)
    calls = sum(
        1 for t in threads for m in t["messages"] if m.get("kind") == "call"
    )
    return _ok(
        f"{len(threads)} thread(s), {total} item(s) including {calls} call(s)",
        threads=threads,
    )


async def draft_reply_sms(payload: dict, ctx: ExecContext) -> dict:
    """Prepare an SMS reply for review. No send, so no gate."""
    peer = str(payload.get("peer") or payload.get("to") or "").strip()
    body = str(payload.get("body") or payload.get("message") or "").strip()
    if not body:
        return _fail("nothing to draft — empty body")
    return _ok(
        f"Draft reply to {peer or 'contact'} ready for approval",
        draft={"peer": peer, "body": body},
        sent=False,
    )


# ═══════════════════════════════════════════════════════════════════════════
# File / Code
# ═══════════════════════════════════════════════════════════════════════════


def _artifacts_dir(policy: ConcaPolicy) -> Path:
    """Default write target, taken from `.conca` rather than hardcoded."""
    base = policy.rules.default_save_path or str(Path.home() / "Desktop")
    d = Path(base) / "concaretti-artifacts"
    d.mkdir(parents=True, exist_ok=True)
    return d


async def read_file(payload: dict, ctx: ExecContext) -> dict:
    raw_path = str(payload.get("path", "")).strip()
    if not raw_path:
        return _fail("path is required")

    allowed, reason = check_path(ctx.policy, raw_path)
    if not allowed:
        ctx.store.log_audit(
            ctx.session_id, "file", "read_file", decision="blocked", reason=reason,
            payload={"path": raw_path},
        )
        return _fail(f"Refused by .conca: {reason}")

    p = Path(canonical_path(raw_path))
    if not p.is_file():
        return _fail(f"No such file: {raw_path}")
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return _fail(f"read failed: {type(exc).__name__}: {exc}")
    return _ok(f"Read {len(text)} chars from {p.name}", content=text[:8000], path=str(p))


async def write_file(payload: dict, ctx: ExecContext) -> dict:
    """Write a file. Reached only after HALO approval."""
    filename = str(payload.get("filename") or payload.get("name") or "").strip()
    raw_path = str(payload.get("path", "")).strip()
    content = payload.get("content") or ""
    if isinstance(content, (dict, list)):
        import json as _json

        content = _json.dumps(content, indent=2)
    content = str(content)

    if not raw_path:
        if not filename:
            filename = f"concaretti-{int(time.time())}.txt"
        raw_path = str(_artifacts_dir(ctx.policy) / filename)

    allowed, reason = check_path(ctx.policy, raw_path)
    if not allowed:
        ctx.store.log_audit(
            ctx.session_id, "file", "write_file", decision="blocked", reason=reason,
            payload={"path": raw_path},
        )
        return _fail(f"Refused by .conca: {reason}")

    size_ok, size_reason = check_file_size(ctx.policy, content)
    if not size_ok:
        ctx.store.log_audit(
            ctx.session_id, "file", "write_file", decision="blocked", reason=size_reason,
            payload={"path": raw_path},
        )
        return _fail(f"Refused by .conca: {size_reason}")

    p = Path(canonical_path(raw_path))
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    except Exception as exc:
        return _fail(f"write failed: {type(exc).__name__}: {exc}")

    artifact = ctx.store.record_artifact(
        session_id=ctx.session_id,
        filename=p.name,
        mime="text/plain",
        path=str(p),
        content=content.encode("utf-8"),
        prompt=ctx.prompt,
    )
    # Publish the whole record, not just a filename: the Artifact panel shows
    # provenance (hash + originating prompt), and a partial event would leave it
    # to re-fetch for fields it could have had.
    ctx.broker.publish(ctx.session_id, "artifact", asdict(artifact))
    ctx.store.log_audit(
        ctx.session_id, "file", "write_file", decision="executed",
        reason=f"wrote {len(content)} bytes", payload={"path": str(p)},
    )
    return _ok(
        f"Wrote {len(content)} bytes to {p}",
        path=str(p),
        sha256=artifact.sha256,
        artifact_id=artifact.id,
    )


async def list_dir(payload: dict, ctx: ExecContext) -> dict:
    raw_path = str(payload.get("path") or ctx.policy.rules.default_save_path or ".").strip()
    allowed, reason = check_path(ctx.policy, raw_path)
    if not allowed:
        return _fail(f"Refused by .conca: {reason}")
    p = Path(canonical_path(raw_path))
    if not p.is_dir():
        return _fail(f"Not a directory: {raw_path}")
    entries = []
    for child in sorted(p.iterdir())[:100]:
        entries.append(
            {
                "name": child.name,
                "is_dir": child.is_dir(),
                "size": child.stat().st_size if child.is_file() else None,
            }
        )
    return _ok(f"{len(entries)} entries in {p}", entries=entries, path=str(p))


async def run_python(payload: dict, ctx: ExecContext) -> dict:
    """
    Execute a Python snippet in a subprocess. Reached only after HALO approval.

    The snippet is screened by the shell normalizer first: it is the same
    deobfuscation pass used for shell commands, so a payload that spells out an
    off-limits path in hex is caught before the interpreter starts. Sandboxing is
    a subprocess and a timeout, which is bounded rather than airtight — the
    honest limitation to state in a defence.
    """
    code = str(payload.get("code") or payload.get("script") or "").strip()
    if not code:
        return _fail("no code supplied")

    safe, reason = is_safe(ctx.policy, code)
    if not safe:
        ctx.store.log_audit(
            ctx.session_id, "file", "python_execute", decision="blocked", reason=reason,
            payload={"code": code},
        )
        return _fail(f"Refused by .conca: {reason}", normalized=normalize_command(code))

    try:
        proc = await asyncio.create_subprocess_exec(
            os.environ.get("PYTHON_EXE", "python"),
            "-I",
            "-c",
            code,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(_artifacts_dir(ctx.policy)),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=20.0)
    except asyncio.TimeoutError:
        return _fail("execution exceeded the 20s limit and was killed")
    except FileNotFoundError:
        return _fail("no python interpreter on PATH; set PYTHON_EXE")
    except Exception as exc:
        return _fail(f"execution failed: {type(exc).__name__}: {exc}")

    out = stdout.decode("utf-8", "replace")[:4000]
    err = stderr.decode("utf-8", "replace")[:2000]
    ctx.store.log_audit(
        ctx.session_id, "file", "python_execute", decision="executed",
        reason=f"exit {proc.returncode}", payload={"code": code},
    )
    if proc.returncode != 0:
        return _fail(f"exited {proc.returncode}\n{err}", stdout=out, stderr=err)
    return _ok(out.strip() or "(no output)", stdout=out, stderr=err)


async def os_execute(payload: dict, ctx: ExecContext) -> dict:
    command = str(payload.get("command", "")).strip()
    if not command:
        return _fail("no command supplied")
    safe, reason = is_safe(ctx.policy, command)
    if not safe:
        return _fail(f"Refused by .conca: {reason}")
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=20.0)
    except asyncio.TimeoutError:
        return _fail("execution exceeded 20s limit")
    except Exception as exc:
        return _fail(f"execution failed: {exc}")
    
    out = stdout.decode("utf-8", "replace")[:4000]
    return _ok(out.strip() or "(no output)", stdout=out)


async def media_state(payload: dict, ctx: ExecContext) -> dict:
    media_apps = ["spotify", "vlc", "wmplayer", "music", "chrome", "msedge"]
    found = []
    for p in psutil.process_iter(['name']):
        try:
            name = p.info['name'].lower()
            if any(m in name for m in media_apps):
                found.append(name)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    if not found:
        return _ok("No media players appear to be active.")
    return _ok(f"Active media-related processes: {', '.join(set(found))}")


_CLICK_WAV = Path(__file__).resolve().parent / "data" / "mechanical_click.wav"


def _play_acoustic_clack():
    """Play crisp asynchronous mechanical switch audio click on Windows on each key hit."""
    if sys.platform == "win32":
        try:
            import winsound
            if _CLICK_WAV.exists():
                winsound.PlaySound(str(_CLICK_WAV), winsound.SND_FILENAME | winsound.SND_ASYNC)
                return
            winsound.Beep(2100, 20)
        except Exception:
            pass


def show_click_indicator(x: int, y: int, button: str = "left") -> None:
    """Spawn high-visibility animated touch ripple (fingerprint pulse) on the screen."""
    if sys.platform == "win32":
        try:
            script = Path(__file__).resolve().parent / "click_visualizer.py"
            if script.exists():
                flags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
                subprocess.Popen(
                    [sys.executable, str(script), str(int(x)), str(int(y)), str(button)],
                    creationflags=flags,
                )
        except Exception:
            pass


async def mouse_move(payload: dict, ctx: ExecContext) -> dict:
    pyautogui.FAILSAFE = False
    x = max(5, int(payload.get("x", 100)))
    y = max(5, int(payload.get("y", 100)))
    duration = max(0.1, float(payload.get("duration", 0.6)))
    status = str(payload.get("status", "Concaretti: Navigating"))

    # Signal visible companion cursor
    try:
        from cursor_companion import get_cursor_accompanier
        get_cursor_accompanier().move_to(x, y, duration=duration, status=status)
    except Exception:
        pass
    
    # Smooth human-like Bezier easing across the Windows desktop
    def _work():
        try:
            pyautogui.moveTo(x, y, duration=duration, tween=pyautogui.easeInOutQuad)
        except Exception:
            pass
    await asyncio.to_thread(_work)
    
    ctx.broker.activity(ctx.session_id, f"OS Agent glided mouse cursor to ({x}, {y})")
    return _ok(f"Moved mouse cursor to ({x}, {y})")


async def mouse_click(payload: dict, ctx: ExecContext) -> dict:
    pyautogui.FAILSAFE = False
    x = payload.get("x")
    y = payload.get("y")
    button = str(payload.get("button", "left")).lower()
    clicks = int(payload.get("clicks", 1))

    target_x, target_y = 0, 0
    try:
        if x is not None and y is not None:
            target_x, target_y = max(5, int(x)), max(5, int(y))
        else:
            cur = pyautogui.position()
            target_x, target_y = int(cur.x), int(cur.y)
    except Exception:
        pass

    # Visual click ripple from cursor accompanier & GDI
    try:
        from cursor_companion import get_cursor_accompanier
        get_cursor_accompanier().click(target_x, target_y, button=button)
    except Exception:
        pass
    show_click_indicator(target_x, target_y, button=button)
    
    def _work():
        try:
            if x is not None and y is not None:
                pyautogui.click(x=target_x, y=target_y, clicks=clicks, button=button)
            else:
                pyautogui.click(clicks=clicks, button=button)
        except Exception:
            pass
    await asyncio.to_thread(_work)
    
    ctx.broker.activity(ctx.session_id, f"OS Agent clicked {button} button ({clicks}x) at ({target_x}, {target_y})")
    return _ok(f"Clicked {button} mouse button ({clicks} clicks)")


async def mouse_drag(payload: dict, ctx: ExecContext) -> dict:
    pyautogui.FAILSAFE = False
    x = max(5, int(payload.get("x", 100)))
    y = max(5, int(payload.get("y", 100)))
    duration = max(0.1, float(payload.get("duration", 0.6)))
    
    def _work():
        try:
            pyautogui.dragTo(x, y, duration=duration, tween=pyautogui.easeInOutQuad)
        except Exception:
            pass
    await asyncio.to_thread(_work)
    
    ctx.broker.activity(ctx.session_id, f"OS Agent dragged mouse to ({x}, {y})")
    return _ok(f"Dragged mouse to ({x}, {y})")


async def keyboard_type(payload: dict, ctx: ExecContext) -> dict:
    pyautogui.FAILSAFE = False
    text = str(payload.get("text", ""))
    sound = payload.get("sound", True)
    wpm = int(payload.get("wpm", 50))
    delay = 60.0 / (wpm * 5.0) if wpm > 0 else 0.08
    delay = max(0.065, min(0.14, delay))

    try:
        from cursor_companion import get_cursor_accompanier
        acc = get_cursor_accompanier()
        acc.type_at(acc._x, acc._y, status="Typing...")
    except Exception:
        pass

    if text:
        def _type_work():
            import random
            for char in text:
                if sound:
                    _play_acoustic_clack()
                try:
                    pyautogui.write(char)
                except Exception:
                    pass
                time.sleep(delay + random.uniform(-0.008, 0.012))
        await asyncio.to_thread(_type_work)

    keys = payload.get("keys", [])
    if isinstance(keys, str):
        keys = [keys]
    for k in keys:
        if sound:
            _play_acoustic_clack()
        try:
            pyautogui.press(k)
        except Exception:
            pass
        time.sleep(delay)
            
    ctx.broker.activity(ctx.session_id, f"OS Agent typed {len(text)} characters into active window")
    return _ok(f"Typed {len(text)} characters into active window.")

async def mouse_scroll(payload: dict, ctx: ExecContext) -> dict:
    pyautogui.FAILSAFE = False
    amount = int(payload.get("amount", -500))  # negative is usually scroll down
    
    try:
        from cursor_companion import get_cursor_accompanier
        acc = get_cursor_accompanier()
        acc.scroll_at(acc._x, acc._y, amount=amount, status=f"Scrolling {amount}")
    except Exception:
        pass
        
    def _work():
        try:
            pyautogui.scroll(amount)
        except Exception:
            pass
    await asyncio.to_thread(_work)
    
    ctx.broker.activity(ctx.session_id, f"OS Agent scrolled {amount}")
    return _ok(f"Scrolled window by {amount}.")


async def vision_act(payload: dict, ctx: ExecContext) -> dict:
    """Takes a screenshot, passes it to the Vision LLM to locate an element, and clicks/types on it."""
    instruction = payload.get("instruction")
    if not instruction:
        return _fail("`instruction` required (e.g. 'click the green submit button')")
        
    try:
        import mss
        with mss.mss() as sct:
            monitor = sct.monitors[1]  # primary monitor
            sct_img = sct.grab(monitor)
            import mss.tools
            raw_bytes = mss.tools.to_png(sct_img.rgb, sct_img.size)
    except Exception as e:
        return _fail(f"Failed to capture screen: {e}")
        
    prompt = f"I need to {instruction}. Based on this screenshot, give me the exact X and Y coordinates to interact with. Output ONLY valid JSON: {{\"x\": int, \"y\": int, \"action\": \"click\" or \"type\", \"text\": \"optional text to type\"}}"
    
    ctx.broker.thought(ctx.session_id, f"Capturing screen to: {instruction}")
    
    res = await ctx.rotator.complete_vision(prompt, raw_bytes)
    
    try:
        import json
        data = json.loads(res.text.strip().strip("`").removeprefix("json\n"))
        x, y = data.get("x"), data.get("y")
        action = data.get("action", "click")
        
        if x and y:
            await mouse_move({"x": x, "y": y, "duration": 0.8}, ctx)
            await asyncio.sleep(0.3)
            if action == "click":
                await mouse_click({"x": x, "y": y, "button": "left"}, ctx)
            elif action == "type":
                await mouse_click({"x": x, "y": y, "button": "left"}, ctx)
                await asyncio.sleep(0.2)
                await keyboard_type({"text": data.get("text", "")}, ctx)
            return _ok(f"Successfully performed '{action}' at ({x}, {y})")
        else:
            return _fail("Vision LLM failed to return valid coordinates.")
    except Exception as e:
        return _fail(f"Vision LLM failed to parse coordinates: {res.text}. Error: {e}")

async def open_onscreen_keyboard(payload: dict, ctx: ExecContext) -> dict:
    if sys.platform == "win32":
        try:
            subprocess.Popen(["cmd.exe", "/c", "start", "osk.exe"], shell=True)
            ctx.broker.activity(ctx.session_id, "Launched Windows On-Screen Keyboard (osk.exe)")
            return _ok("Launched Windows On-Screen Keyboard (osk.exe). You can now watch keys highlight in real time.")
        except Exception as e:
            return _fail(f"Could not open on-screen keyboard: {e}")
    return _fail("On-screen keyboard only supported on Windows.")


async def keyboard_hotkey(payload: dict, ctx: ExecContext) -> dict:
    keys = payload.get("keys", [])
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.split("+")]
    if not keys:
        return _fail("`keys` list required (e.g. ['win', 'r'] or 'ctrl+c')")
    
    def _work():
        pyautogui.hotkey(*keys)
    await asyncio.to_thread(_work)
    
    ctx.broker.activity(ctx.session_id, f"OS Agent pressed hotkey: {' + '.join(keys)}")
    return _ok(f"Pressed hotkey combination: {' + '.join(keys)}")


async def launch_app(payload: dict, ctx: ExecContext) -> dict:
    app = str(payload.get("app") or payload.get("name") or "").strip()
    if not app:
        return _fail("`app` name required")
    app_map = {
        "notepad": "notepad.exe",
        "calculator": "calc.exe",
        "calc": "calc.exe",
        "explorer": "explorer.exe",
        "terminal": "wt.exe",
        "cmd": "cmd.exe",
        "powershell": "powershell.exe",
        "keyboard": "osk.exe",
        "osk": "osk.exe",
    }
    cmd = app_map.get(app.lower(), app)
    try:
        subprocess.Popen(["cmd.exe", "/c", "start", cmd], shell=True)
        ctx.broker.activity(ctx.session_id, f"Launched desktop application: {app}")
        return _ok(f"Launched {app} on desktop")
    except Exception as e:
        return _fail(f"Could not launch {app}: {e}")


async def speak(payload: dict, ctx: ExecContext) -> dict:
    """Audibly speak text using ultra-realistic Microsoft Edge Neural TTS."""
    text = str(payload.get("text") or payload.get("message") or "").strip()
    if not text:
        return _fail("`text` parameter required")
    
    try:
        import edge_tts
        import pygame
        import tempfile
        import os
        
        # Use a high-quality neural voice
        voice = "en-US-ChristopherNeural"
        communicate = edge_tts.Communicate(text, voice)
        
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as fp:
            temp_path = fp.name
            
        await communicate.save(temp_path)
        
        def _play():
            try:
                pygame.mixer.init()
                pygame.mixer.music.load(temp_path)
                pygame.mixer.music.play()
                while pygame.mixer.music.get_busy():
                    time.sleep(0.1)
                pygame.mixer.quit()
            except Exception:
                pass
            finally:
                try:
                    os.unlink(temp_path)
                except Exception:
                    pass
                    
        await asyncio.to_thread(_play)
        ctx.broker.activity(ctx.session_id, f"OS Agent spoke (Neural TTS): \"{text}\"")
        return _ok(f"Spoke aloud: \"{text}\"")
    except Exception as e:
        return _fail(f"Failed to speak via neural TTS: {e}")


async def find_window(payload: dict, ctx: ExecContext) -> dict:
    """Locate an application window by title or class and return its coordinates."""
    query = str(payload.get("query") or payload.get("title") or payload.get("app") or "").strip().lower()
    if not query:
        return _fail("`query` or `title` required")
    if sys.platform != "win32":
        return _fail("Window inspection only supported on Windows.")

    try:
        import win32gui
        import ctypes
        u32 = ctypes.windll.user32
        hdesk = u32.OpenInputDesktop(0, False, 0x01FF)
        if hdesk:
            u32.SetThreadDesktop(hdesk)

        matches = []
        def _enum(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                cls = win32gui.GetClassName(hwnd)
                if query in title.lower() or query in cls.lower():
                    rect = win32gui.GetWindowRect(hwnd)
                    matches.append({
                        "hwnd": hwnd,
                        "title": title,
                        "class": cls,
                        "rect": {"left": rect[0], "top": rect[1], "right": rect[2], "bottom": rect[3]},
                        "center": {"x": (rect[0] + rect[2]) // 2, "y": (rect[1] + rect[3]) // 2},
                    })
        win32gui.EnumWindows(_enum, None)
        if not matches:
            return _fail(f"No visible window matching '{query}' found.")
        target = matches[0]
        # Optionally bring to front
        if payload.get("focus", True):
            win32gui.ShowWindow(target["hwnd"], 9) # SW_RESTORE
            win32gui.SetForegroundWindow(target["hwnd"])
        ctx.broker.activity(ctx.session_id, f"Located window '{target['title']}' at center ({target['center']['x']}, {target['center']['y']})")
        return _ok(f"Found window: {target['title']}", window=target)
    except Exception as e:
        return _fail(f"Could not find window: {e}")


def _get_windows_idle_ms() -> int:
    """Return milliseconds since last physical user keyboard or mouse input."""
    if sys.platform != "win32":
        return 0
    try:
        import ctypes
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]
        lii = LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
            millis = ctypes.windll.kernel32.GetTickCount()
            return max(0, millis - lii.dwTime)
    except Exception:
        pass
    return 0


async def detect_os_input_state(payload: dict, ctx: ExecContext) -> dict:
    """Detect OS-level physical user typing, mouse movement, and idle status."""
    idle_ms = _get_windows_idle_ms()
    idle_s = round(idle_ms / 1000.0, 2)
    user_active = idle_s < 4.0

    pos = {"x": 0, "y": 0}
    try:
        cur = pyautogui.position()
        pos = {"x": int(cur.x), "y": int(cur.y)}
    except Exception:
        pass

    state_desc = "Operator active at keyboard/mouse" if user_active else f"Operator hands-off (idle {idle_s}s)"
    ctx.broker.activity(ctx.session_id, f"OS Input State: {state_desc}, cursor at ({pos['x']}, {pos['y']})")
    
    return _ok(
        f"OS input: {state_desc}",
        idle_seconds=idle_s,
        user_active=user_active,
        cursor_pos=pos,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Scheduler
# ═══════════════════════════════════════════════════════════════════════════


async def set_reminder(payload: dict, ctx: ExecContext) -> dict:
    prompt = str(payload.get("prompt") or payload.get("task") or "").strip()
    cron = str(payload.get("cron", "")).strip()
    if not prompt:
        return _fail("nothing to remind about")
    if not cron:
        when = _parse_when(payload.get("when"))
        dt = datetime.fromtimestamp(when)
        cron = f"{dt.minute} {dt.hour} {dt.day} {dt.month} *"
    job = ctx.store.upsert_job(cron, prompt)
    return _ok(f'Reminder registered ({cron}): "{prompt}"', job=job)


async def list_scheduled(payload: dict, ctx: ExecContext) -> dict:
    jobs = ctx.store.list_jobs()
    if not jobs:
        return _ok("No scheduled jobs", jobs=[])
    return _ok(
        f"{len(jobs)} scheduled job(s):\n"
        + "\n".join(f"• [{j['cron']}] {j['prompt']}" for j in jobs),
        jobs=jobs,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Therapy (Rule 0)
# ═══════════════════════════════════════════════════════════════════════════


async def reflect(payload: dict, ctx: ExecContext) -> dict:
    """
    Supportive acknowledgement.

    Deliberately thin: the substantive behaviour is the *absence* of persistence.
    Rule 0 in `memory.append_entry` keeps this turn out of the vector index, so
    nothing said here can resurface in a later session's recall.
    """
    return _ok(
        "Acknowledged supportively. This exchange is excluded from long-term "
        "memory under Rule 0 and will not be recalled in future sessions.",
        rule0_excluded=True,
    )


# ═══════════════════════════════════════════════════════════════════════════
# GitHub intelligence
# ═══════════════════════════════════════════════════════════════════════════

_GH_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "concaretti-light",
}


def _gh_json(resp: Any, default: Any) -> Any:
    """Unwrap a gathered response, tolerating both exceptions and error codes."""
    if isinstance(resp, BaseException) or resp.status_code >= 400:
        return default
    try:
        return resp.json()
    except Exception:
        return default


def _gh_list(resp: Any) -> list:
    body = _gh_json(resp, [])
    return body if isinstance(body, list) else []


async def github_summary(payload: dict, ctx: ExecContext) -> dict:
    """
    Repository telemetry: recent commits, open PRs, and the latest CI outcome.

    Read-only by construction — there is no write path in this tool at all. That
    is why `github` can be enabled in .conca while `deploy` stays off: reading a
    repository's state and pushing to it are different powers, and the policy is
    only meaningful if it distinguishes them.

    Works unauthenticated against public repos at 60 requests/hour. `GITHUB_TOKEN`
    raises that to 5000 and makes private repositories visible.
    """
    repo = str(payload.get("repo") or payload.get("repository") or "").strip()
    repo = re.sub(r"^https?://(?:www\.)?github\.com/", "", repo).strip("/")
    repo = re.sub(r"\.git$", "", repo)
    if not repo:
        return _fail('`repo` is required, as "owner/name"')
    if repo.count("/") != 1 or not all(repo.split("/")):
        return _fail(f'Could not read "{repo}" as owner/name')

    headers = dict(_GH_HEADERS)
    token = _env("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    ctx.note(f"Reading {repo} from GitHub")
    base = f"https://api.github.com/repos/{repo}"
    async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
        meta_r, commits_r, prs_r, runs_r = await asyncio.gather(
            client.get(base),
            client.get(f"{base}/commits", params={"per_page": 10}),
            client.get(f"{base}/pulls", params={"state": "open", "per_page": 10}),
            client.get(f"{base}/actions/runs", params={"per_page": 5}),
            return_exceptions=True,
        )

    if isinstance(meta_r, BaseException):
        return _fail(f"GitHub unreachable: {type(meta_r).__name__}: {meta_r}")
    if meta_r.status_code == 404:
        return _fail(f"{repo} not found. If it is private, set GITHUB_TOKEN.")
    if meta_r.status_code == 403:
        return _fail(
            "GitHub rate limit reached for unauthenticated requests. Set "
            "GITHUB_TOKEN to raise the ceiling to 5000/hour."
        )
    if meta_r.status_code >= 400:
        return _fail(f"GitHub returned {meta_r.status_code} for {repo}")

    meta = _gh_json(meta_r, {})
    commits = [
        {
            "sha": str(c.get("sha") or "")[:7],
            "message": str((c.get("commit") or {}).get("message") or "").split("\n")[0][
                :120
            ],
            "author": ((c.get("commit") or {}).get("author") or {}).get("name", ""),
            "date": ((c.get("commit") or {}).get("author") or {}).get("date", ""),
        }
        for c in _gh_list(commits_r)[:10]
        if isinstance(c, dict)
    ]
    prs = [
        {
            "number": p.get("number"),
            "title": str(p.get("title") or "")[:140],
            "author": (p.get("user") or {}).get("login", ""),
            "draft": bool(p.get("draft")),
            "updated": p.get("updated_at", ""),
        }
        for p in _gh_list(prs_r)[:10]
        if isinstance(p, dict)
    ]
    runs_body = _gh_json(runs_r, {})
    runs = [
        {
            "name": r.get("name", ""),
            "status": r.get("status", ""),
            # A queued or running job has conclusion=null; reporting that as an
            # empty string would render as a silent pass in the UI.
            "conclusion": r.get("conclusion") or "in_progress",
            "branch": r.get("head_branch", ""),
            "url": r.get("html_url", ""),
        }
        for r in (
            runs_body.get("workflow_runs", []) if isinstance(runs_body, dict) else []
        )[:5]
        if isinstance(r, dict)
    ]

    failing = [r for r in runs if r["conclusion"] in ("failure", "timed_out")]
    ci = "no runs" if not runs else ("failing" if failing else runs[0]["conclusion"])

    return _ok(
        f"{repo}: {len(commits)} recent commit(s), {len(prs)} open PR(s), CI {ci}",
        repo=repo,
        description=meta.get("description") or "",
        stars=meta.get("stargazers_count", 0),
        open_issues=meta.get("open_issues_count", 0),
        default_branch=meta.get("default_branch", ""),
        pushed_at=meta.get("pushed_at", ""),
        private=bool(meta.get("private")),
        commits=commits,
        pull_requests=prs,
        workflow_runs=runs,
        ci_status=ci,
        authenticated=bool(token),
    )


# ═══════════════════════════════════════════════════════════════════════════
# News
# ═══════════════════════════════════════════════════════════════════════════

# Feeds chosen for breadth and because each publishes a real RSS/Atom body rather
# than a teaser. Overridable per call via `feeds`.
_DEFAULT_FEEDS: list[tuple[str, str]] = [
    ("Hacker News", "https://hnrss.org/frontpage"),
    ("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
    ("The Verge", "https://www.theverge.com/rss/index.xml"),
    ("MIT Technology Review", "https://www.technologyreview.com/feed/"),
]


def _local_name(tag: str) -> str:
    """Element name with any XML namespace stripped."""
    return tag.rsplit("}", 1)[-1]


def _feed_name(url: str) -> str:
    m = re.search(r"https?://(?:www\.)?([^/]+)", url)
    return m.group(1) if m else url[:40]


def _parse_feed(xml_text: str, source: str) -> list[dict]:
    """
    Pull headlines from RSS 2.0 or Atom through one code path.

    Namespaces are stripped rather than declared. Feeds in the wild disagree about
    which namespace they use and some declare none at all, so matching on local
    element names is markedly more robust than maintaining a prefix map that
    breaks on the first publisher who does something unusual.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    items: list[dict] = []
    for node in root.iter():
        if _local_name(node.tag) not in ("item", "entry"):
            continue
        title = link = when = ""
        for child in node:
            name = _local_name(child.tag)
            if name == "title" and not title:
                title = (child.text or "").strip()
            elif name == "link" and not link:
                # RSS puts the URL in the text; Atom puts it in @href.
                link = (child.get("href") or child.text or "").strip()
            elif name in ("pubDate", "published", "updated") and not when:
                when = (child.text or "").strip()
        if title:
            items.append(
                {"title": title[:200], "link": link, "date": when, "source": source}
            )
    return items


async def news_digest(payload: dict, ctx: ExecContext) -> dict:
    """
    Compile a headline digest from RSS/Atom feeds.

    Feed-based rather than NewsAPI-based on purpose: no key to leak, no quota to
    exhaust, and no single vendor deciding what counts as news. `topic` filters on
    the headline text after the fetch, so one pass serves any number of queries.
    """
    topic = str(payload.get("topic") or payload.get("query") or "").strip().lower()
    try:
        limit = max(1, min(int(payload.get("limit") or 20), 60))
    except (TypeError, ValueError):
        limit = 20

    feeds = _DEFAULT_FEEDS
    requested = payload.get("feeds")
    if isinstance(requested, list):
        custom = [
            (_feed_name(f), f)
            for f in requested
            if isinstance(f, str) and f.startswith("http")
        ]
        feeds = custom or _DEFAULT_FEEDS

    ctx.note(f"Fetching {len(feeds)} feed(s)")
    async with httpx.AsyncClient(
        timeout=15.0, follow_redirects=True, headers={"User-Agent": "concaretti-light"}
    ) as client:
        responses = await asyncio.gather(
            *(client.get(url) for _, url in feeds), return_exceptions=True
        )

    articles: list[dict] = []
    unreachable: list[str] = []
    for (name, _url), resp in zip(feeds, responses):
        if isinstance(resp, BaseException) or resp.status_code >= 400:
            unreachable.append(name)
            continue
        articles.extend(_parse_feed(resp.text, name))

    if topic:
        terms = [t for t in re.split(r"\s+", topic) if t]
        articles = [a for a in articles if any(t in a["title"].lower() for t in terms)]

    articles = articles[:limit]
    matched = f' matching "{topic}"' if topic else ""
    if not articles:
        tail = f" Unreachable: {', '.join(unreachable)}." if unreachable else ""
        return _fail(f"No headlines found{matched}.{tail}", unreachable=unreachable)

    return _ok(
        f"{len(articles)} headline(s){matched} from "
        f"{len(feeds) - len(unreachable)} feed(s)",
        articles=articles,
        unreachable=unreachable,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Social
# ═══════════════════════════════════════════════════════════════════════════

# Hard ceilings, checked before any network call so an over-long post fails here
# rather than as a remote 422 the user has to interpret.
_POST_LIMITS = {"x": 280, "twitter": 280, "mastodon": 500, "linkedin": 3000}


async def social_post(payload: dict, ctx: ExecContext) -> dict:
    """
    Publish to a social account. Reached only after HALO approval.

    Mastodon is wired end to end because it authenticates with a single bearer
    token. X and LinkedIn require a three-legged OAuth flow that cannot complete
    headlessly, so they record a visible draft and say exactly why — a draft the
    user can see and finish beats a fabricated success.

    Every outcome is persisted, refusals included. A Social panel that dropped
    failed attempts would imply nothing had ever been tried.
    """
    platform = str(payload.get("platform") or "mastodon").strip().lower()
    body = str(
        payload.get("body") or payload.get("text") or payload.get("content") or ""
    ).strip()
    if not body:
        return _fail("`body` is required")

    limit = _POST_LIMITS.get(platform)
    if limit and len(body) > limit:
        return _fail(
            f"{len(body)} characters exceeds the {limit}-character {platform} limit"
        )

    if platform != "mastodon":
        post = ctx.store.add_social_post(
            platform, body, status="draft", session_id=ctx.session_id
        )
        ctx.store.log_audit(
            ctx.session_id,
            "social",
            "social_post",
            decision="deferred",
            reason=f"{platform} requires interactive OAuth",
            payload={"platform": platform},
        )
        return _fail(
            f"{platform} needs interactive OAuth, which cannot complete "
            "headlessly — saved as a draft in the Social panel instead. Mastodon "
            "publishes directly.",
            post=post,
            published=False,
        )

    token = _env("MASTODON_ACCESS_TOKEN")
    host = (_env("MASTODON_BASE_URL") or "https://mastodon.social").rstrip("/")
    if not token:
        post = ctx.store.add_social_post(
            platform, body, status="draft", session_id=ctx.session_id
        )
        return _fail(
            "MASTODON_ACCESS_TOKEN not set — recorded as a draft, NOT published.",
            post=post,
            published=False,
        )

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{host}/api/v1/statuses",
                headers={"Authorization": f"Bearer {token}"},
                json={"status": body},
            )
        resp.raise_for_status()
        remote = resp.json()
    except Exception as exc:
        post = ctx.store.add_social_post(
            platform,
            body,
            status=f"failed: {type(exc).__name__}",
            session_id=ctx.session_id,
        )
        ctx.store.log_audit(
            ctx.session_id,
            "social",
            "social_post",
            decision="failed",
            reason=str(exc)[:300],
            payload={"platform": platform},
        )
        return _fail(
            f"Mastodon post failed: {type(exc).__name__}: {exc}",
            post=post,
            published=False,
        )

    post = ctx.store.add_social_post(
        platform,
        body,
        status="published",
        session_id=ctx.session_id,
        external_id=str(remote.get("id", "")),
    )
    ctx.store.log_audit(
        ctx.session_id,
        "social",
        "social_post",
        decision="executed",
        reason=f"mastodon id {remote.get('id', '')}",
        payload={"platform": platform},
    )
    return _ok(
        f"Published to {platform}", post=post, published=True, url=remote.get("url", "")
    )


# ═══════════════════════════════════════════════════════════════════════════
# Project scaffolding
# ═══════════════════════════════════════════════════════════════════════════


def _project_files(kind: str, name: str, description: str) -> dict[str, str]:
    """Relative path → contents. Keys are forward-slashed and never absolute."""
    readme = f"# {name}\n\n{description or 'Scaffolded by Concaretti.'}\n"
    gitignore = "__pycache__/\n*.py[cod]\n.venv/\nnode_modules/\ndist/\n.env\n"
    module = re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_") or "app"
    pkg = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-") or "app"

    if kind == "python":
        return {
            "README.md": readme,
            ".gitignore": gitignore,
            "pyproject.toml": (
                "[project]\n"
                f'name = "{pkg}"\n'
                'version = "0.1.0"\n'
                f'description = "{description}"\n'
                'requires-python = ">=3.11"\n'
                "dependencies = []\n\n"
                "[tool.uv]\n"
                "package = false\n"
            ),
            f"src/{module}/__init__.py": '__version__ = "0.1.0"\n',
            f"src/{module}/main.py": (
                "def main() -> None:\n"
                f'    print("{name}")\n'
                "\n\n"
                'if __name__ == "__main__":\n'
                "    main()\n"
            ),
        }
    if kind == "node":
        return {
            "README.md": readme,
            ".gitignore": gitignore,
            "package.json": (
                "{\n"
                f'  "name": "{pkg}",\n'
                '  "version": "0.1.0",\n'
                '  "type": "module",\n'
                '  "scripts": {\n    "start": "node src/index.js"\n  }\n'
                "}\n"
            ),
            "src/index.js": f'console.log("{name}")\n',
        }
    if kind == "web":
        return {
            "README.md": readme,
            ".gitignore": gitignore,
            "index.html": (
                "<!doctype html>\n"
                '<html lang="en">\n'
                "  <head>\n"
                '    <meta charset="utf-8" />\n'
                '    <meta name="viewport" content="width=device-width, '
                'initial-scale=1" />\n'
                f"    <title>{name}</title>\n"
                '    <link rel="stylesheet" href="styles.css" />\n'
                "  </head>\n"
                "  <body>\n"
                f"    <h1>{name}</h1>\n"
                '    <script type="module" src="app.js"></script>\n'
                "  </body>\n"
                "</html>\n"
            ),
            "styles.css": (
                ":root {\n  color-scheme: light dark;\n}\n\n"
                "body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n}\n"
            ),
            "app.js": f'console.log("{name}")\n',
        }
    return {"README.md": readme, ".gitignore": gitignore}


async def project_create(payload: dict, ctx: ExecContext) -> dict:
    """
    Scaffold a project directory. Reached only after HALO approval.

    Every leaf path goes through `check_path` individually, not just the target
    directory. A template key containing `..` would otherwise escape a permitted
    root while the directory-level check still passed — a deny-list is only as
    good as the narrowest thing it is asked about.

    All paths are screened before anything is written, so a refusal partway down
    the list cannot leave a half-scaffolded directory behind.
    """
    name = str(payload.get("name") or payload.get("project") or "").strip()
    if not name:
        return _fail("`name` is required")
    slug = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-.") or "project"

    kind = str(payload.get("kind") or payload.get("template") or "python").lower().strip()
    if kind not in ("python", "node", "web", "blank"):
        return _fail(f'Unknown template "{kind}" — use python, node, web or blank')
    description = str(payload.get("description") or "").strip()

    base = str(payload.get("path") or "").strip() or (
        ctx.policy.rules.default_save_path or str(Path.home() / "Desktop")
    )
    root = Path(canonical_path(str(Path(base) / slug)))

    allowed, reason = check_path(ctx.policy, str(root))
    if not allowed:
        ctx.store.log_audit(
            ctx.session_id,
            "file",
            "project_create",
            decision="blocked",
            reason=reason,
            payload={"path": str(root)},
        )
        return _fail(f"Refused by .conca: {reason}")

    if root.exists() and any(root.iterdir()):
        return _fail(f"{root} already exists and is not empty")

    files = _project_files(kind, name, description)

    resolved: list[tuple[Path, str]] = []
    for rel, content in files.items():
        target = Path(canonical_path(str(root / rel)))
        ok, why = check_path(ctx.policy, str(target))
        if not ok:
            ctx.store.log_audit(
                ctx.session_id,
                "file",
                "project_create",
                decision="blocked",
                reason=why,
                payload={"path": str(target)},
            )
            return _fail(f"Refused by .conca: {why}")
        resolved.append((target, content))

    size_ok, size_reason = check_file_size(
        ctx.policy, "".join(c for _, c in resolved)
    )
    if not size_ok:
        return _fail(f"Refused by .conca: {size_reason}")

    written: list[str] = []
    try:
        for target, content in resolved:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            written.append(str(target))
    except Exception as exc:
        return _fail(
            f"scaffold failed after {len(written)} file(s): "
            f"{type(exc).__name__}: {exc}",
            written=written,
        )

    readme = next((t for t, _ in resolved if t.name == "README.md"), None)
    if readme is not None:
        artifact = ctx.store.record_artifact(
            session_id=ctx.session_id,
            filename=f"{slug}-README.md",
            mime="text/markdown",
            path=str(readme),
            content=readme.read_bytes(),
            prompt=ctx.prompt,
        )
        ctx.broker.publish(ctx.session_id, "artifact", asdict(artifact))

    ctx.store.log_audit(
        ctx.session_id,
        "file",
        "project_create",
        decision="executed",
        reason=f"{kind} scaffold, {len(written)} file(s)",
        payload={"path": str(root)},
    )
    return _ok(
        f"Scaffolded {kind} project '{slug}' — {len(written)} file(s) at {root}",
        path=str(root),
        kind=kind,
        files=list(files.keys()),
    )


# ═══════════════════════════════════════════════════════════════════════════
# Browser
# ═══════════════════════════════════════════════════════════════════════════
#
# A real browser, reached over the Chrome DevTools Protocol rather than launched.
#
# `playwright install` downloads ~300MB of Chromium per browser. That is a poor
# trade for an app whose whole premise is staying light, and it is a hostile first
# run for anyone cloning this. So the connection order is:
#
#   1. `BROWSER_WS_ENDPOINT` / `BROWSERLESS_URL` — connect to a browser someone
#      else is already running (a browserless container, or Chrome started with
#      `--remote-debugging-port`). Costs nothing but a websocket.
#   2. A locally-installed Chrome or Edge, via `channel=`. Every Windows machine
#      has Edge; most have Chrome. Playwright can drive them without downloading
#      anything.
#   3. Playwright's own bundled Chromium, if someone did run `playwright install`.
#
# Only when all three fail does the tool report unavailability — and it says which
# of the three to fix, because "browser unavailable" on its own is unactionable.

_BROWSER_TIMEOUT_MS = 20_000


def _cdp_endpoint() -> str:
    """
    The websocket to attach to, if one is configured.

    `BROWSER_WS_ENDPOINT` is the explicit form. `BROWSERLESS_URL` is accepted
    because that is what the original Concaretti's `.env` already sets, and
    rewriting the operator's environment to suit a new variable name is churn for
    its own sake. An `http://` browserless URL is rewritten to `ws://`: the
    container serves CDP on the same port and the http form is what its docs show.
    """
    explicit = _env("BROWSER_WS_ENDPOINT")
    if explicit:
        return explicit
    base = _env("BROWSERLESS_URL")
    if not base:
        return ""
    if base.startswith(("ws://", "wss://")):
        return base
    return base.replace("https://", "wss://", 1).replace("http://", "ws://", 1)


class _BrowserUnavailable(RuntimeError):
    """No browser could be reached by any of the three routes."""


async def _browser_page(pw: Any) -> tuple[Any, Any, str]:
    """
    Return `(browser, page, how)` for a usable browser.

    `how` names the route taken so the tool result can say where the page came
    from — which matters when a screenshot looks wrong and the question is whether
    it came from a container or the local Edge.
    """
    endpoint = _cdp_endpoint()
    attempts: list[str] = []

    if endpoint:
        try:
            browser = await pw.chromium.connect_over_cdp(
                endpoint, timeout=_BROWSER_TIMEOUT_MS
            )
            # An attached browser usually has a context already; reusing it keeps
            # the operator's session (and their cookies) instead of opening a
            # blank incognito window they didn't ask for.
            ctx_ = browser.contexts[0] if browser.contexts else await browser.new_context()
            return browser, await ctx_.new_page(), f"cdp:{endpoint}"
        except Exception as exc:
            attempts.append(f"CDP {endpoint} → {type(exc).__name__}")

    for channel in ("chrome", "msedge"):
        try:
            browser = await pw.chromium.launch(channel=channel, headless=False)
            return browser, await browser.new_page(), f"local:{channel}"
        except Exception as exc:
            attempts.append(f"{channel} → {type(exc).__name__}")

    try:
        browser = await pw.chromium.launch(headless=False)
        return browser, await browser.new_page(), "bundled:chromium"
    except Exception as exc:
        attempts.append(f"bundled → {type(exc).__name__}")

    raise _BrowserUnavailable(
        "No browser reachable. Either set BROWSER_WS_ENDPOINT/BROWSERLESS_URL to a "
        "running Chrome or browserless instance, install Chrome or Edge, or run "
        "`uv run playwright install chromium`. Tried: " + "; ".join(attempts)
    )


async def _with_page(fn: Any) -> Any:
    """
    Run `fn(page)` against a browser, closing everything afterwards.

    Playwright is imported inside the function rather than at module scope so the
    other twenty-odd tools keep working when it isn't installed. Import cost is
    paid once per process by the module cache.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise _BrowserUnavailable(
            "Playwright is not installed. Run `uv sync` in backend/, which now "
            "includes it."
        ) from None

    async with async_playwright() as pw:
        browser, page, how = await _browser_page(pw)
        try:
            page.set_default_timeout(_BROWSER_TIMEOUT_MS)
            return await fn(page, how)
        finally:
            # Only close a browser we launched. Closing an attached browserless
            # container would take down something we don't own — and the next call
            # would find nothing there.
            try:
                if how.startswith("cdp:"):
                    await page.close()
                else:
                    await browser.close()
            except Exception:
                pass  # teardown failures must not mask the result


def _screened_url(ctx: ExecContext, raw: str) -> tuple[str, str]:
    """Normalise and screen a URL, raising PolicyViolation-shaped failure text."""
    url = (raw or "").strip()
    if url and "//" not in url:
        url = f"https://{url}"
    allowed, reason = check_url(ctx.policy, url)
    return (url if allowed else ""), reason


def _collapse(text: str) -> str:
    """
    Squeeze the whitespace out of a rendered-text extract.

    `innerText` on a real page is mostly blank lines: every empty layout div
    contributes one, so a 300-word article arrives as 2000 lines. Left alone that
    is what gets spent on context and shown in a panel. Runs of blank lines
    collapse to one, and trailing spaces on each line go.
    """
    lines = [ln.rstrip() for ln in (text or "").splitlines()]
    out: list[str] = []
    for ln in lines:
        if not ln and out and not out[-1]:
            continue
        out.append(ln)
    return "\n".join(out).strip()


async def browse_page(payload: dict, ctx: ExecContext) -> dict:
    """
    Open a URL in a real browser and return its rendered text.

    The difference from `scrape_url` is JavaScript. `scrape_url` fetches HTML over
    httpx, which is correct and much cheaper for the many sites that ship their
    content in the document — and is why it stays. This one exists for the sites
    that ship an empty `<div id="root">`, where the only way to read the content is
    to be a browser.

    Read-only: navigate, wait for the network to settle, extract. No clicking, no
    typing, no form submission — those are `browser_act`, which is HALO-gated.
    """
    url, reason = _screened_url(ctx, str(payload.get("url") or payload.get("query") or ""))
    if not url:
        ctx.store.log_audit(
            ctx.session_id, "browser", "browse_page", decision="refused", reason=reason
        )
        return _fail(f"Refused by .conca: {reason}")

    ctx.note(f"Opening {url} in a browser")

    async def _run(page: Any, how: str) -> dict:
        # "load" rather than "networkidle": a page with a polling websocket or an
        # analytics heartbeat never goes idle, and waiting for that is a 20-second
        # timeout on a page that was readable in 800ms.
        response = await page.goto(url, wait_until="load")
        title = await page.title()
        # innerText, not textContent: it respects `display:none`, so nav menus and
        # cookie banners that are hidden don't land in the extract as though they
        # were body copy.
        text = await page.evaluate("() => document.body?.innerText ?? ''")
        links = await page.evaluate(
            """() => [...document.querySelectorAll('a[href]')]
                .slice(0, 40)
                .map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
                .filter(l => l.text)"""
        )
        return {
            "status": response.status if response else None,
            "title": title,
            "text": _collapse(text),
            "links": links,
            "how": how,
        }

    try:
        got = await _with_page(_run)
    except _BrowserUnavailable as exc:
        return _fail(str(exc))
    except Exception as exc:
        ctx.store.log_audit(
            ctx.session_id,
            "browser",
            "browse_page",
            decision="failed",
            reason=str(exc)[:300],
            payload={"url": url},
        )
        return _fail(f"Could not load {url}: {type(exc).__name__}: {exc}")

    body = got["text"][:6000]
    ctx.store.log_audit(
        ctx.session_id,
        "browser",
        "browse_page",
        decision="executed",
        reason=f"{got['status']} via {got['how']}",
        payload={"url": url},
    )
    return _ok(
        f"{got['title'] or url} ({got['status']})\n\n{body}",
        url=url,
        title=got["title"],
        status=got["status"],
        text=body,
        links=got["links"],
        transport=got["how"],
    )


async def screenshot_page(payload: dict, ctx: ExecContext) -> dict:
    """
    Photograph a page and return it as a data URL.

    Returned inline rather than written to disk because the consumer is a panel in
    the browser, and a file on the operator's Desktop would need `check_path`, a
    static route to serve it, and a cleanup story. A data URL has none of those and
    disappears when the session does.
    """
    url, reason = _screened_url(ctx, str(payload.get("url") or ""))
    if not url:
        ctx.store.log_audit(
            ctx.session_id, "browser", "screenshot_page", decision="refused", reason=reason
        )
        return _fail(f"Refused by .conca: {reason}")

    full = bool(payload.get("full_page") or payload.get("full"))
    ctx.note(f"Photographing {url}")

    async def _run(page: Any, how: str) -> dict:
        await page.set_viewport_size({"width": 1280, "height": 800})
        response = await page.goto(url, wait_until="load")
        title = await page.title()
        shot = await page.screenshot(type="jpeg", quality=72, full_page=full)
        return {
            "status": response.status if response else None,
            "title": title,
            "b64": base64.b64encode(shot).decode("ascii"),
            "how": how,
        }

    try:
        got = await _with_page(_run)
    except _BrowserUnavailable as exc:
        return _fail(str(exc))
    except Exception as exc:
        return _fail(f"Could not photograph {url}: {type(exc).__name__}: {exc}")

    ctx.store.log_audit(
        ctx.session_id,
        "browser",
        "screenshot_page",
        decision="executed",
        reason=f"{got['status']} via {got['how']}",
        payload={"url": url},
    )
    return _ok(
        f"Captured {got['title'] or url}",
        url=url,
        title=got["title"],
        status=got["status"],
        # JPEG at q72 rather than PNG: a 1280×800 screenshot of a text-heavy page
        # is ~1.5MB as PNG and ~120KB as JPEG, and this travels through JSON as
        # base64 — which inflates it by a third either way.
        image=f"data:image/jpeg;base64,{got['b64']}",
        transport=got["how"],
    )


async def browser_act(payload: dict, ctx: ExecContext) -> dict:
    """
    Click or type in a live page. HALO-gated; reached only after approval.

    This is the tool that made `.conca` disable the browser in the first place, so
    it is deliberately the narrowest thing that is still useful: a list of
    `{action, selector, value}` steps, where `action` is one of three verbs and
    anything else is refused. There is no `evaluate` step and no raw JavaScript
    parameter — an agent that can run arbitrary JS in a logged-in page has every
    capability that page's session has, and no gate downstream of that means
    anything.

    Typed values are redacted on the way out — see `redact_secrets`. A card number
    filled here would otherwise travel into the step list, the result summary, the
    SSE stream, `ctx.accumulated` and the embedding index; the audit row is already
    only a hash, so the return value was the exposed path.
    """
    url, reason = _screened_url(ctx, str(payload.get("url") or ""))
    if not url:
        return _fail(f"Refused by .conca: {reason}")

    steps = payload.get("steps") or []
    if isinstance(steps, dict):
        steps = [steps]
    if not isinstance(steps, list) or not steps:
        return _fail("`steps` must be a non-empty list of {action, selector, value}")
    if len(steps) > 12:
        return _fail(f"{len(steps)} steps is too many for one approval — split it up")

    allowed_actions = {"click", "fill", "press"}
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            return _fail(f"step {i} is not an object")
        action = str(step.get("action", "")).lower()
        if action not in allowed_actions:
            return _fail(
                f'step {i}: action "{action}" is not permitted. '
                f"Allowed: {', '.join(sorted(allowed_actions))}"
            )
        if not str(step.get("selector", "")).strip():
            return _fail(f"step {i}: a selector is required")

    async def _run(page: Any, how: str) -> dict:
        await page.goto(url, wait_until="load")
        done: list[str] = []
        for step in steps:
            action = str(step["action"]).lower()
            selector = str(step["selector"])
            value = str(step.get("value", ""))
            if action == "click":
                await page.click(selector)
            elif action == "fill":
                await page.fill(selector, value)
            else:
                await page.press(selector, value or "Enter")
            # Redact before truncating, not after: a 16-digit run cut to 40
            # characters is still a whole card number.
            done.append(
                f"{action} {selector}"
                + (f" = {redact_secrets(value)[:40]}" if value else "")
            )
        shot = await page.screenshot(type="jpeg", quality=72)
        return {
            "done": done,
            "final_url": page.url,
            "title": await page.title(),
            "b64": base64.b64encode(shot).decode("ascii"),
            "how": how,
        }

    try:
        got = await _with_page(_run)
    except _BrowserUnavailable as exc:
        return _fail(str(exc))
    except Exception as exc:
        ctx.store.log_audit(
            ctx.session_id,
            "browser",
            "browser_act",
            decision="failed",
            reason=str(exc)[:300],
            payload={"url": url},
        )
        return _fail(f"Interaction failed on {url}: {type(exc).__name__}: {exc}")

    ctx.store.log_audit(
        ctx.session_id,
        "browser",
        "browser_act",
        decision="executed",
        reason=f"{len(got['done'])} step(s) via {got['how']}",
        payload={"url": url, "steps": got["done"]},
    )
    return _ok(
        f"Ran {len(got['done'])} step(s) on {got['title'] or url}:\n"
        + "\n".join(f"• {d}" for d in got["done"]),
        url=got["final_url"],
        title=got["title"],
        steps=got["done"],
        image=f"data:image/jpeg;base64,{got['b64']}",
        transport=got["how"],
    )


# ═══════════════════════════════════════════════════════════════════════════
# Money — currencies, budgets, FX
# ═══════════════════════════════════════════════════════════════════════════

_CURRENCY_SYMBOLS: dict[str, str] = {
    "$": "USD", "₦": "NGN", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR",
    "R": "ZAR", "₵": "GHS", "KSh": "KES",
}

# How people actually write currencies in a hurry. "dolls" is in here because the
# errand this was built for says "i have 200 dolls or 400k naira on it" — a parser
# that only accepts ISO codes would read that as a bare number and guess the
# currency, and guessing wrong by a factor of 1500 is the whole ballgame.
_CURRENCY_WORDS: dict[str, str] = {
    "usd": "USD", "dollar": "USD", "dollars": "USD", "doll": "USD", "dolls": "USD",
    "bucks": "USD", "usdollars": "USD",
    "ngn": "NGN", "naira": "NGN", "nairas": "NGN",
    "gbp": "GBP", "pound": "GBP", "pounds": "GBP", "quid": "GBP",
    "eur": "EUR", "euro": "EUR", "euros": "EUR",
    "inr": "INR", "rupee": "INR", "rupees": "INR",
    "jpy": "JPY", "yen": "JPY",
    "zar": "ZAR", "rand": "ZAR",
    "ghs": "GHS", "cedi": "GHS", "cedis": "GHS",
    "kes": "KES", "shilling": "KES", "shillings": "KES",
    "cad": "CAD", "aud": "AUD",
}

_MONEY_RE = re.compile(
    r"(?P<sym>[$₦£€¥₹])?\s*"
    r"(?P<num>\d[\d,\s]*(?:\.\d+)?)\s*"
    r"(?P<mult>[kmKM])?\s*"
    r"(?P<word>[a-zA-Z]{3,10})?"
)

# FX quotes cached for an hour, per base currency. A retail budget does not need
# a live tick, and open.er-api.com asks callers not to poll it.
_FX_CACHE: dict[str, tuple[float, dict[str, float]]] = {}
_FX_TTL = 3600.0


@dataclass
class Money:
    amount: float
    currency: str

    def __str__(self) -> str:  # noqa: D105 - reads better than a helper
        return f"{self.currency} {self.amount:,.2f}"


def parse_money(text: str) -> list[Money]:
    """
    Pull every amount out of a sentence, with its currency.

    Returns a list rather than one value because *"200 dolls or 400k naira"* is one
    budget said twice, and which of the two is authoritative is a decision for
    `budget_ceiling`, not for the parser. Multipliers (`400k`, `1.2m`) are handled
    because that is how the number was written.

    A bare number with no symbol and no word is skipped rather than assumed to be
    dollars. Assuming a currency here is how a ₦400,000 ceiling becomes a $400,000
    one.
    """
    out: list[Money] = []
    for m in _MONEY_RE.finditer(text or ""):
        raw = re.sub(r"[,\s]", "", m.group("num") or "")
        if not raw:
            continue
        try:
            amount = float(raw)
        except ValueError:
            continue

        mult = (m.group("mult") or "").lower()
        word = (m.group("word") or "").lower().strip(".")
        # A trailing "k"/"m" only multiplies when it is a suffix on the number, not
        # the first letter of the next word: "400k naira" scales, "20 kg" does not.
        if mult == "k":
            amount *= 1_000
        elif mult == "m":
            amount *= 1_000_000

        currency = _CURRENCY_SYMBOLS.get(m.group("sym") or "") or _CURRENCY_WORDS.get(word, "")
        if not currency:
            continue
        out.append(Money(amount, currency))
    return out


async def fx_rate(frm: str, to: str) -> float | None:
    """
    One unit of `frm` in `to`, or None if the rate could not be fetched.

    open.er-api.com needs no key, which is the entire reason it is here: a budget
    ceiling that silently stops working when a trial key lapses is worse than one
    that never worked. None on failure rather than 1.0 — a missing rate must make
    the caller refuse, not treat naira as dollars.
    """
    frm, to = frm.upper(), to.upper()
    if frm == to:
        return 1.0

    hit = _FX_CACHE.get(frm)
    if hit and (time.time() - hit[0]) < _FX_TTL:
        rate = hit[1].get(to)
        if rate:
            return rate

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"https://open.er-api.com/v6/latest/{frm}")
        data = resp.json()
        rates = data.get("rates") or {}
        if not isinstance(rates, dict) or not rates:
            return None
        _FX_CACHE[frm] = (time.time(), {k: float(v) for k, v in rates.items()})
        got = rates.get(to)
        return float(got) if got else None
    except Exception:
        return None


async def budget_ceiling(text: Any, prefer: str = "USD") -> tuple[Money | None, str]:
    """
    Resolve a stated budget into a single spendable ceiling.

    When a prompt names two amounts in two currencies, this takes the **smaller**
    one after conversion. That is not arbitrary: the two figures are the same money
    described twice, and if the FX rate the user did the sum with differs from
    today's, one of the two is higher than they actually have. Erring low costs a
    retry; erring high costs money that isn't there.
    """
    if isinstance(text, (int, float)):
        return Money(float(text), prefer.upper()), f"{prefer.upper()} {float(text):,.2f} (as given)"

    found = parse_money(str(text or ""))
    if not found:
        return None, "no budget found in that text"

    converted: list[tuple[float, Money]] = []
    for money in found:
        rate = await fx_rate(money.currency, prefer)
        if rate is None:
            continue
        converted.append((money.amount * rate, money))
    if not converted:
        return None, (
            f"found {', '.join(str(m) for m in found)} but no exchange rate to "
            f"{prefer.upper()} was reachable, so the ceiling cannot be trusted"
        )

    converted.sort(key=lambda pair: pair[0])
    low, original = converted[0]
    note = f"{original} → {prefer.upper()} {low:,.2f}"
    if len(converted) > 1:
        others = ", ".join(str(m) for _, m in converted[1:])
        note += f" (took the lower of {original} / {others})"
    return Money(low, prefer.upper()), note


# ═══════════════════════════════════════════════════════════════════════════
# Shopper
# ═══════════════════════════════════════════════════════════════════════════

_SHOP_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Hosts that are shopping results rather than products. Without this the first
# three "candidates" for any query are a search page, a listicle and a coupon
# aggregator, none of which has a price to compare.
_NOT_A_PRODUCT = (
    "google.", "bing.", "duckduckgo.", "youtube.", "reddit.", "quora.",
    "pinterest.", "facebook.", "instagram.", "tiktok.", "wikipedia.",
    "/search", "/s?k=", "coupon", "deals.", "slickdeals",
)


# ── card jar ───────────────────────────────────────────────────────────────
#
# Card details live here and nowhere else: a module-level dict, in RAM, for at
# most three minutes, readable exactly once.
#
# The reason it is not routed through the HALO gate — the obvious place, since
# that is where the human is already being asked — is that `halo.py:305` sends
# free-text answers to `_resolve_custom`, which sends them to a model through
# `rotator.complete()` and then keeps them on `ApprovalOutcome.custom_text`. A PAN
# entered there would be transmitted to a third-party provider and retained in
# process memory attached to a completed approval. So the gate sees `card ending
# 4242` and the number takes its own path.
#
# Nothing here is persisted, and nothing here passes through `ctx.accumulated` —
# which matters more than it looks, because that string is what becomes a
# `context_entries` row and then an embedding. A card that never enters the
# accumulator cannot be recalled by a later turn, and Rule-0 never has to be
# trusted to catch it.
_CARD_JAR: dict[str, tuple[float, dict[str, str]]] = {}
_CARD_TTL = 180.0
_CARD_FIELDS = ("pan", "exp", "cvc", "name", "postal")


def _sweep_jar(now: float | None = None) -> None:
    now = now or time.time()
    for ref in [r for r, (stamp, _) in _CARD_JAR.items() if now - stamp > _CARD_TTL]:
        _CARD_JAR.pop(ref, None)


def stash_card(ref: str, fields: dict[str, str]) -> dict[str, Any]:
    """
    Accept card details for one checkout and return only what is safe to speak.

    Called by `POST /api/shopper/secret`. The return value is what the rest of the
    system is allowed to know: brand and last four. Every other caller — the HALO
    details string, the audit payload, the SSE feed, the order row — gets this dict
    and never the jar.
    """
    _sweep_jar()
    clean = {k: str(fields.get(k, "")).strip() for k in _CARD_FIELDS}
    digits = re.sub(r"[^0-9]", "", clean["pan"])
    if len(digits) < 13 or len(digits) > 19 or not _luhn_ok(digits):
        raise ValueError("that card number fails its own check digit — mistyped?")
    clean["pan"] = digits
    _CARD_JAR[ref] = (time.time(), clean)
    return {"ref": ref, "last4": digits[-4:], "brand": _card_brand(digits), "ttl_seconds": int(_CARD_TTL)}


def _take_card(ref: str) -> dict[str, str] | None:
    """Pop the card for `ref`. Single use: a second call gets nothing."""
    _sweep_jar()
    entry = _CARD_JAR.pop(ref, None)
    return entry[1] if entry else None


def _card_brand(digits: str) -> str:
    """Brand from the IIN prefix. Cosmetic — it only ever labels a masked number."""
    if digits.startswith("4"):
        return "visa"
    if digits[:2] in {"51", "52", "53", "54", "55"} or 2221 <= int(digits[:4] or 0) <= 2720:
        return "mastercard"
    if digits[:2] in {"34", "37"}:
        return "amex"
    if digits.startswith("6011") or digits[:2] == "65":
        return "discover"
    if digits[:4] in {"5061", "5078", "5079", "5080"} or digits[:6] == "506099":
        return "verve"
    return "card"


# ── product extraction ─────────────────────────────────────────────────────


def _jsonld_blocks(page: str) -> list[Any]:
    """Every `application/ld+json` payload on the page that parses."""
    out: list[Any] = []
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        page,
        re.DOTALL | re.IGNORECASE,
    ):
        try:
            out.append(json.loads(m.group(1).strip()))
        except Exception:
            continue  # one malformed block must not lose the others
    return out


def _walk_for_product(node: Any) -> dict | None:
    """Depth-first search of a JSON-LD tree for the first `Product` node."""
    if isinstance(node, list):
        for item in node:
            got = _walk_for_product(item)
            if got:
                return got
        return None
    if not isinstance(node, dict):
        return None
    kind = node.get("@type")
    kinds = kind if isinstance(kind, list) else [kind]
    if any(str(k).lower() == "product" for k in kinds if k):
        return node
    for value in node.values():
        got = _walk_for_product(value)
        if got:
            return got
    return None


def _extract_product(page: str, url: str) -> dict[str, Any] | None:
    """
    Read title, price, currency, rating and review count off a product page.

    Reads schema.org `Product` markup first, because retail sites publish it for
    Google's shopping surfaces and it is therefore both near-universal and
    *maintained* — unlike the visible price, which moves with every redesign.
    Falls back to Open Graph product meta, then to the first currency-marked number
    in the document.

    Returns None rather than a zero-priced guess when nothing is found. A candidate
    with no price cannot be compared against a budget, and inventing one is how a
    comparison silently recommends the most expensive item.
    """
    title = ""
    price: float | None = None
    currency = ""
    rating: float | None = None
    reviews = 0
    availability = ""

    for block in _jsonld_blocks(page):
        node = _walk_for_product(block)
        if not node:
            continue
        title = str(node.get("name") or "")[:160]
        offers = node.get("offers")
        if isinstance(offers, list):
            offers = offers[0] if offers else None
        if isinstance(offers, dict):
            raw = offers.get("price") or offers.get("lowPrice")
            try:
                price = float(str(raw).replace(",", "")) if raw is not None else None
            except ValueError:
                price = None
            currency = str(offers.get("priceCurrency") or "")[:3].upper()
            availability = str(offers.get("availability") or "").rsplit("/", 1)[-1]
        agg = node.get("aggregateRating")
        if isinstance(agg, dict):
            try:
                rating = float(agg.get("ratingValue"))
            except (TypeError, ValueError):
                rating = None
            try:
                reviews = int(float(agg.get("reviewCount") or agg.get("ratingCount") or 0))
            except (TypeError, ValueError):
                reviews = 0
        if price is not None:
            break

    if price is None:
        meta = re.search(
            r'<meta[^>]+(?:property|name)=["\'](?:og:price:amount|product:price:amount)["\']'
            r'[^>]+content=["\']([\d.,]+)["\']',
            page,
            re.IGNORECASE,
        )
        if meta:
            try:
                price = float(meta.group(1).replace(",", ""))
            except ValueError:
                price = None
        cur = re.search(
            r'<meta[^>]+(?:property|name)=["\'](?:og:price:currency|product:price:currency)["\']'
            r'[^>]+content=["\']([A-Za-z]{3})["\']',
            page,
            re.IGNORECASE,
        )
        if cur:
            currency = cur.group(1).upper()

    if price is None:
        loose = re.search(r"[$₦£€¥₹]\s?(\d[\d,]*(?:\.\d{2})?)", page)
        if loose:
            try:
                price = float(loose.group(1).replace(",", ""))
                currency = currency or _CURRENCY_SYMBOLS.get(loose.group(0)[0], "")
            except ValueError:
                price = None

    if price is None:
        return None

    if not title:
        tag = re.search(r"<title[^>]*>(.*?)</title>", page, re.DOTALL | re.IGNORECASE)
        title = _clean_text(tag.group(1))[:160] if tag else url

    return {
        "title": title,
        "url": url,
        "price": price,
        "currency": currency or "USD",
        "rating": rating,
        "reviews": reviews,
        "availability": availability or "unknown",
        "merchant": urllib.parse.urlsplit(url).netloc.replace("www.", ""),
    }


async def _fetch_product(ctx: ExecContext, url: str) -> dict[str, Any] | None:
    """Screen a candidate URL, fetch it, and extract a product from it."""
    clean, _ = _screened_url(ctx, url)
    if not clean or any(bad in clean.lower() for bad in _NOT_A_PRODUCT):
        return None
    try:
        async with httpx.AsyncClient(
            timeout=20.0, follow_redirects=True, headers=_SHOP_UA
        ) as client:
            resp = await client.get(clean)
        if resp.status_code >= 400:
            return None
        return _extract_product(resp.text, str(resp.url))
    except Exception:
        return None


async def shop_search(payload: dict, ctx: ExecContext) -> dict:
    """
    Find buyable candidates for one item, priced and within a stated budget.

    Search results give URLs; the prices come from fetching each candidate and
    reading its schema.org markup, because a search snippet's price is whatever it
    was when the crawler last passed. Candidates that yield no price are dropped
    rather than carried with a placeholder — see `_extract_product`.

    `budget` is optional here and enforced softly: over-budget candidates are
    returned, flagged `within_budget: False`, because knowing the cheapest thing
    that *would* work is part of shopping. `shop_compare` is where the ceiling
    becomes binding.
    """
    query = str(payload.get("query") or payload.get("item") or payload.get("prompt") or "").strip()
    if not query:
        return _fail("what should I shop for? pass `query`")

    prefer = str(payload.get("currency") or "USD").upper()
    ceiling: Money | None = None
    budget_note = ""
    if payload.get("budget") is not None:
        ceiling, budget_note = await budget_ceiling(payload["budget"], prefer)
        if ceiling is None:
            return _fail(f"could not read the budget: {budget_note}")
        prefer = ceiling.currency

    limit = max(1, min(int(payload.get("limit") or 6), 10))
    ctx.note(f"Shopping for {query}" + (f" under {ceiling}" if ceiling else ""))

    found = await web_search({"query": f"buy {query} price"}, ctx)
    urls = [r.get("url", "") for r in (found.get("results") or []) if r.get("url")]
    for extra in payload.get("urls") or []:
        urls.append(str(extra))
    if not urls:
        return _fail(f"no shopping results for '{query}' — search returned nothing usable")

    # Fetched concurrently: eight sequential retail pages is most of a minute, and
    # they are independent reads.
    fetched = await asyncio.gather(
        *(_fetch_product(ctx, u) for u in urls[: limit * 2]), return_exceptions=True
    )
    products = [p for p in fetched if isinstance(p, dict)]

    for p in products:
        rate = await fx_rate(p["currency"], prefer)
        p["price_in"] = prefer
        p["price_converted"] = round(p["price"] * rate, 2) if rate else None
        p["within_budget"] = (
            None
            if (ceiling is None or p["price_converted"] is None)
            else p["price_converted"] <= ceiling.amount
        )

    products.sort(key=lambda p: (p["price_converted"] is None, p["price_converted"] or 0.0))
    products = products[:limit]
    if not products:
        return _fail(
            f"found {len(urls)} pages for '{query}' but none published a readable price — "
            "try a narrower query or pass `urls` with specific product pages"
        )

    lines = [
        f"• {p['title'][:70]} — {p['currency']} {p['price']:,.2f}"
        + (f" (≈{prefer} {p['price_converted']:,.2f})" if p["price_converted"] and p["currency"] != prefer else "")
        + (f" · {p['reviews']:,} reviews" if p["reviews"] else "")
        + f" · {p['merchant']}"
        for p in products
    ]
    head = f"{len(products)} candidate(s) for '{query}'"
    if budget_note:
        head += f" · budget {budget_note}"
    return _ok(
        redact_secrets(head + ":\n" + "\n".join(lines)),
        query=query,
        candidates=products,
        currency=prefer,
        budget=ceiling.amount if ceiling else None,
        budget_note=budget_note,
    )


def _score(p: dict, ceiling: float | None) -> float:
    """
    "Best affordable" as an actual number.

    Weighted toward headroom rather than toward the top rating, because the errand
    said *affordable*: leaving a third of the budget unspent on a 4.4-star keyboard
    beats spending all of it on a 4.6. Review count is logged, not linear — 12,000
    reviews is not twelve times the evidence of 1,000, and untreated it swamps
    everything else.
    """
    price = p.get("price_converted") or p.get("price") or 0.0
    rating = float(p.get("rating") or 3.8) / 5.0
    reviews = float(p.get("reviews") or 0)
    review_norm = min(1.0, (reviews ** 0.5) / 100.0) if reviews > 0 else 0.15
    headroom = 0.5 if not ceiling or price <= 0 else max(0.0, min(1.0, 1.0 - (price / ceiling)))
    stock = 0.0 if str(p.get("availability", "")).lower() in {"outofstock", "soldout"} else 1.0
    return round((0.34 * rating + 0.26 * review_norm + 0.30 * headroom + 0.10 * stock), 4)


async def shop_compare(payload: dict, ctx: ExecContext) -> dict:
    """
    Choose, under a hard combined ceiling.

    Two shapes. One slot — `candidates` — ranks them and names a pick. Several
    slots — `groups: {"keyboard": [...], "phone stand": [...]}` — picks one from
    each such that the **total** fits the budget, which is the part a per-item
    comparison gets wrong: two individually-affordable things are routinely
    unaffordable together.

    Brute force over the cross product. With ten candidates a slot and the two or
    three slots an errand actually has, that is a few hundred combinations, and an
    exact answer beats a greedy one that spends the budget on the first slot.
    """
    prefer = str(payload.get("currency") or "USD").upper()
    ceiling: Money | None = None
    budget_note = ""
    if payload.get("budget") is not None:
        ceiling, budget_note = await budget_ceiling(payload["budget"], prefer)
        if ceiling is None:
            return _fail(f"could not read the budget: {budget_note}")
        prefer = ceiling.currency

    groups: dict[str, list[dict]] = {}
    raw_groups = payload.get("groups")
    if isinstance(raw_groups, dict) and raw_groups:
        for slot, items in raw_groups.items():
            if isinstance(items, list) and items:
                groups[str(slot)] = [i for i in items if isinstance(i, dict)]
    elif isinstance(payload.get("candidates"), list) and payload["candidates"]:
        groups["item"] = [i for i in payload["candidates"] if isinstance(i, dict)]

    if not groups:
        return _fail("nothing to compare — pass `candidates` or `groups` from shop_search")

    for items in groups.values():
        for p in items:
            if p.get("price_converted") is None:
                rate = await fx_rate(str(p.get("currency") or prefer), prefer)
                p["price_converted"] = (
                    round(float(p.get("price") or 0) * rate, 2) if rate else None
                )
            p["score"] = _score(p, ceiling.amount if ceiling else None)

    # Trim each slot to its best few before the cross product, so a sloppy caller
    # passing 40 candidates per slot cannot turn this into 64,000 combinations.
    slots = list(groups)
    pools = [sorted(groups[s], key=lambda p: -p["score"])[:8] for s in slots]

    best: tuple[float, list[dict]] | None = None
    over: tuple[float, list[dict]] | None = None

    def _combine(index: int, chosen: list[dict], total: float, score: float) -> None:
        nonlocal best, over
        if index == len(pools):
            if ceiling and total > ceiling.amount:
                if over is None or score > over[0]:
                    over = (score, list(chosen))
                return
            if best is None or score > best[0]:
                best = (score, list(chosen))
            return
        for cand in pools[index]:
            price = cand.get("price_converted")
            if price is None:
                continue
            _combine(index + 1, chosen + [cand], total + price, score + cand["score"])

    _combine(0, [], 0.0, 0.0)

    if best is None:
        if over is None:
            return _fail("no candidate had a comparable price — nothing to choose between")
        total = sum(c["price_converted"] for c in over[1])
        picks = [dict(c, slot=s) for s, c in zip(slots, over[1])]
        return _fail(
            redact_secrets(
                f"nothing fits {ceiling}. The cheapest workable set is "
                f"{prefer} {total:,.2f}, over by {prefer} {total - ceiling.amount:,.2f}:\n"
                + "\n".join(f"• {s}: {c['title'][:60]} — {prefer} {c['price_converted']:,.2f}"
                            for s, c in zip(slots, over[1]))
            ),
            picks=picks,
            total=round(total, 2),
            currency=prefer,
            budget=ceiling.amount if ceiling else None,
            within_budget=False,
        )

    picks = [dict(c, slot=s) for s, c in zip(slots, best[1])]
    total = round(sum(c["price_converted"] for c in best[1]), 2)
    left = round(ceiling.amount - total, 2) if ceiling else None

    lines = [
        f"• {p['slot']}: {p['title'][:70]} — {prefer} {p['price_converted']:,.2f}"
        + (f" · {p['rating']}★" if p.get("rating") else "")
        + (f" · {p['reviews']:,} reviews" if p.get("reviews") else "")
        + f"\n  {p['url']}"
        for p in picks
    ]
    summary = f"Picked {len(picks)} item(s) totalling {prefer} {total:,.2f}"
    if ceiling:
        summary += f" of {prefer} {ceiling.amount:,.2f} — {prefer} {left:,.2f} left"
    if budget_note:
        summary += f"\nBudget read as {budget_note}"

    ctx.store.log_audit(
        ctx.session_id,
        "shopper",
        "shop_compare",
        decision="executed",
        reason=f"{len(picks)} pick(s), total {prefer} {total:,.2f}",
        payload={"slots": slots, "urls": [p["url"] for p in picks]},
    )
    return _ok(
        redact_secrets(summary + ":\n" + "\n".join(lines)),
        picks=picks,
        total=total,
        currency=prefer,
        budget=ceiling.amount if ceiling else None,
        remaining=left,
        within_budget=True,
        budget_note=budget_note,
    )


_CART_HINTS = (
    "button[name='submit.add-to-cart']",
    "#add-to-cart-button",
    "button[data-testid*='add-to-cart' i]",
    "button[id*='add-to-cart' i]",
    "button[class*='add-to-cart' i]",
    "button:has-text('Add to cart')",
    "button:has-text('Add to Cart')",
    "button:has-text('Add to basket')",
    "a:has-text('Add to cart')",
)


async def shop_checkout(payload: dict, ctx: ExecContext) -> dict:
    """
    Carry a purchase as far as the policy allows. HALO-gated.

    Three modes, chosen by `.conca`'s `rules.checkout_mode`, and the difference
    between them is who types the card:

    * **handoff** (default) — add to cart, land on the payment page, stop. No card
      exists anywhere in this process. Works with `financial_transactions: false`,
      which is why it is the default: the useful 95% of the errand needs no
      spending authority at all.
    * **autonomous** — fills the card from the jar. Needs
      `financial_transactions: true` *and* `checkout_mode: autonomous`, two
      separate keys in a file a human reads.
    * **wallet** — pays on-chain; builds an unsigned transaction for the user's own
      wallet to sign. Same two keys.

    In autonomous mode **no screenshot is taken at all**. `browser_act` returns one
    on every run, and a screenshot of a filled card field is the same leak as
    printing the number — worse, because it looks like an audit artefact and gets
    kept. The order row and the audit payload carry `last4` and brand only.
    """
    url, reason = _screened_url(ctx, str(payload.get("url") or ""))
    if not url:
        ctx.store.log_audit(
            ctx.session_id, "shopper", "shop_checkout", decision="refused", reason=reason
        )
        return _fail(f"Refused by .conca: {reason}")

    mode = str(payload.get("mode") or ctx.policy.rules.checkout_mode or "handoff").lower()
    if mode not in {"handoff", "autonomous", "wallet"}:
        return _fail(f'unknown checkout mode "{mode}" — handoff, autonomous or wallet')

    if mode != "handoff" and not ctx.policy.security_overrides.financial_transactions:
        ctx.store.log_audit(
            ctx.session_id,
            "shopper",
            "shop_checkout",
            decision="refused",
            reason=f"{mode} needs financial_transactions",
            payload={"url": url, "mode": mode},
        )
        return _fail(
            f'checkout_mode is "{mode}", which spends money, but .conca has '
            "security_overrides.financial_transactions: false. I will not pay for "
            "anything under that setting. Either set it to true — deliberately, it "
            'is the whole brake — or use checkout_mode: "handoff", which fills the '
            "cart and leaves the payment click to you.",
            mode=mode,
            needs="security_overrides.financial_transactions: true",
        )

    item = str(payload.get("item") or payload.get("title") or "item")
    merchant = urllib.parse.urlsplit(url).netloc.replace("www.", "")
    total = float(payload.get("total") or payload.get("price") or 0.0)
    currency = str(payload.get("currency") or "USD").upper()

    if mode == "wallet":
        # Nothing to drive in a browser: the user pays from their own wallet, so
        # the deliverable is the payment request, not a filled form.
        order = ctx.store.add_order(
            session_id=ctx.session_id,
            merchant=merchant,
            item=item,
            url=url,
            total=total,
            currency=currency,
            status="awaiting_payment",
            note="wallet mode — unsigned payment request issued",
        )
        ctx.store.log_audit(
            ctx.session_id,
            "shopper",
            "shop_checkout",
            decision="executed",
            reason="wallet handoff",
            payload={"url": url, "order": order.get("id"), "mode": mode},
        )
        return _ok(
            f"Wallet checkout for {item} at {merchant}: {currency} {total:,.2f}.\n"
            "I have not signed anything — use chain_prepare_tx to build the transfer "
            "and sign it in your own wallet. I never hold a key.",
            order=order,
            mode=mode,
            next_step="chain_prepare_tx",
            paid=False,
        )

    card: dict[str, str] | None = None
    card_public: dict[str, str] = {}
    selectors: dict[str, str] = {}
    if mode == "autonomous":
        ref = str(payload.get("card_ref") or "")
        if not ref:
            return _fail(
                "autonomous checkout needs a `card_ref` from POST /api/shopper/secret. "
                "Card details are not accepted as a tool argument — a tool payload is "
                "hashed into the audit log and echoed into the run summary, and the "
                "secret endpoint exists so the number never travels either path."
            )
        card = _take_card(ref)
        if not card:
            return _fail(
                "that card reference is spent or expired. Details are held for "
                f"{int(_CARD_TTL)}s and readable once — submit them again when you are "
                "ready to approve."
            )
        card_public = {"last4": card["pan"][-4:], "brand": _card_brand(card["pan"])}
        raw_sel = payload.get("selectors")
        selectors = {k: str(v) for k, v in raw_sel.items()} if isinstance(raw_sel, dict) else {}
        if "pan" not in selectors:
            return _fail(
                "autonomous checkout needs `selectors` naming the card fields on this "
                'page, e.g. {"pan": "#cardNumber", "exp": "#expiry", "cvc": "#cvc"}. '
                "Guessing a selector on a payment form is how a card number ends up "
                "typed into a search box."
            )

    add_selectors = [str(s) for s in (payload.get("add_to_cart") or [])] + list(_CART_HINTS)
    cart_url = str(payload.get("cart_url") or "")

    async def _run(page: Any, how: str) -> dict:
        steps: list[str] = []
        await page.goto(url, wait_until="load")

        clicked = False
        for sel in add_selectors:
            try:
                await page.click(sel, timeout=4000)
                steps.append(f"add to cart via {sel}")
                clicked = True
                break
            except Exception:
                continue
        if not clicked:
            steps.append("no add-to-cart control matched — page may already be a cart")

        if cart_url:
            target, why = _screened_url(ctx, cart_url)
            if not target:
                raise RuntimeError(f"cart url refused by .conca: {why}")
            await page.goto(target, wait_until="load")
            steps.append(f"opened cart {target}")

        filled_card = False
        if card and selectors:
            for field in _CARD_FIELDS:
                sel = selectors.get(field)
                if not sel or not card.get(field):
                    continue
                await page.fill(sel, card[field])
                # The field *name* is logged; the value never is.
                steps.append(f"filled {field} field")
                filled_card = True

        return {
            "steps": steps,
            "final_url": page.url,
            "title": await page.title(),
            "how": how,
            "filled_card": filled_card,
        }

    try:
        got = await _with_page(_run)
    except _BrowserUnavailable as exc:
        return _fail(str(exc))
    except Exception as exc:
        ctx.store.log_audit(
            ctx.session_id,
            "shopper",
            "shop_checkout",
            decision="failed",
            reason=str(exc)[:300],
            payload={"url": url, "mode": mode},
        )
        return _fail(f"Checkout stalled at {url}: {type(exc).__name__}: {exc}")
    finally:
        # Belt and braces: the jar entry was already popped, but if anything above
        # raised between the pop and here, drop the local reference immediately
        # rather than letting it live until the frame is collected.
        card = None

    status = "cart" if mode == "handoff" else "awaiting_confirmation"
    order = ctx.store.add_order(
        session_id=ctx.session_id,
        merchant=merchant,
        item=item,
        url=got["final_url"] or url,
        total=total,
        currency=currency,
        status=status,
        note=(
            f"{mode}; card {card_public['brand']} ending {card_public['last4']}"
            if card_public
            else mode
        ),
    )

    ctx.store.log_audit(
        ctx.session_id,
        "shopper",
        "shop_checkout",
        decision="executed",
        reason=f"{mode}: {len(got['steps'])} step(s) via {got['how']}",
        payload={
            "url": got["final_url"],
            "mode": mode,
            "order": order.get("id"),
            "steps": got["steps"],
            # `card_public` only — the audit row is a hash of this dict, and hashing
            # a PAN does not protect it: sixteen digits is 10^16 candidates.
            **({"card": card_public} if card_public else {}),
        },
    )

    if mode == "handoff":
        tail = (
            f"\n\nCart is loaded and I have stopped at the payment step, by design "
            f"(checkout_mode: handoff). Open it and click pay:\n{got['final_url']}"
        )
        paid = False
    else:
        tail = (
            f"\n\nCard {card_public['brand']} ending {card_public['last4']} entered. "
            "No screenshot was taken of this page and the details are already gone "
            "from memory. Confirm the order on screen before leaving."
        )
        paid = got["filled_card"]

    return _ok(
        redact_secrets(
            f"{mode} checkout for {item} at {merchant} "
            f"({currency} {total:,.2f}):\n"
            + "\n".join(f"• {s}" for s in got["steps"])
            + tail
        ),
        order=order,
        mode=mode,
        url=got["final_url"],
        title=got["title"],
        steps=got["steps"],
        paid=paid,
        # Explicitly null, not omitted: a consumer that reads `image` needs to see
        # that suppression was a decision rather than a missing key.
        image=None,
        redacted="card entry" if card_public else None,
        card=card_public or None,
        transport=got["how"],
    )


# Words a shipping page uses, in the order a parcel passes through them. Ordered
# so that a page mentioning several — "delivered" in a FAQ block on a page whose
# real status is "shipped" — resolves to the furthest along, which is the state the
# merchant is claiming.
_ORDER_STATES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("delivered", ("delivered", "was delivered", "handed to resident", "left at")),
    ("shipped", ("shipped", "out for delivery", "in transit", "dispatched", "on its way")),
    ("confirmed", ("order confirmed", "processing", "preparing", "being packed", "confirmed")),
    ("cancelled", ("cancelled", "canceled", "refunded", "order was cancelled")),
)


async def order_track(payload: dict, ctx: ExecContext) -> dict:
    """
    Re-read an order's page and move its status, once or for everything open.

    This is the *"forsee everything till delivery"* half of the errand, and it is
    deliberately not a background thread. `_scheduler_loop` already wakes once a
    minute and dispatches through `orch().run(...)`, so a tracking poll arrives as
    an ordinary prompt and meets the same `.conca` screen and HALO gate a typed one
    does. A thread of its own would be a second execution path with none of that.

    With no arguments it sweeps every open order that has not been read in the last
    half hour — which is what the cron entry calls, and why `open_orders` takes a
    staleness bound rather than returning everything each tick.
    """
    order_id = str(payload.get("order_id") or payload.get("id") or "")
    targets: list[dict[str, Any]]

    if order_id:
        one = ctx.store.get_order(order_id)
        if not one:
            return _fail(f"no order {order_id}")
        targets = [one]
    elif payload.get("url"):
        clean, why = _screened_url(ctx, str(payload["url"]))
        if not clean:
            return _fail(f"Refused by .conca: {why}")
        targets = [{"id": "", "url": clean, "item": "order", "merchant": "", "status": "cart"}]
    else:
        stale = float(payload.get("stale_seconds") or 1800)
        targets = ctx.store.open_orders(stale_before=time.time() - stale)
        if not targets:
            open_now = ctx.store.open_orders()
            return _ok(
                f"{len(open_now)} order(s) open, none due for a re-read yet."
                if open_now
                else "No open orders to watch.",
                orders=open_now,
                checked=0,
            )

    lines: list[str] = []
    changed: list[dict[str, Any]] = []

    for order in targets[:8]:
        target, why = _screened_url(ctx, str(order.get("url") or ""))
        if not target:
            lines.append(f"• {order.get('item', '?')}: no readable url ({why})")
            continue
        try:
            async with httpx.AsyncClient(
                timeout=20.0, follow_redirects=True, headers=_SHOP_UA
            ) as client:
                resp = await client.get(target)
            body = resp.text.lower()
        except Exception as exc:
            lines.append(f"• {order.get('item', '?')}: could not read ({type(exc).__name__})")
            if order.get("id"):
                ctx.store.update_order(order["id"], last_checked=time.time())
            continue

        found = ""
        for state, needles in _ORDER_STATES:
            if any(n in body for n in needles):
                found = state
                break

        tracking = ""
        link = re.search(
            r'href=["\']([^"\']*(?:track|tracking|shipment)[^"\']*)["\']', body
        )
        if link:
            tracking = urllib.parse.urljoin(target, link.group(1))

        was = str(order.get("status") or "")
        now = found or was or "cart"
        if order.get("id"):
            ctx.store.update_order(
                order["id"],
                status=now,
                last_checked=time.time(),
                **({"tracking_url": tracking} if tracking else {}),
            )
        if now != was:
            changed.append({**order, "status": now, "was": was})
            ctx.note(f"{order.get('item', 'Order')} → {now}")
            lines.append(f"• {order.get('item', '?')} at {order.get('merchant', '?')}: {was} → {now}")
        else:
            lines.append(f"• {order.get('item', '?')} at {order.get('merchant', '?')}: still {now}")

    ctx.store.log_audit(
        ctx.session_id,
        "shopper",
        "order_track",
        decision="executed",
        reason=f"{len(targets)} checked, {len(changed)} moved",
        payload={"orders": [o.get("id") for o in targets]},
    )
    return _ok(
        redact_secrets(
            f"Checked {len(targets)} order(s), {len(changed)} changed:\n" + "\n".join(lines)
        ),
        orders=ctx.store.list_orders(20),
        changed=changed,
        checked=len(targets),
    )


# ═══════════════════════════════════════════════════════════════════════════
# Market — quotes, fundamentals, paper trading
# ═══════════════════════════════════════════════════════════════════════════

# Yahoo's chart endpoint needs no key and no crumb, which is why quotes come from
# here rather than from a provider whose free tier expires. Two hosts because
# query1 rate-limits by IP and query2 serves the same data; trying both turns a
# 429 into a retry rather than a failure.
_YF_HOSTS = ("https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com")

# Every market payload carries this. Not decoration: the difference between a
# simulated fill and a real one is the single most consequential thing this agent
# could be unclear about, and a UI cannot infer it from a number.
_PAPER_NOTE = (
    "Simulated. No brokerage is connected and no order reached a venue. "
    "Not financial advice."
)


async def _yf_get(path: str, params: dict[str, Any]) -> dict | None:
    """GET a Yahoo Finance JSON path, trying both hosts. None on failure."""
    for host in _YF_HOSTS:
        try:
            async with httpx.AsyncClient(
                timeout=20.0, follow_redirects=True, headers=_SHOP_UA
            ) as client:
                resp = await client.get(f"{host}{path}", params=params)
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            continue
    return None


async def _yf_quote(symbol: str) -> dict[str, Any] | None:
    """
    One symbol's live-ish price and the day's shape, from the chart endpoint.

    The chart endpoint rather than `v7/finance/quote` because the latter now wants a
    crumb cookie and returns 401 without one; `meta` on a chart response carries
    everything a quote needs and is still open.
    """
    data = await _yf_get(
        f"/v8/finance/chart/{urllib.parse.quote(symbol.upper())}",
        {"range": "5d", "interval": "1d", "includePrePost": "false"},
    )
    try:
        result = (data or {}).get("chart", {}).get("result") or []
        meta = result[0]["meta"]
    except (KeyError, IndexError, TypeError):
        return None

    price = meta.get("regularMarketPrice")
    if price is None:
        return None
    prev = meta.get("chartPreviousClose") or meta.get("previousClose") or price
    change = float(price) - float(prev)

    return {
        "symbol": meta.get("symbol", symbol.upper()),
        "name": meta.get("longName") or meta.get("shortName") or "",
        "price": round(float(price), 4),
        "previous_close": round(float(prev), 4),
        "change": round(change, 4),
        "change_pct": round((change / float(prev) * 100) if prev else 0.0, 2),
        "currency": meta.get("currency", "USD"),
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        "day_high": meta.get("regularMarketDayHigh"),
        "day_low": meta.get("regularMarketDayLow"),
        "year_high": meta.get("fiftyTwoWeekHigh"),
        "year_low": meta.get("fiftyTwoWeekLow"),
        "volume": meta.get("regularMarketVolume"),
        "instrument": meta.get("instrumentType", ""),
        "as_of": meta.get("regularMarketTime"),
    }


def _symbols_from(payload: dict) -> list[str]:
    raw = payload.get("symbols") or payload.get("symbol") or payload.get("ticker") or ""
    if isinstance(raw, str):
        parts = re.split(r"[,\s]+", raw)
    elif isinstance(raw, list):
        parts = [str(p) for p in raw]
    else:
        parts = []
    return [p.upper().strip() for p in parts if p.strip()][:10]


async def quote(payload: dict, ctx: ExecContext) -> dict:
    """
    Live prices for up to ten symbols. Works for equities, ETFs, FX and crypto.

    Yahoo's own suffixes apply and are worth knowing: `BTC-USD` for crypto,
    `EURUSD=X` for FX, `^GSPC` for an index, `DANGCEM.LG` for the Lagos exchange.
    Passed through unchanged rather than rewritten, because a symbol table that
    guesses is a symbol table that eventually prices the wrong instrument.
    """
    symbols = _symbols_from(payload)
    if not symbols:
        return _fail("which symbol? pass `symbol` or `symbols`")

    ctx.note(f"Pricing {', '.join(symbols)}")
    got = await asyncio.gather(*(_yf_quote(s) for s in symbols), return_exceptions=True)
    quotes = [q for q in got if isinstance(q, dict)]
    missing = [s for s, q in zip(symbols, got) if not isinstance(q, dict)]

    if not quotes:
        return _fail(
            f"no price for {', '.join(symbols)} — check the symbol, or the market "
            "data host is unreachable from here"
        )

    lines = [
        f"• {q['symbol']}"
        + (f" ({q['name'][:40]})" if q["name"] else "")
        + f" {q['currency']} {q['price']:,.4f}".rstrip("0").rstrip(".")
        + f"  {q['change']:+,.2f} ({q['change_pct']:+.2f}%)"
        for q in quotes
    ]
    if missing:
        lines.append(f"• not found: {', '.join(missing)}")

    return _ok(
        "\n".join(lines),
        quotes=quotes,
        missing=missing,
        paper=True,
        disclaimer=_PAPER_NOTE,
    )


async def fundamentals(payload: dict, ctx: ExecContext) -> dict:
    """
    What the company is, beyond today's price.

    `quoteSummary` is the good source and is also the one Yahoo has been fencing
    behind a crumb cookie, so this degrades rather than fails: if the summary
    modules come back empty it reports the quote-level facts it *did* get and says
    which part was unavailable. A fundamentals tool that returns nulls styled as
    zeros would be worse than one that admits the gap.
    """
    symbols = _symbols_from(payload)
    if not symbols:
        return _fail("which symbol? pass `symbol`")
    symbol = symbols[0]

    ctx.note(f"Reading fundamentals for {symbol}")
    live, summary = await asyncio.gather(
        _yf_quote(symbol),
        _yf_get(
            f"/v10/finance/quoteSummary/{urllib.parse.quote(symbol)}",
            {
                "modules": "summaryDetail,defaultKeyStatistics,financialData,assetProfile,price"
            },
        ),
        return_exceptions=True,
    )
    live = live if isinstance(live, dict) else None
    summary = summary if isinstance(summary, dict) else None

    if live is None and summary is None:
        return _fail(f"nothing available for {symbol} — unknown symbol, or the host is blocked")

    mods: dict[str, Any] = {}
    try:
        mods = ((summary or {}).get("quoteSummary", {}).get("result") or [{}])[0] or {}
    except (KeyError, IndexError, TypeError):
        mods = {}

    def _val(module: str, key: str) -> Any:
        node = (mods.get(module) or {}).get(key)
        if isinstance(node, dict):
            return node.get("raw", node.get("fmt"))
        return node

    profile = mods.get("assetProfile") or {}
    facts = {
        "symbol": symbol,
        "name": (live or {}).get("name") or _val("price", "longName") or "",
        "price": (live or {}).get("price"),
        "currency": (live or {}).get("currency") or _val("price", "currency") or "USD",
        "market_cap": _val("summaryDetail", "marketCap") or _val("price", "marketCap"),
        "pe_trailing": _val("summaryDetail", "trailingPE"),
        "pe_forward": _val("summaryDetail", "forwardPE"),
        "eps": _val("defaultKeyStatistics", "trailingEps"),
        "dividend_yield": _val("summaryDetail", "dividendYield"),
        "beta": _val("summaryDetail", "beta"),
        "profit_margin": _val("financialData", "profitMargins"),
        "revenue": _val("financialData", "totalRevenue"),
        "debt_to_equity": _val("financialData", "debtToEquity"),
        "recommendation": _val("financialData", "recommendationKey"),
        "target_mean": _val("financialData", "targetMeanPrice"),
        "sector": profile.get("sector") or "",
        "industry": profile.get("industry") or "",
        "employees": profile.get("fullTimeEmployees"),
        "website": profile.get("website") or "",
        "summary": (profile.get("longBusinessSummary") or "")[:900],
        "year_high": (live or {}).get("year_high"),
        "year_low": (live or {}).get("year_low"),
    }

    def _fmt(v: Any) -> str:
        if v is None or v == "":
            return "—"
        if isinstance(v, (int, float)):
            if abs(v) >= 1_000_000_000:
                return f"{v / 1_000_000_000:,.2f}B"
            if abs(v) >= 1_000_000:
                return f"{v / 1_000_000:,.2f}M"
            return f"{v:,.2f}"
        return str(v)

    head = f"{facts['name'] or symbol} ({symbol})"
    if facts["sector"]:
        head += f" · {facts['sector']}"
    body = "\n".join(
        f"  {label}: {_fmt(facts[key])}"
        for label, key in (
            ("Price", "price"),
            ("Market cap", "market_cap"),
            ("P/E (trailing)", "pe_trailing"),
            ("EPS", "eps"),
            ("Profit margin", "profit_margin"),
            ("Revenue", "revenue"),
            ("Analyst target", "target_mean"),
            ("52w range", "year_high"),
        )
    )
    tail = ""
    if not mods:
        tail = (
            "\n\nOnly quote-level data was available — the fundamentals endpoint "
            "refused this request (Yahoo gates it behind a session cookie). Price, "
            "range and currency above are live; the rest is blank rather than guessed."
        )

    return _ok(
        head + "\n" + body + (f"\n\n{facts['summary']}" if facts["summary"] else "") + tail,
        fundamentals=facts,
        partial=not mods,
        paper=True,
        disclaimer=_PAPER_NOTE,
    )


async def paper_trade(payload: dict, ctx: ExecContext) -> dict:
    """
    Fill an order against the live price, in a ledger that owns no money.

    Not HALO-gated, deliberately. A gate on an action that cannot lose anything
    trains the operator to click through gates, and that habit is the thing
    protecting `shop_checkout` and `chain_prepare_tx`. What protects the user here
    instead is that there is no brokerage to connect: `paper: true` rides on every
    payload and the fill is written to `fills`, which is a local SQLite table.

    Priced at the live quote rather than at a price the caller passes, so a plan
    cannot book a profit by naming its own fill price.
    """
    symbols = _symbols_from(payload)
    if not symbols:
        return _fail("which symbol? pass `symbol`")
    symbol = symbols[0]

    side = str(payload.get("side") or payload.get("action") or "buy").lower().strip()
    if side in {"b", "long", "purchase"}:
        side = "buy"
    if side in {"s", "short", "close", "exit"}:
        side = "sell"
    if side not in {"buy", "sell"}:
        return _fail(f'side must be buy or sell, got "{side}"')

    try:
        qty = float(payload.get("qty") or payload.get("quantity") or payload.get("shares") or 0)
    except (TypeError, ValueError):
        return _fail("qty must be a number")
    if qty <= 0:
        return _fail("qty must be greater than zero")

    live = await _yf_quote(symbol)
    if not live:
        return _fail(f"no live price for {symbol}, so there is nothing to fill against")

    try:
        fill = ctx.store.record_fill(
            symbol=symbol,
            side=side,
            qty=qty,
            price=live["price"],
            session_id=ctx.session_id,
            note=str(payload.get("note") or ""),
        )
    except ValueError as exc:
        return _fail(str(exc))

    ctx.store.log_audit(
        ctx.session_id,
        "market",
        "paper_trade",
        decision="executed",
        reason=f"{side} {qty:g} {symbol} @ {live['price']}",
        payload={"symbol": symbol, "side": side, "qty": qty, "paper": True},
    )

    notional = qty * live["price"]
    line = (
        f"Filled (paper): {side} {qty:g} {symbol} @ {live['currency']} "
        f"{live['price']:,.4f} = {live['currency']} {notional:,.2f}"
    )
    if side == "sell":
        line += f"\nRealised: {live['currency']} {fill['realized']:+,.2f}"

    return _ok(
        f"{line}\n{_PAPER_NOTE}",
        fill=fill,
        quote=live,
        positions=ctx.store.list_positions(),
        paper=True,
        disclaimer=_PAPER_NOTE,
    )


async def portfolio(payload: dict, ctx: ExecContext) -> dict:
    """
    Mark the paper book to market.

    The fills are simulated; the arithmetic is not. Every open position is repriced
    against a live quote, so unrealised P&L moves the way it would if the fills had
    been real — which is the only thing that makes a paper portfolio worth keeping.
    """
    positions = ctx.store.list_positions()
    realized = ctx.store.realized_total()
    if not positions:
        fills = ctx.store.list_fills(20)
        return _ok(
            (
                f"No open positions. Realised to date: {realized:+,.2f}.\n{_PAPER_NOTE}"
                if fills
                else f"The paper book is empty — nothing bought yet.\n{_PAPER_NOTE}"
            ),
            positions=[],
            fills=fills,
            realized=round(realized, 2),
            paper=True,
            disclaimer=_PAPER_NOTE,
        )

    quotes = await asyncio.gather(
        *(_yf_quote(p["symbol"]) for p in positions), return_exceptions=True
    )

    rows: list[dict[str, Any]] = []
    cost_total = value_total = 0.0
    stale: list[str] = []
    for pos, q in zip(positions, quotes):
        live = q if isinstance(q, dict) else None
        qty = float(pos["qty"])
        avg = float(pos["avg_cost"])
        cost = qty * avg
        cost_total += cost
        if live:
            value = qty * live["price"]
            value_total += value
            rows.append(
                {
                    **pos,
                    "price": live["price"],
                    "currency": live["currency"],
                    "value": round(value, 2),
                    "cost": round(cost, 2),
                    "unrealized": round(value - cost, 2),
                    "unrealized_pct": round(((value - cost) / cost * 100) if cost else 0.0, 2),
                    "day_change_pct": live["change_pct"],
                }
            )
        else:
            # Held at cost rather than dropped: excluding it would understate the
            # book, and marking it to zero would invent a total loss.
            stale.append(pos["symbol"])
            value_total += cost
            rows.append({**pos, "price": None, "value": round(cost, 2), "cost": round(cost, 2),
                         "unrealized": 0.0, "unrealized_pct": 0.0, "stale": True})

    unrealized = value_total - cost_total
    lines = [
        f"• {r['symbol']}: {float(r['qty']):g} @ {float(r['avg_cost']):,.2f}"
        + (
            f" → {r['price']:,.2f}  {r['unrealized']:+,.2f} ({r['unrealized_pct']:+.2f}%)"
            if r.get("price")
            else "  (no live price — held at cost)"
        )
        for r in rows
    ]
    head = (
        f"Paper book: {len(rows)} position(s), cost {cost_total:,.2f}, "
        f"value {value_total:,.2f}\n"
        f"Unrealised {unrealized:+,.2f} · realised {realized:+,.2f} · "
        f"total {unrealized + realized:+,.2f}"
    )
    if stale:
        head += f"\nNo live price for {', '.join(stale)}"

    return _ok(
        f"{head}\n" + "\n".join(lines) + f"\n{_PAPER_NOTE}",
        positions=rows,
        fills=ctx.store.list_fills(30),
        cost=round(cost_total, 2),
        value=round(value_total, 2),
        unrealized=round(unrealized, 2),
        realized=round(realized, 2),
        total=round(unrealized + realized, 2),
        paper=True,
        disclaimer=_PAPER_NOTE,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Chain — Solana
# ═══════════════════════════════════════════════════════════════════════════
#
# Solana only, by decision. One chain done properly beats two done by analogy:
# the address format, the decimals, the fee model and the transaction shape are
# all different from EVM's, and a chain tool that half-knows a chain is a tool
# that confidently reports the wrong balance.
#
# The public mainnet RPC needs no key, which is what makes this work with nothing
# configured. It is rate-limited, so every call here is a single request and
# nothing polls.

_SOL_RPC = "https://api.mainnet-beta.solana.com"
_LAMPORTS = 1_000_000_000
_SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
_SYSTEM_PROGRAM = "11111111111111111111111111111111"

# Mints worth naming. Not a registry — just the handful whose raw address in a
# balance list would otherwise be unreadable.
_KNOWN_MINTS: dict[str, tuple[str, int]] = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": ("USDC", 6),
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": ("USDT", 6),
    "So11111111111111111111111111111111111111112": ("wSOL", 9),
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": ("BONK", 5),
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": ("JUP", 6),
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": ("mSOL", 9),
}

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58_ALPHABET)}


def _b58decode(text: str) -> bytes:
    """Base58 (Bitcoin alphabet) → bytes. Raises ValueError on a bad character."""
    num = 0
    for ch in text:
        if ch not in _B58_INDEX:
            raise ValueError(f"'{ch}' is not a base58 character")
        num = num * 58 + _B58_INDEX[ch]
    body = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    pad = len(text) - len(text.lstrip("1"))
    return b"\x00" * pad + body


def _b58encode(raw: bytes) -> str:
    num = int.from_bytes(raw, "big")
    out = ""
    while num:
        num, rem = divmod(num, 58)
        out = _B58_ALPHABET[rem] + out
    pad = len(raw) - len(raw.lstrip(b"\x00"))
    return "1" * pad + out


def _valid_sol_address(addr: str) -> bool:
    """A Solana address is a 32-byte ed25519 public key, written in base58."""
    try:
        return len(_b58decode(addr.strip())) == 32
    except ValueError:
        return False


# ── invariant: no keys, ever ───────────────────────────────────────────────

# The matcher itself lives in `memory.contains_secret_material`, one layer down,
# because the prompt has to be screened before it is written and `memory` is what
# writes it. This file keeps the *application* of it to tool arguments.
#
# The patterns used to be duplicated here, anchored with `^…$` on the theory that
# a chain argument is only ever an address, an amount or a mint id. That held for
# a bare `{"address": "<seed>"}` and failed for `{"memo": 'note abandon abandon
# … about'}`, where the phrase is embedded and the anchors never match. The
# shared matcher is windowed, so both shapes are caught by one implementation
# that cannot drift from the one enforcing the same rule upstream.


def _looks_like_secret(text: str) -> str:
    """Name the kind of secret `text` appears to contain, or "" if it looks clean.

    Deliberately checked *before* anything is logged, noted over SSE, or written
    to the audit table. Every other failure in this file records what it refused;
    this one must not, because the record would itself be the leak. A leaked key
    is the one failure in this app with no recovery — there is no rotate, no
    revoke and no support desk — so it fails loud and forgets.
    """
    return contains_secret_material(text)


def _screen_chain_payload(payload: dict) -> str:
    """Scan every string value in a chain tool payload. Returns a reason or ''."""
    for value in payload.values():
        if isinstance(value, str):
            found = _looks_like_secret(value)
            if found:
                return found
        elif isinstance(value, (list, tuple)):
            for item in value:
                if isinstance(item, str):
                    found = _looks_like_secret(item)
                    if found:
                        return found
    return ""


async def _sol_rpc(method: str, params: list[Any]) -> tuple[Any, str]:
    """One JSON-RPC call. Returns (result, error_message)."""
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.post(
                _SOL_RPC,
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                headers={"Content-Type": "application/json"},
            )
        data = resp.json()
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    if isinstance(data, dict) and data.get("error"):
        return None, str(data["error"].get("message") or data["error"])
    return (data or {}).get("result"), ""


async def _sol_price(ids: str = "solana") -> dict[str, float]:
    """USD prices from CoinGecko's keyless endpoint. Empty dict on failure."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": ids, "vs_currencies": "usd"},
            )
        data = resp.json()
        return {k: float(v.get("usd", 0)) for k, v in data.items() if isinstance(v, dict)}
    except Exception:
        return {}


async def wallet_balances(payload: dict, ctx: ExecContext) -> dict:
    """
    SOL and SPL token balances for a public address, valued in USD.

    Read-only and keyless. Takes an address, not a key — see `_looks_like_secret`,
    which refuses and forgets if what arrives looks like the latter.
    """
    leak = _screen_chain_payload(payload)
    if leak:
        # No log_audit call here, and nothing from the payload in the message. The
        # audit row would be a hash of the payload, and a hash of a seed phrase
        # narrows a search that was already feasible.
        return _fail(KEY_REFUSAL.format(what=leak), refused="secret_material")

    address = str(payload.get("address") or payload.get("wallet") or payload.get("owner") or "").strip()
    if not address:
        return _fail("which address? pass `address` — a public Solana address, never a key")
    if not _valid_sol_address(address):
        return _fail(
            f"'{address[:20]}…' is not a valid Solana address (it must decode from "
            "base58 to exactly 32 bytes)"
        )

    ctx.note(f"Reading {address[:6]}…{address[-4:]} on Solana mainnet")

    (lamports, err1), (accounts, err2) = await asyncio.gather(
        _sol_rpc("getBalance", [address]),
        _sol_rpc(
            "getTokenAccountsByOwner",
            [address, {"programId": _SPL_TOKEN_PROGRAM}, {"encoding": "jsonParsed"}],
        ),
    )
    if err1 and err2:
        return _fail(f"Solana RPC unreachable: {err1}")

    sol = 0.0
    if isinstance(lamports, dict):
        sol = float(lamports.get("value") or 0) / _LAMPORTS

    tokens: list[dict[str, Any]] = []
    for entry in ((accounts or {}).get("value") or []):
        try:
            info = entry["account"]["data"]["parsed"]["info"]
            amount = info["tokenAmount"]
            ui = float(amount.get("uiAmount") or 0)
            if ui <= 0:
                continue  # empty token accounts are noise, not holdings
            mint = info["mint"]
            name, _ = _KNOWN_MINTS.get(mint, ("", 0))
            tokens.append(
                {
                    "mint": mint,
                    "symbol": name or f"{mint[:4]}…{mint[-4:]}",
                    "amount": ui,
                    "decimals": amount.get("decimals"),
                    "known": bool(name),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    tokens.sort(key=lambda t: -t["amount"])

    prices = await _sol_price()
    sol_usd = prices.get("solana", 0.0)
    usd = round(sol * sol_usd, 2) if sol_usd else None
    # Stablecoins are counted at par rather than quoted: one request for SOL is
    # within the free tier, one per mint is not.
    for t in tokens:
        if t["symbol"] in {"USDC", "USDT"}:
            t["usd"] = round(t["amount"], 2)
            usd = round((usd or 0) + t["usd"], 2)

    lines = [f"• SOL {sol:,.6f}".rstrip("0").rstrip(".") + (f"  ≈ ${sol * sol_usd:,.2f}" if sol_usd else "")]
    lines += [
        f"• {t['symbol']} {t['amount']:,.6f}".rstrip("0").rstrip(".")
        + (f"  ≈ ${t['usd']:,.2f}" if t.get("usd") else "")
        + ("" if t["known"] else f"  ({t['mint']})")
        for t in tokens[:15]
    ]

    ctx.store.log_audit(
        ctx.session_id,
        "chain",
        "wallet_balances",
        decision="executed",
        reason=f"{len(tokens)} token account(s)",
        payload={"address": address, "chain": "solana"},
    )
    return _ok(
        f"{address[:6]}…{address[-4:]} on Solana"
        + (f" — about ${usd:,.2f} total" if usd else "")
        + ":\n"
        + "\n".join(lines),
        address=address,
        chain="solana",
        sol=round(sol, 9),
        sol_price_usd=sol_usd or None,
        usd_total=usd,
        tokens=tokens,
    )


async def chain_history(payload: dict, ctx: ExecContext) -> dict:
    """
    Recent signed transactions for an address, newest first.

    Signatures and their outcome, not a decoded ledger. Decoding every instruction
    would mean an IDL per program, and the honest useful answer at this level is
    *what happened, when, and did it succeed* — with a link to an explorer for the
    detail.
    """
    leak = _screen_chain_payload(payload)
    if leak:
        return _fail(KEY_REFUSAL.format(what=leak), refused="secret_material")

    address = str(payload.get("address") or payload.get("wallet") or "").strip()
    if not address:
        return _fail("which address? pass `address`")
    if not _valid_sol_address(address):
        return _fail(f"'{address[:20]}…' is not a valid Solana address")

    limit = max(1, min(int(payload.get("limit") or 15), 50))
    ctx.note(f"Reading history for {address[:6]}…{address[-4:]}")

    sigs, err = await _sol_rpc("getSignaturesForAddress", [address, {"limit": limit}])
    if err:
        return _fail(f"Solana RPC error: {err}")
    if not sigs:
        return _ok(
            f"No transactions found for {address[:6]}…{address[-4:]}.",
            address=address,
            chain="solana",
            transactions=[],
        )

    txs = [
        {
            "signature": s.get("signature", ""),
            "slot": s.get("slot"),
            "time": s.get("blockTime"),
            "ok": s.get("err") is None,
            "error": None if s.get("err") is None else str(s.get("err"))[:120],
            "memo": s.get("memo") or "",
            "explorer": f"https://solscan.io/tx/{s.get('signature', '')}",
        }
        for s in sigs
        if isinstance(s, dict)
    ]
    failed = sum(1 for t in txs if not t["ok"])

    def _when(ts: Any) -> str:
        try:
            return datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M")
        except (TypeError, ValueError):
            return "unknown time"

    lines = [
        f"• {_when(t['time'])}  {'ok' if t['ok'] else 'FAILED'}  "
        f"{t['signature'][:8]}…{t['signature'][-6:]}"
        + (f"  “{t['memo'][:40]}”" if t["memo"] else "")
        for t in txs
    ]

    ctx.store.log_audit(
        ctx.session_id,
        "chain",
        "chain_history",
        decision="executed",
        reason=f"{len(txs)} signature(s)",
        payload={"address": address, "chain": "solana"},
    )
    return _ok(
        f"{len(txs)} recent transaction(s) for {address[:6]}…{address[-4:]}"
        + (f", {failed} failed" if failed else "")
        + ":\n"
        + "\n".join(lines),
        address=address,
        chain="solana",
        transactions=txs,
        failed=failed,
    )


def _compact_u16(n: int) -> bytes:
    """Solana's shortvec length prefix."""
    out = bytearray()
    while True:
        if n < 0x80:
            out.append(n)
            return bytes(out)
        out.append((n & 0x7F) | 0x80)
        n >>= 7


def _unsigned_transfer_message(sender: str, recipient: str, lamports: int, blockhash: str) -> str:
    """
    Serialise an unsigned legacy transfer message, base64-encoded.

    Hand-rolled because the alternative is pulling in `solders`, and the encoding
    is small and fully specified: a three-byte header, the account keys in
    signer-then-writable-then-readonly order, the recent blockhash, and one
    SystemProgram instruction whose data is the little-endian pair
    `(2, lamports)`.

    The **transaction** wrapper is included with an all-zero signature slot, which
    is what a wallet's `signTransaction` expects to fill in. No key is involved on
    this side — that is the entire design: this function cannot sign, because
    nothing here knows how.
    """
    keys = [_b58decode(sender), _b58decode(recipient), _b58decode(_SYSTEM_PROGRAM)]

    message = bytearray()
    message += bytes([1, 0, 1])  # 1 signature, 0 readonly-signed, 1 readonly-unsigned
    message += _compact_u16(len(keys))
    for k in keys:
        message += k
    message += _b58decode(blockhash)

    data = (2).to_bytes(4, "little") + int(lamports).to_bytes(8, "little")
    instruction = bytearray()
    instruction.append(2)  # program id index → SystemProgram
    instruction += _compact_u16(2) + bytes([0, 1])  # accounts: from, to
    instruction += _compact_u16(len(data)) + data

    message += _compact_u16(1) + bytes(instruction)

    # One empty 64-byte signature slot, for the wallet to overwrite.
    tx = _compact_u16(1) + bytes(64) + bytes(message)
    return base64.b64encode(tx).decode("ascii")


def _solana_pay_uri(recipient: str, amount: float, memo: str = "") -> str:
    """A `solana:` transfer request, per the Solana Pay spec."""
    params: dict[str, str] = {"amount": f"{amount:g}"}
    if memo:
        params["memo"] = memo
        params["label"] = memo[:40]
    return f"solana:{recipient}?" + urllib.parse.urlencode(params)


async def chain_prepare_tx(payload: dict, ctx: ExecContext) -> dict:
    """
    Build a transfer for the user to sign. HALO-gated. Never signed here.

    Returns three independent representations of the same intent, on purpose:

    * a **Solana Pay URI** — a published standard that Phantom, Solflare and
      Backpack open directly, and the path to use if anything else looks off
    * an **unsigned base64 transaction** for a wallet's `signTransaction`
    * the **plain fields**, so a human can read what they are about to authorise
      without decoding anything

    Three because one of them is hand-serialised (`_unsigned_transfer_message`) and
    a wallet that rejects it must not leave the user stuck. The URI carries no
    encoding risk.

    This tool cannot move funds. It has no key, no signing code and no submit call:
    the transaction leaves here unsigned, and the only thing that can make it real
    is the user's own wallet.
    """
    leak = _screen_chain_payload(payload)
    if leak:
        return _fail(KEY_REFUSAL.format(what=leak), refused="secret_material")

    sender = str(payload.get("from") or payload.get("sender") or payload.get("address") or "").strip()
    recipient = str(payload.get("to") or payload.get("recipient") or "").strip()
    if not recipient:
        return _fail("who is being paid? pass `to` as a public Solana address")
    if not _valid_sol_address(recipient):
        return _fail(f"recipient '{recipient[:20]}…' is not a valid Solana address")
    if sender and not _valid_sol_address(sender):
        return _fail(f"sender '{sender[:20]}…' is not a valid Solana address")

    try:
        amount = float(payload.get("amount") or payload.get("sol") or 0)
    except (TypeError, ValueError):
        return _fail("amount must be a number of SOL")
    if amount <= 0:
        return _fail("amount must be greater than zero")

    lamports = int(round(amount * _LAMPORTS))
    memo = str(payload.get("memo") or payload.get("label") or "")[:100]

    blockhash = ""
    fee_lamports = 5_000  # the standard per-signature fee; one signer here
    if sender:
        got, err = await _sol_rpc("getLatestBlockhash", [{"commitment": "finalized"}])
        if err:
            return _fail(
                f"could not fetch a recent blockhash ({err}), and a transfer without "
                "one expires immediately. The payment link below still works.",
                solana_pay=_solana_pay_uri(recipient, amount, memo),
            )
        try:
            blockhash = got["value"]["blockhash"]
        except (KeyError, TypeError):
            blockhash = ""

    unsigned = ""
    encode_note = ""
    if sender and blockhash:
        try:
            unsigned = _unsigned_transfer_message(sender, recipient, lamports, blockhash)
        except ValueError as exc:
            encode_note = f"could not serialise the transaction ({exc}); use the payment link"

    prices = await _sol_price()
    sol_usd = prices.get("solana", 0.0)
    uri = _solana_pay_uri(recipient, amount, memo)

    ctx.store.log_audit(
        ctx.session_id,
        "chain",
        "chain_prepare_tx",
        decision="executed",
        reason=f"unsigned transfer of {amount} SOL",
        payload={
            "chain": "solana",
            "to": recipient,
            "from": sender or "unspecified",
            "lamports": lamports,
            "signed": False,
        },
    )

    body = [
        "Unsigned Solana transfer — nothing has been sent.",
        f"  Amount:    {amount:g} SOL" + (f"  (≈ ${amount * sol_usd:,.2f})" if sol_usd else ""),
        f"  Lamports:  {lamports:,}",
        f"  To:        {recipient}",
        f"  From:      {sender or '(your wallet decides)'}",
        f"  Fee:       ~{fee_lamports / _LAMPORTS:g} SOL",
    ]
    if memo:
        body.append(f"  Memo:      {memo}")
    body.append("")
    body.append(f"Pay from your wallet: {uri}")
    if unsigned:
        body.append(
            "An unsigned base64 transaction is attached as `unsigned_transaction` if "
            "your wallet prefers signTransaction."
        )
    if encode_note:
        body.append(encode_note)
    body.append(
        "I do not hold a key and cannot sign or submit this. Check the recipient "
        "against a source you trust before approving — a Solana transfer is final."
    )

    return _ok(
        "\n".join(body),
        chain="solana",
        to=recipient,
        sender=sender or None,
        amount_sol=amount,
        lamports=lamports,
        fee_lamports=fee_lamports,
        recent_blockhash=blockhash or None,
        solana_pay=uri,
        unsigned_transaction=unsigned or None,
        signed=False,
        usd_estimate=round(amount * sol_usd, 2) if sol_usd else None,
        explorer=f"https://solscan.io/account/{recipient}",
    )


def _solana_pay_uri(recipient: str, amount: float, memo: str = "") -> str:
    """A `solana:` transfer request, per the Solana Pay spec."""
    params: dict[str, str] = {"amount": f"{amount:g}"}
    if memo:
        params["memo"] = memo
        params["label"] = memo[:40]
    return f"solana:{recipient}?" + urllib.parse.urlencode(params)


# ═══════════════════════════════════════════════════════════════════════════
# Desktop — the overlay's one capability
# ═══════════════════════════════════════════════════════════════════════════

# Screen jar. Pixels arrive out-of-band under a handle, live in RAM, and are read
# exactly once — the same shape as the card jar above, for a related reason rather
# than the same one.
#
# A card is kept out of the prompt because a PAN must never reach a model at all.
# A screenshot *must* reach a model — that is the whole capability — so what the
# handle protects is every other path the bytes would otherwise take. Put base64
# PNG in the prompt and it lands in `ctx.accumulated`, then in a `context_entries`
# row, then in an embedding, then in the SSE replay buffer, and then in somebody's
# recall result three sessions later. One handle in the prompt keeps the pixels on
# exactly one path: in, to the vision adapter, gone.
#
# There is deliberately no policy check in `stash_screen`. Refusing on `off` is
# `screen_capture`'s job at the boundary and the route's job at the edge; a third
# answer to the same question, positioned to run before both, is how a check ends
# up enforced in only one place and asserted in three.
_SCREEN_JAR: dict[str, tuple[float, str, str]] = {}

# Shorter than the card's 180 seconds. A capture is answered by the gate that
# opens moments after the shortcut; a card is typed by hand.
SCREEN_TTL = 120.0

# A 4K PNG screenshot is 2–6 MB, so ~8 MB base64. Generous enough for a
# multi-monitor grab, small enough that a looping overlay cannot make the jar the
# largest object in the process.
_MAX_SCREEN_B64 = 16 * 1024 * 1024

# Handles are matched out of the prompt as a fallback — see `screen_capture`.
_SCREEN_REF = re.compile(r"capture_ref\s+([A-Za-z0-9_-]{8,64})")

_SCREEN_SYSTEM = (
    "You are looking at a screenshot of the operator's own display, captured by "
    "them deliberately. Describe what is actually visible: the application, the "
    "window titles, the text you can read, the state things are in. Do not guess "
    "at anything the pixels do not show. If a password field, a card number, an "
    "API key or someone else's private message is visible, say that it is present "
    "and do not transcribe it."
)


def _sweep_screens(now: float | None = None) -> None:
    now = now or time.time()
    for ref in [r for r, (stamp, _, _) in _SCREEN_JAR.items() if now - stamp > SCREEN_TTL]:
        _SCREEN_JAR.pop(ref, None)


def stash_screen(ref: str, image_b64: str, mime_type: str = "image/png") -> dict[str, Any]:
    """
    Accept one capture and return only what is safe to speak.

    Called by `POST /api/desktop/capture`. The return value is everything the
    prompt, the gate, the audit row and the SSE feed are allowed to know: a handle
    and a byte count. Not the pixels, and deliberately not the dimensions either —
    "3840×2160" tells a reader which monitor was photographed.
    """
    _sweep_screens()
    blob = re.sub(r"^data:[^;]+;base64,", "", image_b64.strip())
    if not blob:
        raise ValueError("no image data")
    if len(blob) > _MAX_SCREEN_B64:
        raise ValueError(
            f"{len(blob) // 1_048_576} MB of base64 image; the ceiling is "
            f"{_MAX_SCREEN_B64 // 1_048_576} MB"
        )
    try:
        raw = base64.b64decode(blob, validate=True)
    except Exception as exc:
        raise ValueError(f"that is not valid base64 ({type(exc).__name__})") from exc
    if not raw:
        raise ValueError("no image data")

    _SCREEN_JAR[ref] = (time.time(), blob, mime_type or "image/png")
    return {"ref": ref, "bytes": len(raw), "ttl_seconds": int(SCREEN_TTL)}


def _take_screen(ref: str) -> tuple[str, str] | None:
    """Pop the capture for `ref`. Single use: a second call gets nothing."""
    _sweep_screens()
    entry = _SCREEN_JAR.pop(ref, None)
    return (entry[1], entry[2]) if entry else None


def screen_mode(policy: ConcaPolicy) -> str:
    """
    `rules.screen_capture`, normalised, with anything unrecognised read as `ask`.

    One function rather than three `.strip().lower()` calls, because the route,
    the tool and `requires_halo` must not be able to disagree about what the file
    says. A typo resolves to `ask`: the unknown value is treated as the middle
    setting, never as `on`.
    """
    mode = str(getattr(policy.rules, "screen_capture", "ask") or "").strip().lower()
    return mode if mode in {"off", "ask", "on"} else "ask"


async def screen_capture(payload: dict, ctx: ExecContext) -> dict:
    """
    Read one screenshot the desktop overlay captured, and answer about it.

    This tool does not take the picture. `capture_screen()` in the Tauri process
    does that, because taking it needs the operating system and the operating
    system is on the far side of the web boundary. What arrives here is the handle
    `POST /api/desktop/capture` put in the jar; what leaves is prose.

    Four properties, in the order they are enforced:

    **`.conca` decides whether this runs at all.** `rules.screen_capture` is read
    here even though the route already read it, per this module's boundary rule:
    the route's check catches a bad request, this one catches a policy reloaded in
    between. `off` refuses and names the key to change.

    **The gate is upstream and fails towards asking.** `screen_capture` is in
    `HALO_TRIGGERS`, so on `ask` the orchestrator suspends before this function is
    entered. Only the exact string `on` lowers that gate; see `requires_halo`.

    **No pixels are persisted, anywhere.** The jar entry is popped, the bytes go
    to the vision adapter, and both references fall out of scope on return. There
    is no `image` key on the result: the overlay that wants to show the operator
    their own screenshot already holds it client-side, and echoing it back would
    put it in the SSE replay buffer.

    **The description is excluded from recall by provenance, not vocabulary.**
    `screen_capture` is in `PROVENANCE_SENSITIVE`, so the context entry this
    produces is written un-embedded. Rule 0's pattern families cannot catch it —
    "the invoice shows £4,000 owed to Ashworth Ltd" is not distress language and
    never will be — so the exclusion is keyed on where the text came from.
    """
    mode = screen_mode(ctx.policy)
    if mode == "off":
        ctx.store.log_audit(
            ctx.session_id,
            "desktop",
            "screen_capture",
            decision="refused",
            reason="rules.screen_capture is off",
        )
        return _fail(
            "Refused by .conca: `rules.screen_capture` is `off`, so the screen is "
            "not read. Set it to `ask` in backend/.conca to allow captures with an "
            "approval each time, or `on` to allow them without one."
        )

    # The payload key first, because that is what the planner is asked for. The
    # prompt is a fallback rather than the primary source: a plan that drops the
    # key would otherwise leave the operator holding a hotkey that captured their
    # screen and answered nothing. Matching a handle out of prose is safe — it is
    # meaningless without the jar, single-use, and gone in two minutes.
    ref = str(payload.get("capture_ref") or payload.get("ref") or "").strip()
    if not ref:
        hay = f"{payload.get('prompt') or ''} {payload.get('query') or ''} {ctx.prompt}"
        found = _SCREEN_REF.search(hay)
        ref = found.group(1) if found else ""
    if not ref:
        return _fail(
            "no `capture_ref` in this step. Screenshots are not accepted as a tool "
            "argument — they arrive at POST /api/desktop/capture and this tool is "
            "handed the receipt, so that the pixels never enter a prompt, a "
            "transcript or an embedding."
        )

    got = _take_screen(ref)
    if not got:
        return _fail(
            f"that capture is spent or expired. Frames are held for {int(SCREEN_TTL)}s "
            "and readable once, so press the shortcut again."
        )
    image_b64, mime = got

    question = str(payload.get("question") or payload.get("query") or "").strip()
    ctx.note("Reading the captured screen" + (f" — {question[:60]}" if question else ""))

    ask = (
        f"{_SCREEN_SYSTEM}\n\nThe operator asks: {question}"
        if question
        else f"{_SCREEN_SYSTEM}\n\nDescribe what is on this screen."
    )
    try:
        result = await get_rotator().complete_vision(ask, image_b64, mime_type=mime)
    except Exception as exc:
        return _fail(f"Could not read the screen: {type(exc).__name__}: {exc}")

    # Byte count and mode only. The audit log keeps a hash of whatever it is given,
    # which is enough to prove a capture happened and which frame it was, without
    # the description of somebody's screen becoming the permanent record.
    ctx.store.log_audit(
        ctx.session_id,
        "desktop",
        "screen_capture",
        decision="executed" if not result.stubbed else "error",
        reason=f"{mode} mode, {len(image_b64)} b64 chars, via {result.model_id}",
        payload={"mode": mode, "b64_chars": len(image_b64), "ref": ref},
    )

    if result.stubbed:
        # `complete_vision` has no stub planner behind it on purpose: invented prose
        # about the operator's display is worse than an admission, so this is a
        # failure with the reason attached rather than an answer.
        return _fail(result.text.strip(), stubbed=True, persisted=False)

    return _ok(
        result.text.strip(),
        model=result.model_id,
        provider=result.provider,
        tier=result.tier,
        mode=mode,
        # Stated as a field, not only in a docstring, so the panel can show it and
        # the invariant test can assert on it.
        persisted=False,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Registry
# ═══════════════════════════════════════════════════════════════════════════

# (agent, task_type) → implementation. The orchestrator only dispatches pairs
# present here; anything else is reported as unsupported rather than guessed at.
TOOL_REGISTRY: dict[tuple[str, str], Any] = {
    ("research", "web_search"): web_search,
    ("research", "scrape_url"): scrape_url,
    ("research", "arxiv_search"): arxiv_search,
    ("email", "list_emails"): list_emails,
    ("email", "get_email"): get_email,
    ("email", "draft_reply"): draft_reply,
    ("email", "send_email"): send_email,
    ("calendar", "create_event"): create_event,
    ("calendar", "list_events"): list_events,
    ("calendar", "check_availability"): check_availability,
    ("calendar", "find_meeting_time"): find_meeting_time,
    ("calendar", "delete_event"): delete_event,
    ("calendar", "fetch_today_tomorrow"): fetch_today_tomorrow,
    ("sms", "send_sms"): send_sms,
    ("sms", "make_call"): make_call,
    ("sms", "list_messages"): list_messages,
    ("sms", "draft_reply_sms"): draft_reply_sms,
    ("browser", "browse_page"): browse_page,
    ("browser", "screenshot_page"): screenshot_page,
    ("browser", "browser_act"): browser_act,
    ("file", "read_file"): read_file,
    ("file", "write_file"): write_file,
    ("file", "list_dir"): list_dir,
    ("file", "python_execute"): run_python,
    ("file", "os_execute"): os_execute,
    ("file", "media_state"): media_state,
    ("desktop", "mouse_move"): mouse_move,
    ("desktop", "mouse_click"): mouse_click,
    ("desktop", "mouse_drag"): mouse_drag,
    ("desktop", "keyboard_type"): keyboard_type,
    ("desktop", "mouse_scroll"): mouse_scroll,
    ("desktop", "vision_act"): vision_act,
    ("desktop", "open_onscreen_keyboard"): open_onscreen_keyboard,
    ("desktop", "keyboard_hotkey"): keyboard_hotkey,
    ("desktop", "launch_app"): launch_app,
    ("desktop", "detect_input_state"): detect_os_input_state,
    ("file", "project_create"): project_create,
    ("scheduler", "set_reminder"): set_reminder,
    ("scheduler", "list_scheduled"): list_scheduled,
    ("therapy", "reflect"): reflect,
    ("github", "github_summary"): github_summary,
    ("news", "news_digest"): news_digest,
    ("social", "social_post"): social_post,
    ("shopper", "shop_search"): shop_search,
    ("shopper", "shop_compare"): shop_compare,
    ("shopper", "shop_checkout"): shop_checkout,
    ("shopper", "order_track"): order_track,
    ("market", "quote"): quote,
    ("market", "fundamentals"): fundamentals,
    ("market", "paper_trade"): paper_trade,
    ("market", "portfolio"): portfolio,
    ("chain", "wallet_balances"): wallet_balances,
    ("chain", "chain_history"): chain_history,
    ("chain", "chain_prepare_tx"): chain_prepare_tx,
    # `desktop` rather than `browser`, and it owns exactly one task.
    #
    # Folding this into `browser` would have been one fewer line and one real
    # escalation: `browser` is granted to `student` as well as `staff`, so a
    # student-scoped caller would inherit the ability to read the operator's whole
    # display. The two capabilities also sound alike and are not — `screenshot_page`
    # photographs a URL the policy screened first, while this photographs whatever
    # happened to be in front of the person at the moment a hotkey fired.
    ("desktop", "screen_capture"): screen_capture,
}

# Advertised to the planner so it proposes task types that actually exist.
AGENT_CAPABILITIES: dict[str, list[str]] = {}
for _agent, _task in TOOL_REGISTRY:
    AGENT_CAPABILITIES.setdefault(_agent, []).append(_task)


AGENT_ALIASES: dict[str, str] = {
    "file_code": "file",
    "filecode": "file",
    "gmail": "email",
    "telecom": "sms",
    "search": "research",
    "shopping": "shopper",
    "shop": "shopper",
    "commerce": "shopper",
    "errand": "shopper",
    "stocks": "market",
    "stock": "market",
    "trading": "market",
    "finance": "market",
    "blockchain": "chain",
    "crypto": "chain",
    "solana": "chain",
    "wallet": "chain",
    "web3": "chain",
    "overlay": "desktop",
    "screen": "desktop",
    "system": "desktop",
}

# Task-type synonyms, per agent.
#
# This exists because of the fallback below. "Use the agent's first capability"
# is a good recovery for a near-miss task type, but `sms`'s first capability is
# `send_sms` — so a plan that said `call` used to be silently *texted* instead of
# dialled. That is the exact bug the previous Concaretti shipped: its SMS
# processor never switched on the job name, so every queued call went out as a
# message. Naming the synonyms means a mistyped voice task reaches voice.
TASK_ALIASES: dict[str, dict[str, str]] = {
    "sms": {
        "call": "make_call",
        "voice_call": "make_call",
        "phone_call": "make_call",
        "place_call": "make_call",
        "dial": "make_call",
        "ring": "make_call",
        "send_message": "send_sms",
        "text": "send_sms",
        "send_text": "send_sms",
    },
    "browser": {
        "browse": "browse_page",
        "open_url": "browse_page",
        "visit": "browse_page",
        "navigate": "browse_page",
        "read_page": "browse_page",
        "screenshot": "screenshot_page",
        "capture": "screenshot_page",
    },
    # The first-capability fallback lands on a read for all three of these agents
    # — `shop_search`, `quote`, `wallet_balances` — which is the safe direction for
    # it to fail. These synonyms exist for the other direction: a plan that says
    # `purchase` means to buy, and quietly searching instead would leave the errand
    # unfinished while reporting success. Reaching `shop_checkout` is safe because
    # it is HALO-gated — the gate is the protection, not the spelling.
    "shopper": {
        "search": "shop_search",
        "find": "shop_search",
        "find_product": "shop_search",
        "compare": "shop_compare",
        "choose": "shop_compare",
        "pick": "shop_compare",
        "buy": "shop_checkout",
        "purchase": "shop_checkout",
        "checkout": "shop_checkout",
        "order": "shop_checkout",
        "pay": "shop_checkout",
        "add_to_cart": "shop_checkout",
        "track": "order_track",
        "track_order": "order_track",
        "delivery_status": "order_track",
        "follow_up": "order_track",
    },
    "market": {
        "price": "quote",
        "get_quote": "quote",
        "stock_price": "quote",
        "check_price": "quote",
        "research": "fundamentals",
        "analyse": "fundamentals",
        "analyze": "fundamentals",
        "company": "fundamentals",
        "trade": "paper_trade",
        "buy": "paper_trade",
        "sell": "paper_trade",
        "positions": "portfolio",
        "holdings": "portfolio",
        "pnl": "portfolio",
    },
    "chain": {
        "balance": "wallet_balances",
        "balances": "wallet_balances",
        "check_wallet": "wallet_balances",
        "portfolio": "wallet_balances",
        "history": "chain_history",
        "transactions": "chain_history",
        "txs": "chain_history",
        "send": "chain_prepare_tx",
        "transfer": "chain_prepare_tx",
        "prepare_tx": "chain_prepare_tx",
        "pay": "chain_prepare_tx",
    },
    # Named even though `desktop` has one capability and the first-capability
    # fallback would land on it anyway. The fallback is safe here *today*; it stops
    # being safe the moment a second desktop tool is added, and at that point the
    # names below are what keeps "look at my screen" pointed at the screen.
    "desktop": {
        "screenshot": "screen_capture",
        "screen_shot": "screen_capture",
        "capture": "screen_capture",
        "capture_screen": "screen_capture",
        "read_screen": "screen_capture",
        "describe_screen": "screen_capture",
        "look": "screen_capture",
        "see": "screen_capture",
        "keyboard": "open_onscreen_keyboard",
        "onscreen_keyboard": "open_onscreen_keyboard",
        "osk": "open_onscreen_keyboard",
        "type": "keyboard_type",
        "typing": "keyboard_type",
        "write": "keyboard_type",
        "keystroke": "keyboard_type",
        "move": "mouse_move",
        "cursor": "mouse_move",
        "click": "mouse_click",
        "drag": "mouse_drag",
        "hotkey": "keyboard_hotkey",
        "shortcut": "keyboard_hotkey",
        "launch": "launch_app",
        "open": "launch_app",
    },
}


def resolve_tool(agent: str, task_type: str):
    """Look up a tool, tolerating agent-name and task-type aliases."""
    key = (agent.replace("-", "_").lower(), task_type.lower())
    if key in TOOL_REGISTRY:
        return TOOL_REGISTRY[key]

    canonical_agent = AGENT_ALIASES.get(key[0], key[0])
    if (canonical_agent, key[1]) in TOOL_REGISTRY:
        return TOOL_REGISTRY[(canonical_agent, key[1])]

    # A named synonym beats the first-capability fallback, because the fallback
    # can silently substitute a different action for the one asked for.
    synonym = TASK_ALIASES.get(canonical_agent, {}).get(key[1])
    if synonym and (canonical_agent, synonym) in TOOL_REGISTRY:
        return TOOL_REGISTRY[(canonical_agent, synonym)]

    # Fall back to the agent's first capability so a plausible plan with a
    # slightly-wrong task type still does something useful.
    caps = AGENT_CAPABILITIES.get(canonical_agent)
    if caps:
        return TOOL_REGISTRY[(canonical_agent, caps[0])]
    return None
