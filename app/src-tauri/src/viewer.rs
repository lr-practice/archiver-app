// viewer.rs
// Betrachter: Archiver als „Öffnen mit“ für Bilder im Finder. Zeigt ein Bild
// in einem eigenen Fenster, blättert durch den Ordner und führt in die App.
//
// Ereignisse:
//   "viewer-open"    an den Betrachter: ein anderes Bild wurde geöffnet
//   "reveal-in-app"  an das Hauptfenster: { path } Bild in der App zeigen

use crate::library::{self, Zone};
use crate::{after_import, current, AppState};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "viewer";

/// Öffnet ein Bild im Betrachter (neues Fenster oder das vorhandene).
pub fn open(app: &AppHandle, path: PathBuf) {
    if !path.is_file() || !(library::is_media(&path) && !library::is_text(&path)) {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, false);
    }
    *app.state::<AppState>().viewer.lock().unwrap() = Some(path.clone());

    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.emit("viewer-open", path.to_string_lossy().to_string());
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("viewer.html".into()))
        .title(file_name(&path))
        .inner_size(1100.0, 780.0)
        .min_inner_size(420.0, 320.0)
        .background_color(tauri::window::Color(18, 18, 18, 255))
        .theme(Some(tauri::Theme::Dark));
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    if let Ok(win) = builder.build() {
        let _ = win.set_focus();
    }
}

/// Bilder, die beim Start übergeben wurden (Linux/Windows: als Argumente).
pub fn from_args() -> Option<PathBuf> {
    std::env::args_os().skip(1).map(PathBuf::from).find(|p| p.is_file() && library::is_media(p) && !library::is_text(p))
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// Gleiche Datei? Über Gerät und Inode, damit Schreibweisen von Umlauten
/// (macOS liefert sie mal zerlegt, mal zusammengesetzt) keine Rolle spielen.
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(x), Ok(y)) = (std::fs::metadata(a), std::fs::metadata(b)) {
            return x.dev() == y.dev() && x.ino() == y.ino();
        }
    }
    a == b
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Siblings {
    files: Vec<String>,
    /// Eintrag in `files`, der dem geöffneten Bild entspricht
    current: Option<String>,
}

/// Alle Bilder im selben Ordner (die Oberfläche sortiert sie wie der Finder).
#[tauri::command]
pub async fn viewer_siblings(path: String) -> Result<Siblings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = PathBuf::from(&path);
        let Some(Ok(entries)) = target.parent().map(std::fs::read_dir) else {
            return Siblings { files: vec![path.clone()], current: Some(path) };
        };
        let files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| !file_name(p).starts_with('.') && library::is_media(p) && !library::is_text(p) && p.is_file())
            .collect();
        let current = files
            .iter()
            .find(|p| **p == target)
            .or_else(|| files.iter().find(|p| same_file(p, &target)))
            .map(|p| p.to_string_lossy().to_string());
        Siblings { files: files.into_iter().map(|p| p.to_string_lossy().to_string()).collect(), current }
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerState {
    path: Option<String>,
    library: Option<String>,
}

#[tauri::command]
pub async fn viewer_state(state: State<'_, AppState>) -> Result<ViewerState, String> {
    let path = state.viewer.lock().unwrap().clone();
    let lib = state.library.lock().unwrap().clone();
    Ok(ViewerState {
        path: path.map(|p| p.to_string_lossy().to_string()),
        library: lib.map(|l| l.root.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn viewer_zones(state: State<'_, AppState>) -> Result<Vec<Zone>, String> {
    let Ok(lib) = current(&state) else { return Ok(vec![]) };
    tauri::async_runtime::spawn_blocking(move || lib.zones().unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    bytes: u64,
    modified: Option<u64>,
}

#[tauri::command]
pub async fn viewer_file(path: String) -> Result<FileInfo, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(FileInfo { bytes: meta.len(), modified })
}

/// Liegt das Bild schon in der Bibliothek? Gibt den relativen Pfad zurück.
#[tauri::command]
pub async fn viewer_lookup(state: State<'_, AppState>, path: String) -> Result<Option<String>, String> {
    let Ok(lib) = current(&state) else { return Ok(None) };
    *state.viewer.lock().unwrap() = Some(PathBuf::from(&path));
    tauri::async_runtime::spawn_blocking(move || lib.find_file(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())
}

/// Bild in eine Zone der Bibliothek kopieren.
#[tauri::command]
pub async fn viewer_save(app: AppHandle, state: State<'_, AppState>, path: String, zone: String) -> Result<Option<String>, String> {
    let lib = current(&state)?;
    let report = tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&path);
        let report = lib.import_files(&[src.clone()], &zone)?;
        Ok::<_, String>((report, lib.find_file(&src)))
    })
    .await
    .map_err(|e| e.to_string())??;
    after_import(&app, report.0);
    Ok(report.1)
}

/// Hauptfenster nach vorn holen und dort (wenn bekannt) das Bild zeigen.
#[tauri::command]
pub async fn show_in_app(app: AppHandle, path: Option<String>) -> Result<(), String> {
    show_main(&app);
    if let Some(p) = path {
        app.emit_to("main", "reveal-in-app", p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

// ---- Standardprogramm für Bilder (nur macOS) ----
// „Immer öffnen mit“ im Finder gilt nur für eine Datei. Hier meldet sich
// Archiver bei den Launch Services pro Format als Standard an.

/// Formate, wie sie in den Einstellungen erscheinen, mit ihren Typkennungen.
const FORMATS: &[(&str, &[&str])] = &[
    ("JPEG", &["public.jpeg"]),
    ("PNG", &["public.png"]),
    ("GIF", &["com.compuserve.gif"]),
    ("WebP", &["org.webmproject.webp"]),
    ("TIFF", &["public.tiff"]),
    ("HEIC", &["public.heic", "public.heif"]),
    ("AVIF", &["public.avif"]),
    ("BMP", &["com.microsoft.bmp"]),
    ("SVG", &["public.svg-image"]),
    ("PDF", &["com.adobe.pdf"]),
    ("MP4", &["public.mpeg-4"]),
    ("MOV", &["com.apple.quicktime-movie"]),
];

#[cfg(target_os = "macos")]
mod launch_services {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    const ROLES_ALL: u32 = 0xFFFF_FFFF;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32, bundle_id: CFStringRef) -> i32;
        fn LSCopyDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32) -> CFStringRef;
    }

    pub fn set(content_type: &str, bundle_id: &str) -> i32 {
        let t = CFString::new(content_type);
        let b = CFString::new(bundle_id);
        unsafe { LSSetDefaultRoleHandlerForContentType(t.as_concrete_TypeRef(), ROLES_ALL, b.as_concrete_TypeRef()) }
    }

    pub fn get(content_type: &str) -> Option<String> {
        let t = CFString::new(content_type);
        let r = unsafe { LSCopyDefaultRoleHandlerForContentType(t.as_concrete_TypeRef(), ROLES_ALL) };
        if r.is_null() {
            return None;
        }
        Some(unsafe { CFString::wrap_under_create_rule(r) }.to_string())
    }
}

#[derive(Serialize)]
pub struct FormatDefault {
    name: &'static str,
    active: bool,
}

/// Für welche Formate ist Archiver Standard?
#[tauri::command]
pub fn viewer_defaults(app: AppHandle) -> Vec<FormatDefault> {
    #[cfg(target_os = "macos")]
    let is_ours = |t: &str| launch_services::get(t).is_some_and(|h| h.eq_ignore_ascii_case(&app.config().identifier));
    #[cfg(not(target_os = "macos"))]
    let is_ours = |_: &str| {
        let _ = &app;
        false
    };
    FORMATS.iter().map(|(name, types)| FormatDefault { name, active: is_ours(types[0]) }).collect()
}

/// Archiver als Standardprogramm für ein Format festlegen.
#[tauri::command]
pub fn viewer_make_default(app: AppHandle, format: String) -> Result<(), String> {
    let (_, types) = FORMATS.iter().find(|(n, _)| *n == format).ok_or("Unbekanntes Format")?;
    #[cfg(target_os = "macos")]
    {
        let id = app.config().identifier.clone();
        if types.iter().all(|t| launch_services::set(t, &id) != 0) {
            return Err("macOS hat die Änderung abgelehnt".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, types);
        Err("Nur auf dem Mac".into())
    }
}

/// Kleines Bild (96 px) fürs Ziehen, als PNG-Daten-URL.
#[tauri::command]
pub async fn viewer_drag_icon(path: String) -> Option<String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&path).ok()?.thumbnail(96, 96);
        let mut png = std::io::Cursor::new(Vec::new());
        img.to_rgba8().write_to(&mut png, image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner())))
    })
    .await
    .ok()
    .flatten()
}
