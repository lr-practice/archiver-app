// system.rs
// Archiver am ganzen Mac, auch wenn das Hauptfenster zu ist:
//
//   Palette (V3)  Ein Kürzel (Standard ⌥ Space) blendet über jedem Programm eine
//                 schwebende Palette ein: Active Zones als Karten, Suche, Objekte
//                 zum Herausziehen. Sie aktiviert Archiver nicht, das Programm
//                 darunter bleibt vorne. Beim Herausziehen wird sie fast
//                 unsichtbar und lässt Klicks durch.
//   Zonenleiste (V1)  Zieht man irgendwo am Mac Dateien (Finder, Schreibtisch,
//                 Mail …), fahren unten die Active Zones ein. Loslassen auf einer
//                 Zone sichert die Dateien dort.
//
// Beide Fenster sind NSPanel ohne Aktivierung (wie Spotlight), schweben über
// allen Spaces und Vollbild-Programmen.
//
// Ereignisse:
//   "palette-open"    an die Palette: wurde eingeblendet
//   "dropbar-show"    an die Leiste: Ziehen hat begonnen
//   "dropbar-release" an die Leiste: Maustaste losgelassen

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const PALETTE: &str = "palette";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const DROPBAR: &str = "dropbar";
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";

/// Zonenleiste beim Ziehen eingeschaltet
static DROPBAR_ON: AtomicBool = AtomicBool::new(true);
/// Gerade wird aus der Palette gezogen: keine Leiste, Palette nicht schließen
static PALETTE_DRAG: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemPrefs {
    /// Kürzel für die Palette, leer = aus
    pub shortcut: String,
    /// Zonenleiste beim Ziehen am ganzen Mac
    pub dropbar: bool,
}

impl Default for SystemPrefs {
    fn default() -> Self {
        SystemPrefs { shortcut: DEFAULT_SHORTCUT.into(), dropbar: true }
    }
}

/// Plugin für das systemweite Kürzel: jedes Drücken schaltet die Palette um.
pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::{Builder, ShortcutState};
    Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_palette(app);
            }
        })
        .build()
}

/// Beim Start: Fenster anlegen (unsichtbar), Kürzel anmelden, Ziehen beobachten.
pub fn setup(app: &AppHandle, prefs: &SystemPrefs) {
    #[cfg(target_os = "macos")]
    {
        create_windows(app);
        let _ = apply(app, prefs);
        watch_drags(app.clone());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, prefs);
}

/// Neue Einstellungen übernehmen: Kürzel neu anmelden, Leiste an oder aus.
/// Fehler, wenn ein anderes Programm das Kürzel schon belegt.
pub fn apply(app: &AppHandle, prefs: &SystemPrefs) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    DROPBAR_ON.store(prefs.dropbar, Ordering::Relaxed);
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if prefs.shortcut.is_empty() {
        return Ok(());
    }
    gs.register(prefs.shortcut.as_str()).map_err(|_| "shortcut-taken".to_string())
}

#[cfg(target_os = "macos")]
fn create_windows(app: &AppHandle) {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    let palette = WebviewWindowBuilder::new(app, PALETTE, WebviewUrl::App("palette.html".into()))
        .title("Archiver")
        .inner_size(860.0, 620.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(false)
        .theme(Some(tauri::Theme::Dark))
        .effects(EffectsBuilder::new().effect(Effect::HudWindow).state(EffectState::Active).radius(12.0).build())
        .build();
    if let Ok(win) = palette {
        if let Ok(ns) = win.ns_window() {
            unsafe { crate::macos::make_panel(ns.cast(), 3) };
        }
    }
    let bar = WebviewWindowBuilder::new(app, DROPBAR, WebviewUrl::App("dropbar.html".into()))
        .title("Archiver")
        .inner_size(1200.0, 280.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(false)
        .theme(Some(tauri::Theme::Dark))
        .build();
    if let Ok(win) = bar {
        if let Ok(ns) = win.ns_window() {
            // NSStatusWindowLevel: über Paletten und Docks anderer Programme
            unsafe { crate::macos::make_panel(ns.cast(), 25) };
        }
    }
}

/// Kürzel gedrückt: Palette auf dem Bildschirm mit dem Zeiger einblenden oder ausblenden.
pub fn toggle_palette(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let Some(win) = app.get_webview_window(PALETTE) else { return };
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Ok(ns) = win.ns_window() else { return };
            let ns = ns.cast();
            unsafe {
                if crate::macos::panel_visible(ns) {
                    crate::macos::panel_hide(ns);
                } else {
                    crate::macos::panel_center_on_mouse_screen(ns);
                    crate::macos::panel_show(ns, true);
                    let _ = app2.emit_to(PALETTE, "palette-open", ());
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn hide_palette(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window(PALETTE) {
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                unsafe { crate::macos::panel_hide(ns.cast()) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Palette verliert den Fokus (Klick in ein anderes Programm): ausblenden,
/// außer es wird gerade aus ihr gezogen.
pub fn palette_blurred(app: &AppHandle) {
    if !PALETTE_DRAG.load(Ordering::Relaxed) {
        hide_palette(app);
    }
}

#[tauri::command]
pub fn palette_hide(app: AppHandle) {
    hide_palette(&app);
}

/// Ziehen aus der Palette beginnt bzw. endet: Palette fast unsichtbar und
/// durchklickbar, damit das Ziel darunter frei liegt.
#[tauri::command]
pub fn palette_ghost(app: AppHandle, on: bool) {
    PALETTE_DRAG.store(on, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window(PALETTE) {
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                unsafe { crate::macos::panel_ghost(ns.cast(), on) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Beobachtet das Ziehen am ganzen Mac. Kein Ereignis-Hook (der bräuchte die
/// Bedienungshilfen-Freigabe), sondern ein Blick alle 50 ms: Maustaste gedrückt
/// und die Drag-Zwischenablage hat sich seit dem Drücken geändert → es wird
/// gezogen. Nur Dateien zählen, und nicht, wenn Archiver selbst vorne ist
/// (dort hat das Hauptfenster seine eigene Leiste).
#[cfg(target_os = "macos")]
fn watch_drags(app: AppHandle) {
    use std::time::{Duration, Instant};
    std::thread::spawn(move || {
        let mut base: Option<isize> = None;
        let mut showing = false;
        let mut released: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_millis(50));
            let (pressed, count) = crate::macos::drag_probe();
            if !pressed {
                base = Some(count);
                if showing {
                    let at = *released.get_or_insert_with(|| {
                        let _ = app.emit_to(DROPBAR, "dropbar-release", ());
                        Instant::now()
                    });
                    // kurz stehen lassen: der Drop und seine Bestätigung brauchen einen Moment
                    if at.elapsed() > Duration::from_millis(900) {
                        showing = false;
                        released = None;
                        set_dropbar(&app, false);
                    }
                }
                continue;
            }
            released = None;
            let Some(b) = base else {
                base = Some(count);
                continue;
            };
            if showing || count == b {
                continue;
            }
            // dieses Ziehen ist entschieden, egal ob die Leiste kommt
            base = Some(count);
            if !DROPBAR_ON.load(Ordering::Relaxed) || PALETTE_DRAG.load(Ordering::Relaxed) {
                continue;
            }
            if crate::macos::app_active() || !crate::macos::drag_has_files() {
                continue;
            }
            showing = true;
            set_dropbar(&app, true);
        }
    });
}

#[cfg(target_os = "macos")]
fn set_dropbar(app: &AppHandle, show: bool) {
    let Some(win) = app.get_webview_window(DROPBAR) else { return };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(ns) = win.ns_window() else { return };
        let ns = ns.cast();
        unsafe {
            if show {
                crate::macos::panel_bottom_of_mouse_screen(ns, 280.0);
                crate::macos::panel_show(ns, false);
                let _ = app2.emit_to(DROPBAR, "dropbar-show", ());
            } else {
                crate::macos::panel_hide(ns);
            }
        }
    });
}
