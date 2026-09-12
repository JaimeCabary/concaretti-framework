// Desktop shell for Concaretti-Light.
//
// This was the smallest Tauri app that can exist: a window on the frontend
// bundle, no commands, every capability reached over HTTP against the backend so
// that the desktop build is subject to exactly the same `.conca` enforcement and
// HALO gating as the browser build. The original argument for keeping it that way
// was that "a native command surface here would be a second path to the
// filesystem that the policy engine never sees."
//
// One command now exists (capture_screen), and one background process is now
// managed (the backend sidecar). The sidecar is a PyInstaller-compiled binary
// of the FastAPI backend bundled inside the installer — users do not need
// Python or uv installed. It is spawned on app start, health-polled until ready,
// and killed when the last window closes.
//
// VERIFIED: `cargo check` passes clean on x86_64-pc-windows-msvc.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod overlay;
mod sidecar;

use sidecar::AppState;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            backend: Mutex::new(None),
        })
        .setup(|app| {
            // Register the global overlay shortcut.
            overlay::register(app.handle())?;

            // Spawn the backend sidecar and wait until it is healthy.
            // This runs synchronously in setup so the window is not created
            // before the API is reachable.
            //
            // In `tauri dev` mode the backend is expected to be running
            // separately (started by the developer), so spawn_and_wait will
            // see it already healthy and skip the spawn step.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = sidecar::spawn_and_wait(&handle) {
                    eprintln!("[sidecar] startup failed: {e}");
                    // Show the main window anyway — the frontend will display
                    // its own offline banner when /api/health is unreachable.
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![capture::capture_screen])
        .build(tauri::generate_context!())
        .expect("error while building Concaretti")
        .run(|app, event| {
            // Kill the backend when the last window closes.
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { .. },
                ..
            } = &event
            {
                // Only act on the main window, not the overlay.
                if label == "main" {
                    sidecar::kill(app);
                }
            }
        });
}
