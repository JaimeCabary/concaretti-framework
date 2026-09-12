// sidecar.rs — spawn and manage the concaretti-backend sidecar process.
//
// The sidecar is a PyInstaller-compiled binary placed in
// src-tauri/binaries/concaretti-backend-<target-triple>.exe.
// Tauri resolves the target triple automatically; we just use the logical name
// "concaretti-backend".
//
// HEALTH POLL: We wait up to 30 s for the backend to answer
// GET http://127.0.0.1:8000/api/health before returning, so the main window
// does not open before the API is ready.
//
// LIFECYCLE: The CommandChild is stored in a Mutex inside AppState. On app
// exit (on_window_event) the child is killed so no orphan process is left
// behind when the user closes the window.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

/// Application-level state that persists for the lifetime of the process.
pub struct AppState {
    /// Handle to the running backend child process; None until spawned.
    pub backend: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

/// Spawn the backend sidecar and block until it is healthy (max 30 s).
///
/// Returns Ok(()) when the backend answers /api/health with 200.
/// Returns Err(String) when the timeout elapses without a healthy response.
pub fn spawn_and_wait(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    // If another instance already started the backend (e.g. dev mode with the
    // server already running), skip spawning and just wait for health.
    if is_healthy() {
        println!("[sidecar] backend already running on :8000 — skipping spawn");
        return Ok(());
    }

    println!("[sidecar] spawning concaretti-backend ...");

    let shell = app.shell();
    let (mut _rx, child) = shell
        .sidecar("concaretti-backend")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    *state.backend.lock().unwrap() = Some(child);

    // Poll /api/health until the backend answers or we give up.
    for attempt in 1..=100 {
        std::thread::sleep(Duration::from_millis(300));
        if is_healthy() {
            println!("[sidecar] backend healthy after {} ms", attempt * 300);
            return Ok(());
        }
    }

    Err("backend did not become healthy within 30 s".to_string())
}

/// Kill the backend child process if one is stored in AppState.
pub fn kill(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(child) = state.backend.lock().unwrap().take() {
        // kill() is best-effort; ignore the result.
        let _ = child.kill();
        println!("[sidecar] backend process terminated");
    }
}

/// Return true if the backend is answering on port 8000.
fn is_healthy() -> bool {
    // Use a blocking HTTP request in a blocking context (called from a
    // non-async thread during startup).
    match ureq::get("http://127.0.0.1:8000/api/health")
        .timeout(Duration::from_millis(500))
        .call()
    {
        Ok(resp) => resp.status() == 200,
        Err(_) => false,
    }
}
