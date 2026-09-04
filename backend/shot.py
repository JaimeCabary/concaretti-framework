"""Screenshot the dev server at a desktop size, for eyeballing the theme.

System Chrome via `channel="chrome"` — no bundled browser is installed in this
environment. 1440x900 rather than the default 1280x720 because the rail plus a
three-column body needs the width the real window has.

    PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -u shot.py
"""

from playwright.sync_api import sync_playwright

SHOTS = [
    ("council", None),
    ("calendar", "Calendar"),
    ("rules", ".conca Rules"),
]

with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto("http://localhost:5173", wait_until="networkidle")
    # Onboarding is a first-run modal over the whole shell; dismiss it the same
    # way the app does so the screenshots show the app and not the intro.
    pg.evaluate("localStorage.setItem('conca_onboarded_v1','1')")
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(1200)

    for name, tab in SHOTS:
        if tab:
            pg.get_by_role("tab", name=tab, exact=True).click()
            pg.wait_for_timeout(700)
        pg.screenshot(path=f"../{name}.png")
        print("wrote", name)

    style = pg.evaluate(
        """() => {
      const p = document.querySelector('.panel')
      const b = document.querySelector('.btn')
      const h = document.querySelector('.type-display')
      const c = getComputedStyle
      return {
        panel: p ? [c(p).borderTopWidth, c(p).borderTopColor, c(p).boxShadow, c(p).borderRadius] : null,
        btn: b ? [c(b).borderRadius, c(b).boxShadow] : null,
        font: h ? [c(h).fontFamily, c(h).fontWeight] : null,
      }
    }"""
    )
    for k, v in style.items():
        print(k, "=", v)

    b.close()
