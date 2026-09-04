// One capability, deliberately shaped so it cannot become two.
//
// `main.rs` argues that a native command surface would be "a second path to the
// filesystem that the policy engine never sees." That argument is still correct,
// and it is the reason this command takes **no arguments**. It cannot be told
// which monitor, which region, or which file — so there is no string here for a
// prompt injection to steer, and no path for `.conca` to have to screen.
//
// What it returns is base64 PNG bytes to the webview, which posts them to the
// backend, which is where every decision about them is made: whether the policy
// permits capture at all, whether a HALO gate must open first, which model reads
// the frame, and whether the resulting description may enter the vector index.
// The pixels are never written to disk at any point in that path.
//
// VERIFIED: compiles clean against xcap 0.4.1. The two load-bearing calls,
// `Monitor::all()` and `Monitor::capture_image()`, both typecheck as written, so
// the pinned major was right. Not yet run, so what a capture actually *looks*
// like on this hardware is unconfirmed — but a wrong API would have failed here,
// and did not.

use base64::Engine;
use std::io::Cursor;

/// Photograph the primary display and return it as base64 PNG.
///
/// Takes no arguments. Touches no path. Returns bytes, not a filename.
#[tauri::command]
pub fn capture_screen() -> Result<String, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("no displays enumerable: {e}"))?;

    // The primary monitor, or the first one if none reports as primary. A
    // multi-monitor operator gets the main display rather than a stitched
    // composite of all of them: a wider frame is more of someone's screen than
    // they meant to share, and the capability is already the most invasive one
    // in the system.
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| "no display found".to_string())?;

    let image = monitor
        .capture_image()
        .map_err(|e| format!("capture failed: {e}"))?;

    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("png encode failed: {e}"))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(png.into_inner()))
}
