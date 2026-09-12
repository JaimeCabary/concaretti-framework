import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Overlay } from "./components/Overlay";

// Self-hosted, so the app renders in Anton offline and inside the Tauri and
// Capacitor wrappers — a `next/font/google` style runtime fetch would leave the
// display face missing exactly where this ships. Imported before `index.css` so
// the @font-face rules are in place when the cascade names them.
//
// Anton is single-weight by design: it has only 400, and `.type-display` asks
// for 400 precisely so the browser never synthesises a bolder one.
import "@fontsource/anton/400.css";
import "@fontsource-variable/dm-sans";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";

import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

/**
 * Two windows, one bundle, one entry point.
 *
 * `tauri.conf.json` points the overlay window at `index.html#overlay`, so the
 * hash is the only thing that distinguishes it. Read once at boot and not
 * watched: a window does not change what it is, and reacting to `hashchange`
 * would make the app shell reachable by typing a URL in the overlay — a second
 * way in for no gain.
 *
 * A hash rather than a second HTML file because the two windows share the store,
 * the API client and the HALO gate. Two entries would mean two bundles of the
 * same code, and the overlay would be the copy that quietly falls behind.
 */
const hash = window.location.hash.replace(/^#\/?/, "");
const isOverlay = hash === "overlay";
const isHud = hash === "hud";

// Transparent, undecorated window: the cream field belongs to the main window,
// and painting it here would draw an opaque rectangle over the desktop the
// overlay is supposed to float above. The card inside `Overlay` is the chrome.
if (isOverlay || isHud) document.documentElement.classList.add("overlay-window");

import { ThoughtHUD } from "./components/ThoughtHUD";

createRoot(root).render(
  <StrictMode>
    {isOverlay ? <Overlay /> : isHud ? <ThoughtHUD /> : <App />}
  </StrictMode>,
);

// Registered only in a production build: the dev server serves modules the
// worker would cache stale, and debugging that costs more than offline dev is
// worth. `public/sw.js` is plain JS and classic-scoped — see its header for why
// it isn't a bundled entry.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
