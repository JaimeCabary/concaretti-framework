"""
diag_blank.py — why does the window render an empty cream page?

The Tauri shell paints #FFFBF0 and shows no UI, which means index.css loaded and
React mounted nothing. The WebView has no visible console, so this drives the
same dev-server URL with Playwright and prints what the browser would have told
us: console output, uncaught errors, failed requests, and whether #root ended up
with any children.

    python -u diag_blank.py
"""

from __future__ import annotations

import asyncio

from playwright.async_api import async_playwright

URL = "http://localhost:5173"


async def go() -> None:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome")
        page = await browser.new_page()

        console: list[str] = []
        errors: list[str] = []
        failed: list[str] = []

        page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("requestfailed",
                lambda r: failed.append(f"{r.method} {r.url} :: "
                                        f"{r.failure or 'unknown'}"))

        await page.goto(URL, wait_until="networkidle", timeout=45000)
        await page.wait_for_timeout(3000)

        root_html = await page.evaluate(
            "() => { const r = document.getElementById('root');"
            " return r ? r.innerHTML.length : -1; }"
        )
        body_text = (await page.evaluate(
            "() => document.body.innerText")) or ""

        print("=" * 70)
        print("PAGE ERRORS", f"({len(errors)})")
        print("=" * 70)
        for e in errors:
            print("!!", e)

        print()
        print("=" * 70)
        print("CONSOLE", f"({len(console)})")
        print("=" * 70)
        for c in console[:40]:
            print("  ", c[:400])

        print()
        print("=" * 70)
        print("FAILED REQUESTS", f"({len(failed)})")
        print("=" * 70)
        for f in failed[:25]:
            print("  ", f[:300])

        print()
        print("=" * 70)
        print("DOM")
        print("=" * 70)
        print("#root innerHTML length:", root_html)
        print("body innerText        :", repr(body_text[:400]))
        print("title                 :", await page.title())

        await browser.close()


asyncio.run(go())
