"""
The operator tier — standing context a human edits by hand.

Three of Concaretti's four memory tiers live in SQLite and none of them is
reviewable by inspection. The durable tables are readable but voluminous, the
compressed transcript is machine-written, and the vector index is 768 floats a
row. So there is no answer to "what does this agent believe about me, and can I
change it" that does not involve a query.

This tier is the answer. One markdown file, loaded on every dispatch, edited in
a text editor by the person the agent works for. It is after Carrigan's Hikari,
whose memory tier is a single always-on markdown file — the design point being
that a plain file is auditable in a way an embedding never is.

Two properties worth stating because they are the reason to have a fourth tier
rather than another table:

  * It is re-read when its mtime changes, so an edit takes effect on the next
    prompt without restarting the process. The operator does not have to know
    the process exists.
  * It is never embedded and never becomes a `context_entries` row, so nothing
    here can come back as a recall result. It is context, not history — which
    also means Rule 0 does not apply to it, because Rule 0 governs what enters
    the index and this never does.

The file is sent verbatim to whichever provider the ladder selects. That is the
whole point of it and it is also its one sharp edge, so `OPERATOR.md` says so in
its own header rather than relying on this docstring being read.

The name matters. This file was briefly called `CONCA.md`, one character from
`.conca`, and the two are opposites: `.conca` is authority, machine-read and
never transmitted; `OPERATOR.md` is preference, human-written and transmitted on
every prompt. Confusing them in the safe direction is noise. Confusing them in
the unsafe one — pasting a credential into the file that gets sent rather than
the file that stays — cannot be taken back, because the secret has already left
the machine by the time anyone notices. Naming the tier after who writes it puts
that distinction in the filename.
"""

from __future__ import annotations

from pathlib import Path

DEFAULT_NOTES_PATH = Path(__file__).parent / "OPERATOR.md"

# Enough for a page of standing preferences, short enough that it cannot crowd
# out the transcript and the recall block on a small context window. A file over
# the cap is truncated rather than refused: silently dropping the operator's
# standing instructions because they got long would be the worse failure.
MAX_NOTES_CHARS = 6_000

_cache: tuple[float, int, str] | None = None


def load_operator_notes(path: Path | str | None = None) -> str:
    """
    The operator's standing notes, or an empty string if there are none.

    Cached against (mtime, size) so the common case is a stat rather than a
    read, while an edit still lands on the next dispatch. A missing file is
    normal and not an error — this tier is optional, and a fresh install has no
    notes until somebody writes some.
    """
    global _cache
    target = Path(path) if path else DEFAULT_NOTES_PATH
    try:
        stat = target.stat()
    except OSError:
        _cache = None
        return ""

    key = (stat.st_mtime, stat.st_size)
    if _cache is not None and _cache[:2] == key:
        return _cache[2]

    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""

    # Strip the header comment block, which is instructions to the human and
    # noise to the model.
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("<!--")]
    body = "\n".join(lines).strip()

    if len(body) > MAX_NOTES_CHARS:
        body = body[:MAX_NOTES_CHARS].rstrip() + "\n\n[notes truncated]"

    _cache = (stat.st_mtime, stat.st_size, body)
    return body


def notes_status(path: Path | str | None = None) -> dict[str, object]:
    """Shape for `/api/conca/status`: whether the tier is present and how big."""
    target = Path(path) if path else DEFAULT_NOTES_PATH
    body = load_operator_notes(target)
    return {
        "path": str(target),
        "present": bool(body),
        "chars": len(body),
        "truncated": body.endswith("[notes truncated]"),
        "max_chars": MAX_NOTES_CHARS,
    }
