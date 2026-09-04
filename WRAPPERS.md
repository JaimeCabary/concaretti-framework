# Desktop and mobile wrappers

**Status: written, not built.** Neither wrapper has been compiled — Tauri needs a
Rust toolchain and Capacitor needs Android Studio, and the web app is the
priority. Treat these as scaffolding that is ready to try, not as a verified
build. The web PWA is the demo; these are the same bundle in a native window.

Both wrappers load `frontend/dist`. There is no separate mobile build.

---

## The one thing that breaks both

Served by FastAPI, the app is same-origin and every request is relative
(`/api/...`). A wrapper loads the bundle from `tauri://localhost` or
`https://localhost`, where a relative `/api` resolves against that custom scheme
and never reaches the backend.

So a wrapper build needs the backend's real address baked in:

```bash
cd frontend
VITE_API_BASE=http://127.0.0.1:8000 pnpm build
```

`src/lib/api.ts` reads `VITE_API_BASE` and prefixes every request and the SSE URL
with it. Leave it unset for the web build so same-origin stays relative.

The backend already allows the wrapper origins (`tauri://localhost`,
`capacitor://localhost`, `https://localhost`) with `allow_credentials=True`, in
`backend/main.py`. The role cookie will not survive a cross-origin request
without that, and the cookie is what carries authorisation.

---

## Desktop (Tauri)

```bash
cd desktop
pnpm install
pnpm dev             # expects the backend already running on :8000
```

In dev, Tauri loads `http://localhost:5173`, which is same-origin-proxied by
Vite, so `VITE_API_BASE` is not needed. It is only needed for `pnpm build`.

**Before `pnpm build`** you need icons, which aren't in the repo:

```bash
pnpm icons           # needs frontend/public/icon.png — only icon.svg exists today
```

Rasterise `icon.svg` to a 1024×1024 PNG first, or point `tauri icon` at any
square PNG.

The shell exposes **no Tauri commands** and grants the webview only
`core:default` (see `src-tauri/capabilities/default.json`). That is deliberate:
every capability goes over HTTP to the backend, so the desktop build is subject
to the same `.conca` enforcement and HALO gating as the browser. A native
filesystem command here would be a second path to disk that the policy engine
never sees — which would quietly falsify the central claim.

The backend is **not** spawned as a sidecar. Doing that correctly needs working
directory logic that differs between `tauri dev` and a bundled app, and it was
not worth shipping untested; run `uvicorn` yourself, as in the web demo.

## Mobile (Capacitor)

```bash
cd mobile
pnpm install
pnpm exec cap add android
pnpm sync            # copies frontend/dist into the Android project
pnpm android
```

Re-run `pnpm sync` after every frontend rebuild — `cap` copies, it doesn't
symlink.

`mobile/.npmrc` sets `node-linker=hoisted`. Capacitor's CLI discovers native
platforms by walking a flat `node_modules`, which pnpm's symlinked store does not
provide — without it `cap sync` reports no Android platform even though
`@capacitor/android` is installed. The setting is scoped to `mobile/` only; the
frontend keeps pnpm's default isolated layout.

**`127.0.0.1` is the phone, not your machine.** This is the mistake that costs an
hour. Set `VITE_API_BASE` to an address the device can actually reach:

| Target                           | `VITE_API_BASE`             |
| -------------------------------- | ----------------------------- |
| Android emulator                 | `http://10.0.2.2:8000`      |
| Physical device on the same wifi | `http://<your-lan-ip>:8000` |

And bind uvicorn beyond loopback so it accepts those connections:

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

`allowMixedContent: true` in `capacitor.config.ts` exists only because the dev
backend is plain HTTP on the LAN while the webview origin is `https://localhost`.
A real deployment would terminate TLS and turn it back off.

Native plugins (push notifications, filesystem) are **not** installed. They were
first on the cut list and nothing depends on them.
