// Desktop shell for Concaretti-Light.
//
// This was the smallest Tauri app that can exist: a window on the frontend
// bundle, no commands, every capability reached over HTTP against the backend so
// that the desktop build is subject to exactly the same `.conca` enforcement and
// HALO gating as the browser build. The original argument for keeping it that way
// was that "a native command surface here would be a second path to the
// filesystem that the policy engine never sees."
//
// One command now exists, and that argument is the reason for its shape.
// `capture_screen` takes no arguments, names no path, and returns bytes rather
// than a filename. So it adds a way to *read the display* — a capability the
// backend screens — and does not add a way to reach the filesystem, which would
// be a capability the backend cannot see. Everything decided about the captured
// frame is decided server-side: whether policy permits capture at all, whether a
// HALO gate opens first, which model reads it, and whether the resulting
// description may enter the vector index.
//
// VERIFIED: `cargo check` passes clean on x86_64-pc-windows-msvc against
// tauri 2.11.5, xcap 0.4.1, image 0.25.10, base64 0.22.1 and
// tauri-plugin-global-shortcut 2.3.2. Two things had to be fixed to get there,
// both worth knowing: `icons/` was empty, so `tauri-build` failed before it ever
// reached the Rust, and `register` could not return `tauri::Result` because the
// shortcut plugin's error type has no `From` impl into `tauri::Error`.
//
// The web and mobile builds still do not depend on any of this. If it ever stops
// compiling, delete `capture.rs`, `overlay.rs`, the `overlay` window in
// `tauri.conf.json` and the four lines below, and the app is what it was.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod overlay;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            overlay::register(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![capture::capture_screen])
        .run(tauri::generate_context!())
        .expect("error while running Concaretti");
}
