// system.rs
// Archiver am ganzen Mac, auch wenn das Hauptfenster zu ist:
//
//   Palette (V3)  Ein Kürzel (Standard ⌥ Space) blendet über jedem Programm eine
//                 schwebende Palette ein: Active Zones als Karten, Suche, Objekte
//                 zum Herausziehen. Sie aktiviert Archiver nicht, das Programm
//                 darunter bleibt vorne. Beim Herausziehen wird sie fast
//                 unsichtbar und lässt Klicks durch.
//   Zonenleiste (V1)  Zieht man irgendwo am Mac Dateien (Finder, Schreibtisch,
//                 Mail …) und hält dabei ⌥, fahren unten die Active Zones ein
//                 (0.40.21). Loslassen auf einer Zone sichert die Dateien dort.
//
// Beide Fenster sind NSPanel ohne Aktivierung (wie Spotlight), schweben über
// allen Spaces und Vollbild-Programmen.
//
// Ereignisse:
//   "palette-open"    an die Palette: wurde eingeblendet (true = aus InDesign)
//   "dropbar-show"    an die Leiste: Ziehen hat begonnen
//   "dropbar-release" an die Leiste: Maustaste losgelassen

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const PALETTE: &str = "palette";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const DROPBAR: &str = "dropbar";
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";

/// Zonenleiste beim Ziehen eingeschaltet
static DROPBAR_ON: AtomicBool = AtomicBool::new(true);
/// Zonenleiste ohne ⌥, sobald Dateien gezogen werden (0.40.24, „Immer“)
static DROPBAR_ALWAYS: AtomicBool = AtomicBool::new(false);
/// Gerade wird aus der Palette gezogen: keine Leiste, Palette nicht schließen
static PALETTE_DRAG: AtomicBool = AtomicBool::new(false);
/// Zonenleiste nach dem Loslassen stehen lassen bis zu diesem Zeitpunkt (ms):
/// solange der Import läuft und kurz danach, damit Erfolg oder Fehler zu sehen
/// sind (0.31.0). Vorher verschwand sie nach 0.9 s, auch mitten im Import.
static DROPBAR_HOLD: AtomicU64 = AtomicU64::new(0);
/// Hauptfenster beim Öffnen des Trays weggelegt (0.28): kommt beim Schließen
/// hinter alle Fenster zurück, statt mit Archiver nach vorne zu springen.
pub static MAIN_TUCKED: AtomicBool = AtomicBool::new(false);
/// 0.37.1: Wann Archiver zuletzt aus ⌘H zurückkam (ms). Öffnet der Betrachter
/// ein Bild aus dem Finder, blendet macOS Archiver vorher ein, mit allen
/// Fenstern; so erkennt der Betrachter, dass das Hauptfenster weg war.
pub static UNHIDDEN_AT: AtomicU64 = AtomicU64::new(0);
/// Programm, das vor der Palette vorne war (NSRunningApplication, 0 = keins)
#[cfg(target_os = "macos")]
static BEFORE_PALETTE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemPrefs {
    /// Kürzel für die Palette, leer = aus
    pub shortcut: String,
    /// Zonenleiste beim Ziehen am ganzen Mac
    pub dropbar: bool,
    /// Leiste selbst in den Einstellungen gewählt (0.32.1). Gilt nur noch für
    /// die alte Leiste ohne ⌥ und wird beim Laden nicht mehr ausgewertet.
    #[serde(default)]
    pub dropbar_chosen: bool,
    /// Leiste mit ⌥ (0.40.21) selbst gewählt. Ohne Wahl ist sie an, auch wenn
    /// die alte Leiste (ohne ⌥) ausgeschaltet war.
    #[serde(default)]
    pub dropbar_alt_chosen: bool,
    /// „Immer“ (0.40.24): ohne ⌥, sobald Dateien gezogen werden
    #[serde(default)]
    pub dropbar_always: bool,
}

impl Default for SystemPrefs {
    fn default() -> Self {
        SystemPrefs { shortcut: DEFAULT_SHORTCUT.into(), dropbar: true, dropbar_chosen: false, dropbar_alt_chosen: false, dropbar_always: false }
    }
}

impl SystemPrefs {
    /// Ab Werk an (0.40.21, mit ⌥): aus nur, wenn jemand sie seitdem selbst
    /// ausgeschaltet hat
    pub fn settle(&mut self) {
        if !self.dropbar_alt_chosen {
            self.dropbar = true;
        }
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
    DROPBAR_ALWAYS.store(prefs.dropbar_always, Ordering::Relaxed);
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
        .title("Archery")
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
        .title("Archery")
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
                    close_palette(&app2, ns);
                } else {
                    // Archiver ist mit ⌘H ausgeblendet (0.37.1): nur den Tray einblenden,
                    // das Hauptfenster bleibt weg, bis man es übers Dock holt
                    if crate::macos::app_hidden() {
                        if let Some(Ok(main)) = app2.get_webview_window("main").map(|w| w.ns_window()) {
                            crate::macos::panel_hide(main.cast());
                        }
                        crate::macos::unhide_without_activation();
                    }
                    // Archiver liegt hinten: das Hauptfenster bleibt dort, auch wenn
                    // der Tray Archiver kurz aktiviert (0.28)
                    if !crate::macos::app_active() {
                        if let Some(Ok(main)) = app2.get_webview_window("main").map(|w| w.ns_window()) {
                            let main = main.cast();
                            if crate::macos::panel_visible(main) {
                                crate::macos::panel_hide(main);
                                MAIN_TUCKED.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                    let prev = crate::macos::frontmost_other_app();
                    crate::macos::release_app(BEFORE_PALETTE.swap(prev, Ordering::Relaxed));
                    crate::macos::panel_center_on_mouse_screen(ns);
                    crate::macos::panel_show(ns, true);
                    let _ = app2.emit_to(PALETTE, "palette-open", from_indesign());
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Palette ausblenden. War Archiver dadurch vorne (esc, Klick in die Palette),
/// kommt das Programm von vorher zurück, nicht das Archiver-Fenster.
#[cfg(target_os = "macos")]
unsafe fn close_palette(app: &AppHandle, ns: *mut objc2::runtime::AnyObject) {
    crate::macos::panel_hide(ns);
    let prev = BEFORE_PALETTE.swap(0, Ordering::Relaxed);
    if crate::macos::app_active() {
        crate::macos::activate_app(prev);
    } else if prev != 0 {
        // nur freigeben
        crate::macos::release_app(prev);
    }
    if MAIN_TUCKED.swap(false, Ordering::Relaxed) {
        if let Some(Ok(main)) = app.get_webview_window("main").map(|w| w.ns_window()) {
            crate::macos::order_back(main.cast());
        }
    }
}

pub fn hide_palette(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window(PALETTE) {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                unsafe { close_palette(&app2, ns.cast()) };
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

/// Die Zonenleiste bittet, noch `ms` stehen zu bleiben (höchstens eine Minute)
#[tauri::command]
pub fn dropbar_hold(ms: u64) {
    DROPBAR_HOLD.store(crate::library::now_ms() as u64 + ms.min(60_000), Ordering::Relaxed);
}

/// Miniatur beim Ablegen (4.13): Die Zonenleiste darf das abgelegte Bild
/// zeigen, bevor es in der Bibliothek liegt. Nur Bilder, nur diese Dateien.
#[tauri::command]
pub fn dropbar_preview(app: AppHandle, path: String) -> bool {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let image = matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "heif" | "avif" | "tif" | "tiff" | "bmp");
    image && p.is_file() && tauri::Manager::asset_protocol_scope(&app).allow_file(p).is_ok()
}

/// Glas hinter den Karten (4.13): Rechtecke [x, oben, Breite, Höhe] in Punkten
#[tauri::command]
pub fn dropbar_glass(app: AppHandle, cards: Vec<[f64; 4]>, radius: f64, light: bool) {
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window(DROPBAR) {
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                unsafe { crate::macos::set_glass(ns.cast(), &cards, radius, light) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, cards, radius, light);
}

/// Zonenleiste ausblenden, Glas eingeschlossen (das Glas folgt keinem CSS)
#[tauri::command]
pub fn dropbar_fade(app: AppHandle, ms: f64) {
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window(DROPBAR) {
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                unsafe { crate::macos::fade_out(ns.cast(), ms) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, ms);
}

#[tauri::command]
pub fn palette_hide(app: AppHandle) {
    hide_palette(&app);
}

/// Ziehen aus der Palette beginnt bzw. endet: Palette klappt auf die Leiste
/// oben zusammen (V4, 0.37.2) und lässt Klicks durch, das Ziel liegt frei.
#[tauri::command]
pub fn palette_ghost(app: AppHandle, on: bool, bar: Option<f64>) {
    PALETTE_DRAG.store(on, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window(PALETTE) {
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                unsafe { crate::macos::panel_ghost(ns.cast(), on, bar.unwrap_or(72.0)) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

// ---- InDesign: Bild in den markierten Rahmen oder in den Platzieren-Cursor ----

/// Läuft in InDesign (ExtendScript). Markierter Rahmen (auch ein Bild darin):
/// Bild hinein, proportional füllen, zentrieren. Sonst: in den Platzieren-Cursor.
const INDESIGN_JS: &str = r#"
var f = File(arguments[0]);
var out = "nodoc";
if (app.documents.length > 0) {
  var sel = app.selection;
  var t = sel.length === 1 ? sel[0] : null;
  if (t && /^(Image|PDF|EPS|ImportedPage|PICT|WMF|Graphic)$/.test(t.constructor.name)) t = t.parent;
  if (t && /^(Rectangle|Oval|Polygon)$/.test(t.constructor.name)) {
    t.place(f);
    t.fit(FitOptions.FILL_PROPORTIONALLY);
    t.fit(FitOptions.CENTER_CONTENT);
    out = "frame";
  } else {
    app.activeDocument.placeGuns.loadPlaceGun(f, false);
    out = "gun";
  }
}
out;
"#;

/// Kam die Palette aus InDesign?
fn from_indesign() -> bool {
    #[cfg(target_os = "macos")]
    {
        let app = BEFORE_PALETTE.load(Ordering::Relaxed);
        return crate::macos::app_bundle_id(app).is_some_and(|id| id.starts_with("com.adobe.InDesign"));
    }
    #[cfg(not(target_os = "macos"))]
    false
}

/// ↵ oder Doppelklick in der Palette. Kam sie aus InDesign: Bild dort platzieren
/// ("frame" | "gun" | "nodoc"). Sonst "none" (die Palette kopiert dann).
#[tauri::command]
pub async fn palette_place(app: AppHandle, path: String) -> Result<String, String> {
    if !from_indesign() {
        return Ok("none".into());
    }
    hide_palette(&app);
    tauri::async_runtime::spawn_blocking(move || {
        // osascript fragt beim ersten Mal „Archiver möchte InDesign steuern“
        let script = r#"on run argv
  tell application id "com.adobe.InDesign"
    activate
    return do script (item 2 of argv) language javascript with arguments {item 1 of argv}
  end tell
end run"#;
        let out = std::process::Command::new("osascript")
            .args(["-e", script, &path, INDESIGN_JS])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        // -1743: nicht erlaubt (Systemeinstellungen › Datenschutz › Automation)
        Err(if err.contains("-1743") { "indesign-denied".into() } else { err.trim().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Beobachtet das Ziehen am ganzen Mac. Kein Ereignis-Hook (der bräuchte die
/// Bedienungshilfen-Freigabe), sondern ein Blick alle 30 ms: Maustaste gedrückt
/// und die Drag-Zwischenablage hat sich seit dem Drücken geändert → es wird
/// gezogen. Nur Dateien zählen, und nicht, wenn Archiver selbst vorne ist
/// (dort hat das Hauptfenster seine eigene Leiste). Die Leiste kommt erst,
/// wenn während des Ziehens ⌥ gehalten wird (0.40.21), dann gleich in voller
/// Höhe; ⌥ darf danach wieder losgelassen werden.
#[cfg(target_os = "macos")]
fn watch_drags(app: AppHandle) {
    use std::time::{Duration, Instant};
    std::thread::spawn(move || {
        let mut base: Option<isize> = None;
        let mut showing = false;
        // dieses Ziehen hat Dateien und wartet nur noch auf ⌥
        let mut armed = false;
        let mut released: Option<Instant> = None;
        let mut was_hidden = false;
        loop {
            std::thread::sleep(Duration::from_millis(30));
            let hidden = crate::macos::app_hidden();
            if was_hidden && !hidden {
                UNHIDDEN_AT.store(crate::library::now_ms() as u64, Ordering::Relaxed);
            }
            was_hidden = hidden;
            let (pressed, count) = crate::macos::drag_probe();
            if !pressed {
                base = Some(count);
                armed = false;
                if showing {
                    let at = *released.get_or_insert_with(|| {
                        let _ = app.emit_to(DROPBAR, "dropbar-release", ());
                        Instant::now()
                    });
                    // kurz stehen lassen: der Drop und seine Bestätigung brauchen einen Moment
                    let held = (crate::library::now_ms() as u64) < DROPBAR_HOLD.load(Ordering::Relaxed);
                    if at.elapsed() > Duration::from_millis(900) && !held {
                        showing = false;
                        released = None;
                        set_dropbar(&app, false);
                    }
                }
                continue;
            }
            released = None;
            if showing {
                continue;
            }
            let Some(b) = base else {
                base = Some(count);
                continue;
            };
            if !armed {
                if count == b {
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
                armed = true;
            }
            if DROPBAR_ALWAYS.load(Ordering::Relaxed) || crate::macos::option_held() {
                armed = false;
                showing = true;
                set_dropbar(&app, true);
            }
        }
    });
}

/// Zonenleiste (DESIGN.md 4.13): vier Karten im Format 2:1 wie in der App
/// (Rand 10 px, Lücken 8 px, oben 4 px für den Ring), höchstens 320 px hoch
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn dropbar_height(screen_width: f64) -> f64 {
    let card = (screen_width - 2.0 * 10.0 - 3.0 * 8.0) / 4.0;
    (card / 2.0 + 4.0 + 10.0).round().clamp(120.0, 320.0)
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
                // Archiver ist mit ⌘H ausgeblendet (0.40.25): nur die Leiste
                // einblenden, das Hauptfenster bleibt weg (wie der Tray, 0.37.1).
                // Vorher holte die Leiste dabei das ganze Programm nach vorne.
                if crate::macos::app_hidden() {
                    if let Some(Ok(main)) = app2.get_webview_window("main").map(|w| w.ns_window()) {
                        crate::macos::panel_hide(main.cast());
                    }
                    crate::macos::unhide_without_activation();
                }
                crate::macos::panel_bottom_of_mouse_screen(ns, dropbar_height, false);
                crate::macos::panel_show(ns, false);
                let _ = app2.emit_to(DROPBAR, "dropbar-show", ());
            } else {
                crate::macos::panel_hide(ns);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::SystemPrefs;

    #[test]
    fn dropbar_cards_are_two_to_one() {
        // MacBook Air 13": 1470 pt breit → Karten 356 × 178
        assert_eq!(super::dropbar_height(1470.0), 192.0);
        assert_eq!(super::dropbar_height(6000.0), 320.0);
    }

    #[test]
    fn dropbar_with_option_is_on_unless_turned_off_again() {
        // Die alte Leiste war aus (ab Werk oder selbst gewählt): mit ⌥ wieder an
        let mut old: SystemPrefs =
            serde_json::from_str(r#"{"shortcut":"Alt+Space","dropbar":false,"dropbarChosen":true}"#).unwrap();
        old.settle();
        assert!(old.dropbar);
        // Seit 0.40.21 selbst ausgeschaltet: bleibt aus
        let mut off: SystemPrefs =
            serde_json::from_str(r#"{"shortcut":"Alt+Space","dropbar":false,"dropbarAltChosen":true}"#).unwrap();
        off.settle();
        assert!(!off.dropbar);
        assert!(SystemPrefs::default().dropbar);
    }
}
