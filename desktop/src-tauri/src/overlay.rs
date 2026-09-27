// The overlay window and the shortcut that raises it.
//
// "heyclicky but better" — the better part being what the overlay carries that a
// floating prompt box does not: the plan, the agent that owns each step, and the
// HALO gate, so an irreversible action can be approved or refused without
// opening the app.

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Primary shortcut: Ctrl+Shift+Space
pub fn primary_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

/// Fallback shortcut: Ctrl+Alt+Space (uncontested on Windows)
pub fn fallback_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

/// Show the overlay if hidden, hide it if shown.
pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window("overlay") else {
        eprintln!("[overlay] window 'overlay' not found in tauri.conf.json");
        return;
    };

    let visible = window.is_visible().unwrap_or(false);
    let result = if visible {
        window.hide()
    } else {
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.center();
        window.show().and_then(|()| window.set_focus())
    };

    if let Err(err) = result {
        eprintln!("[overlay] could not toggle: {err}");
    }
}

/// Command callable by the frontend to toggle the overlay window.
#[tauri::command]
pub fn toggle_overlay(app: tauri::AppHandle) {
    toggle(&app);
}

/// Register the global shortcuts. Called once from `setup`.
pub fn register(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let primary = primary_shortcut();
    let fallback = fallback_shortcut();

    let builder = match tauri_plugin_global_shortcut::Builder::new().with_shortcut(primary) {
        Ok(b) => {
            eprintln!("[overlay] registered primary hotkey Ctrl+Shift+Space");
            b
        }
        Err(err) => {
            eprintln!("[overlay] could not register Ctrl+Shift+Space: {err}; trying fallback");
            match tauri_plugin_global_shortcut::Builder::new().with_shortcut(fallback) {
                Ok(b) => {
                    eprintln!("[overlay] registered fallback hotkey Ctrl+Alt+Space");
                    b
                }
                Err(err2) => {
                    eprintln!("[overlay] could not register fallback Ctrl+Alt+Space: {err2}");
                    tauri_plugin_global_shortcut::Builder::new()
                }
            }
        }
    };

    app.plugin(
        builder
            .with_handler(move |handle, _pressed, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle(handle);
                }
            })
            .build(),
    )?;

    Ok(())
}

