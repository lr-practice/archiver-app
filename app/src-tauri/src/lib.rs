// lib.rs
// Tauri-Seite der App: Befehle für die Oberfläche, Einstellungen (welcher
// Bibliotheksordner), Dateisystem-Watcher und Vorschaubild-Worker.
//
// Ereignisse an die Oberfläche:
//   "library-changed"  Bestand hat sich geändert → Oberfläche lädt neu
//   "thumbs-ready"     [{ hash, thumb }] neue Vorschaubilder

pub mod bridge;
pub mod library;
pub mod pdf;
mod viewer;
#[cfg(target_os = "macos")]
mod macos;

use library::{ImportReport, Item, Library, Zone};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Watcher = notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::RecommendedCache>;

#[derive(Default)]
struct AppState {
    library: Mutex<Option<Arc<Library>>>,
    watcher: Mutex<Option<Watcher>>,
    thumbs: Mutex<Option<mpsc::Sender<()>>>,
    /// Bild, das gerade im Betrachter offen ist
    viewer: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    library: Option<String>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = settings_path(app).ok_or("Kein Einstellungsordner")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())
}

fn current(state: &State<AppState>) -> Result<Arc<Library>, String> {
    state.library.lock().unwrap().clone().ok_or_else(|| "Keine Bibliothek geöffnet".into())
}

/// Bestand neu einlesen und bei Änderungen die Oberfläche und den Vorschau-Worker anstoßen.
fn rescan(app: &AppHandle, lib: &Library) {
    if lib.scan().unwrap_or(false) {
        let _ = app.emit("library-changed", ());
    }
    kick_thumbs(app);
}

fn kick_thumbs(app: &AppHandle) {
    if let Some(tx) = app.state::<AppState>().thumbs.lock().unwrap().as_ref() {
        let _ = tx.send(());
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThumbReady {
    hash: String,
    thumb: String,
}

/// Ein Hintergrund-Thread rechnet fehlende Vorschaubilder, verteilt auf alle Kerne,
/// und meldet sie in kleinen Paketen an die Oberfläche.
fn start_thumb_worker(app: AppHandle, lib: Arc<Library>) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    let analysis = start_analysis_worker(app.clone(), lib.clone());
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            let _ = analysis.send(());
            while rx.try_recv().is_ok() {}
            let Ok(todo) = lib.missing_thumbs() else { continue };
            let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
            for batch in todo.chunks(workers * 3) {
                let ready = Mutex::new(Vec::new());
                std::thread::scope(|s| {
                    for part in batch.chunks(3) {
                        let (lib, ready) = (&lib, &ready);
                        s.spawn(move || {
                            for (hash, path) in part {
                                if let Some(thumb) = lib.make_thumb(hash, path) {
                                    ready.lock().unwrap().push(ThumbReady { hash: hash.clone(), thumb });
                                }
                            }
                        });
                    }
                });
                let ready = ready.into_inner().unwrap();
                if !ready.is_empty() {
                    let _ = app.emit("thumbs-ready", ready);
                }
            }
            let _ = analysis.send(());
        }
    });
    tx
}

/// Zweiter Hintergrund-Thread: Farben, Bildinhalt und Text je Vorschaubild,
/// eins nach dem anderen (Vision ist rechenintensiv). Ergebnisse in Paketen.
fn start_analysis_worker(app: AppHandle, lib: Arc<Library>) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            while rx.try_recv().is_ok() {}
            let Ok(todo) = lib.missing_analysis() else { continue };
            let mut ready = Vec::new();
            for (hash, thumb) in todo {
                let colors = library::color_shares(&thumb).unwrap_or_default();
                #[cfg(target_os = "macos")]
                let (labels, text) = macos::analyze_image(&thumb);
                #[cfg(not(target_os = "macos"))]
                let (labels, text): (Vec<String>, String) = (Vec::new(), String::new());
                let a = library::Analysis { hash, labels: labels.join(", "), text, colors };
                if lib.save_analysis(&a).is_ok() {
                    ready.push(a);
                }
                if ready.len() >= 12 {
                    let _ = app.emit("analysis-ready", std::mem::take(&mut ready));
                }
            }
            if !ready.is_empty() {
                let _ = app.emit("analysis-ready", ready);
            }
        }
    });
    tx
}

/// Öffnet eine Bibliothek, startet Watcher und Vorschau-Worker und liest den Bestand ein.
fn activate(app: &AppHandle, root: &Path) -> Result<(), String> {
    let lib = Arc::new(Library::open(root)?);
    let state = app.state::<AppState>();
    *state.watcher.lock().unwrap() = None;

    app.asset_protocol_scope().allow_directory(root, true).map_err(|e| e.to_string())?;

    let tx = start_thumb_worker(app.clone(), lib.clone());
    *state.thumbs.lock().unwrap() = Some(tx);
    *state.library.lock().unwrap() = Some(lib.clone());

    let watch_app = app.clone();
    let watch_lib = lib.clone();
    // Die Brücke zur Extension trägt neue Bilder selbst in die Datenbank ein.
    // Dann findet der Scan nichts Neues, die Oberfläche muss trotzdem neu laden.
    let last_sig = Mutex::new(lib.signature());
    let mut debouncer = notify_debouncer_full::new_debouncer(
        Duration::from_millis(400),
        None,
        move |res: notify_debouncer_full::DebounceEventResult| {
            let Ok(events) = res else { return };
            let relevant = events.iter().any(|ev| {
                ev.paths.iter().any(|p| !p.components().any(|c| c.as_os_str() == library::META_DIR))
            });
            if relevant {
                let changed = watch_lib.scan().unwrap_or(false);
                let sig = watch_lib.signature();
                let mut last = last_sig.lock().unwrap();
                if changed || sig != *last {
                    let _ = watch_app.emit("library-changed", ());
                }
                *last = sig;
                kick_thumbs(&watch_app);
            }
        },
    )
    .map_err(|e| e.to_string())?;
    debouncer.watch(root, notify::RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *state.watcher.lock().unwrap() = Some(debouncer);

    let scan_app = app.clone();
    std::thread::spawn(move || rescan(&scan_app, &lib));
    Ok(())
}

// ---- Befehle ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartInfo {
    library: Option<String>,
    suggested_library: String,
    extension_export: Option<String>,
}

#[tauri::command]
async fn start_info(state: State<'_, AppState>) -> Result<StartInfo, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let export = dirs::download_dir().unwrap_or_else(|| home.join("Downloads")).join("archiver-export.json");
    Ok(StartInfo {
        library: state.library.lock().unwrap().as_ref().map(|l| l.root.to_string_lossy().into_owned()),
        suggested_library: home.join("Archiver").to_string_lossy().into_owned(),
        extension_export: export.is_file().then(|| export.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
fn bridge_browsers() -> Vec<String> {
    bridge::connected_browsers()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_export_file(app: AppHandle) -> Option<String> {
    let mut dialog = app.dialog().file().add_filter("Archiver Export", &["json"]);
    if let Some(dir) = dirs::download_dir() {
        dialog = dialog.set_directory(dir);
    }
    dialog.blocking_pick_file().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn open_library(app: AppHandle, path: String) -> Result<(), String> {
    activate(&app, Path::new(&path))?;
    save_settings(&app, &Settings { library: Some(path) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    root: String,
    name: String,
    zones: Vec<Zone>,
    items: Vec<Item>,
}

#[tauri::command]
async fn snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let lib = current(&state)?;
    Ok(Snapshot {
        root: lib.root.to_string_lossy().into_owned(),
        name: lib.root.file_name().and_then(|n| n.to_str()).unwrap_or("Archiver").to_string(),
        zones: lib.zones()?,
        items: lib.items()?,
    })
}

#[tauri::command]
async fn move_items(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, zone: String) -> Result<Vec<String>, String> {
    let moved = current(&state)?.move_items(&paths, &zone)?;
    let _ = app.emit("library-changed", ());
    Ok(moved)
}

#[tauri::command]
async fn trash_items(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<usize, String> {
    let n = current(&state)?.trash_items(&paths)?;
    let _ = app.emit("library-changed", ());
    Ok(n)
}

#[tauri::command]
async fn create_zone(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<String, String> {
    let z = current(&state)?.create_zone(&name)?;
    let _ = app.emit("library-changed", ());
    Ok(z)
}

#[tauri::command]
async fn rename_zone(app: AppHandle, state: State<'_, AppState>, zone: String, name: String) -> Result<String, String> {
    let z = current(&state)?.rename_zone(&zone, &name)?;
    let _ = app.emit("library-changed", ());
    Ok(z)
}

/// Reihenfolge der Zonen und die vier Hot Zones (für die Extension)
#[tauri::command]
async fn set_zone_order(state: State<'_, AppState>, order: Vec<String>, hot: Vec<String>) -> Result<(), String> {
    current(&state)?.set_zone_order(&order, &hot)
}

#[tauri::command]
async fn trash_zone(app: AppHandle, state: State<'_, AppState>, zone: String) -> Result<(), String> {
    current(&state)?.trash_zone(&zone)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
async fn reveal_zone(app: AppHandle, state: State<'_, AppState>, zone: String) -> Result<(), String> {
    let lib = current(&state)?;
    let dir = if zone.is_empty() { lib.root.clone() } else { lib.root.join(&zone) };
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

fn after_import(app: &AppHandle, report: ImportReport) -> ImportReport {
    let _ = app.emit("library-changed", ());
    kick_thumbs(app);
    report
}

#[tauri::command]
async fn import_extension_export(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ImportReport, String> {
    let lib = current(&state)?;
    let report = tauri::async_runtime::spawn_blocking(move || lib.import_extension_export(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(after_import(&app, report))
}

#[tauri::command]
async fn import_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ImportReport, String> {
    let lib = current(&state)?;
    let report = tauri::async_runtime::spawn_blocking(move || lib.import_folder(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(after_import(&app, report))
}

#[tauri::command]
async fn import_files(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, zone: String) -> Result<ImportReport, String> {
    let lib = current(&state)?;
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let report = tauri::async_runtime::spawn_blocking(move || lib.import_files(&files, &zone))
        .await
        .map_err(|e| e.to_string())??;
    Ok(after_import(&app, report))
}

#[tauri::command]
async fn drag_icon(state: State<'_, AppState>, hash: String, path: String) -> Result<Option<String>, String> {
    Ok(current(&state)?.drag_icon(&hash, Path::new(&path)))
}

#[tauri::command]
async fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("Nur Web- und Mail-Adressen".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Kontaktbogen: fragt nach dem Speicherort, schreibt das PDF und öffnet es.
/// Gibt den Pfad zurück, oder None, wenn der Dialog abgebrochen wurde.
#[tauri::command]
async fn export_pdf(
    app: AppHandle,
    title: String,
    meta: String,
    file_name: String,
    items: Vec<pdf::SheetItem>,
    layout: Option<pdf::Layout>,
) -> Result<Option<String>, String> {
    let layout = layout.unwrap_or_else(|| pdf::Layout::auto(items.len()));
    let mut dialog = app.dialog().file().add_filter("PDF", &["pdf"]).set_file_name(&file_name);
    if let Some(dir) = dirs::download_dir() {
        dialog = dialog.set_directory(dir);
    }
    let Some(path) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&target, pdf::contact_sheet(&title, &meta, &items, layout)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn open_file(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

// ---- Updates ----
// Die App fragt beim Start im öffentlichen Repo Archiver-Releases nach
// latest.json. Gibt es eine neuere Version, zeigt die Oberfläche einen Hinweis;
// „Installieren“ lädt das signierte Paket, ersetzt die App und startet neu.

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Hell / Dunkel aus den Einstellungen: Fensterrahmen und Glas passend setzen.
/// Dunkel bleibt das HUD-Glas, Hell nimmt das helle Seitenleisten-Glas.
#[tauri::command]
fn set_appearance(window: tauri::WebviewWindow, light: bool) {
    let _ = window.set_theme(Some(if light { tauri::Theme::Light } else { tauri::Theme::Dark }));
    if window.label() == "main" {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        let effect = if light { Effect::Sidebar } else { Effect::HudWindow };
        let _ = window.set_effects(EffectsBuilder::new().effect(effect).state(EffectState::Active).build());
    }
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let Some(update) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

// ---- Startton ----
// Standard ist der eingebettete Archiver-Ton (von Lukas, sounds/standard.wav). Eine eigene Datei liegt als Kopie in
// <Konfiguration>/startton/<Originalname>.

const STANDARD_WAV: &[u8] = include_bytes!("../sounds/standard.wav");
const SOUND_EXTS: &[&str] = &["wav", "aif", "aiff", "mp3", "m4a", "caf"];

fn sound_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("startton"))
}

fn custom_sound(app: &AppHandle) -> Option<PathBuf> {
    std::fs::read_dir(sound_dir(app)?)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.is_file() && p.extension().and_then(|e| e.to_str()).is_some_and(|e| SOUND_EXTS.contains(&e.to_lowercase().as_str())))
}

fn standard_sound(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let path = dir.join("standard.wav");
    if std::fs::metadata(&path).map(|m| m.len() as usize).ok() != Some(STANDARD_WAV.len()) {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&path, STANDARD_WAV).ok()?;
    }
    Some(path)
}

/// Name der eigenen Datei, None = Standard
#[tauri::command]
fn startup_sound_name(app: AppHandle) -> Option<String> {
    custom_sound(&app).and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn play_startup_sound(app: AppHandle, volume: f32) -> Result<(), String> {
    let path = custom_sound(&app).or_else(|| standard_sound(&app)).ok_or("Kein Startton")?;
    #[cfg(target_os = "macos")]
    {
        let path = path.to_string_lossy().into_owned();
        app.run_on_main_thread(move || {
            macos::play_sound(&path, volume);
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (path, volume);
    Ok(())
}

/// Eigene Datei wählen: wird kopiert, die alte ersetzt. Gibt den Namen zurück.
#[tauri::command]
async fn pick_startup_sound(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Audio", SOUND_EXTS)
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok());
    let Some(src) = picked else { return Ok(None) };
    if std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0) > 10 * 1024 * 1024 {
        return Err("Die Datei ist größer als 10 MB.".into());
    }
    let dir = sound_dir(&app).ok_or("Kein Konfigurationsordner")?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = src.file_name().ok_or("Ungültige Datei")?.to_owned();
    std::fs::copy(&src, dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(Some(name.to_string_lossy().into_owned()))
}

/// Zurück auf den Standard
#[tauri::command]
fn reset_startup_sound(app: AppHandle) -> Result<(), String> {
    if let Some(dir) = sound_dir(&app) {
        let _ = std::fs::remove_dir_all(dir);
    }
    Ok(())
}

/// ⌘C: Bilder in die Zwischenablage (AppKit, auf dem Hauptthread).
#[tauri::command]
async fn copy_images(app: AppHandle, paths: Vec<String>, text: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let ok = match (&text, paths.as_slice()) {
                (Some(text), [path]) => macos::copy_text_image(path, text),
                _ => macos::copy_images(&paths),
            };
            let _ = tx.send(ok);
        })
        .map_err(|e| e.to_string())?;
        match rx.recv() {
            Ok(true) => Ok(()),
            _ => Err("Kopieren fehlgeschlagen".into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, paths, text);
        Err("Nur auf dem Mac".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Brücke zur Chrome-Extension anmelden (bei jedem Start, falls die App verschoben wurde).
            std::thread::spawn(bridge::install_manifests);
            if let Some(path) = load_settings(&handle).library {
                if Path::new(&path).is_dir() {
                    let _ = activate(&handle, Path::new(&path));
                }
            }
            if let Some(path) = viewer::from_args() {
                viewer::open(&handle, path);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Ist der Betrachter offen, wird das Hauptfenster nur ausgeblendet,
            // damit „In Archiver zeigen“ es wieder hervorholen kann.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && window.app_handle().get_webview_window(viewer::LABEL).is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_info,
            bridge_browsers,
            pick_folder,
            pick_export_file,
            open_library,
            snapshot,
            move_items,
            trash_items,
            create_zone,
            rename_zone,
            set_zone_order,
            trash_zone,
            reveal_zone,
            import_extension_export,
            import_folder,
            import_files,
            drag_icon,
            reveal,
            open_url,
            open_file,
            export_pdf,
            copy_images,
            startup_sound_name,
            play_startup_sound,
            pick_startup_sound,
            reset_startup_sound,
            set_appearance,
            update_check,
            update_install,
            viewer::viewer_state,
            viewer::viewer_siblings,
            viewer::viewer_zones,
            viewer::viewer_file,
            viewer::viewer_drag_icon,
            viewer::viewer_lookup,
            viewer::viewer_save,
            viewer::show_in_app,
            viewer::viewer_defaults,
            viewer::viewer_make_default,
        ])
        .build(tauri::generate_context!())
        .expect("Archiver konnte nicht starten")
        .run(|app, event| match event {
            // Bild aus dem Finder („Öffnen mit“ oder Doppelklick)
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        viewer::open(app, path);
                    }
                }
            }
            // Das Hauptfenster startet unsichtbar: wurde die App mit einem Bild
            // geöffnet, erscheint nur der Betrachter, sonst wie gewohnt die App.
            tauri::RunEvent::Ready => {
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(450));
                    if app.state::<AppState>().viewer.lock().unwrap().is_none() {
                        viewer::show_main(&app);
                    }
                });
            }
            // Klick aufs Dock-Symbol ohne offenes Fenster
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                if !has_visible_windows {
                    viewer::show_main(app);
                }
            }
            _ => {}
        });
}
