// The overlay window and the shortcut that raises it.
//
// "heyclicky but better" — the better part being what the overlay carries that a
// floating prompt box does not: the plan, the agent that owns each step, and the
// HALO gate, so an irreversible action can be approved or refused without
// opening the app.
//
// The window is created by `tauri.conf.json` with `visible: false`, not here.
// Two reasons: a declared window is inspectable in the config the same way an
// agent is inspectable in `.conca`, and building it at runtime would put its
// properties — always-on-top, undecorated, transparent — in a place a reader has
// to run the program to discover.
//
// VERIFIED: compiles clean under `cargo check`. Not yet run interactively, so
// whether Ctrl+Shift+Space is free on this machine is still unknown — a hotkey
// another application already owns fails at `register`, which is why the error
// below is passed through rather than flattened.

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Ctrl+Shift+Space. Chosen because it collides with very little and because it
/// is awkward enough to press that it will not fire in a pocket.
pub fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

/// Show the overlay if hidden, hide it if shown.
///
/// A missing window is not an error worth crashing over — the main window is the
/// product and the overlay is an accelerator, so a failure here logs and returns.
pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window("overlay") else {
        eprintln!("[overlay] window 'overlay' not found in tauri.conf.json");
        return;
    };

    let visible = window.is_visible().unwrap_or(false);
    let result = if visible {
        window.hide()
    } else {
        // Focus after show, so the operator can type immediately rather than
        // clicking an always-on-top window that has appeared without focus.
        window.show().and_then(|()| window.set_focus())
    };

    if let Err(err) = result {
        eprintln!("[overlay] could not toggle: {err}");
    }
}

/// Register the global shortcut. Called once from `setup`.
///
/// The error type is boxed rather than `tauri::Result`: the shortcut plugin has
/// its own error enum and there is no `From<shortcut::Error> for tauri::Error`,
/// so `?` cannot bridge them. `setup` accepts any boxed error, which is the
/// smaller change and keeps the plugin's own message intact — "hotkey already
/// registered by another application" is the failure an operator will actually
/// hit, and flattening it into a generic Tauri error would lose that.
pub fn register(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let combo = shortcut();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_shortcut(combo)?
            .with_handler(move |handle, pressed, event| {
                // Pressed only. Without this the overlay toggles twice per
                // keypress — once down, once up — and appears not to work.
                if pressed == &combo && event.state() == ShortcutState::Pressed {
                    toggle(handle);
                }
            })
            .build(),
    )?;
    Ok(())
}
