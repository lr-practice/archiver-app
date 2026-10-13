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
pub mod studio;
mod system;
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
    /// Name oder Kürzel für „abgelegt von“ und die geteilte Bibliothek
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    /// Drei feste Plätze für Bibliotheken, zwischen denen man umschaltet
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    libraries: Vec<LibrarySlot>,
    /// Palette per Kürzel und Zonenleiste beim Ziehen am ganzen Mac
    #[serde(default)]
    system: system::SystemPrefs,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct LibrarySlot {
    #[serde(default)]
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

const LIBRARY_SLOTS: usize = 3;

fn folder_name(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Immer drei Plätze. Ältere Einstellungen: die bisherige Bibliothek wird Platz 1.
fn library_slots(s: &Settings) -> Vec<LibrarySlot> {
    let mut slots = s.libraries.clone();
    slots.resize(LIBRARY_SLOTS, LibrarySlot::default());
    slots.truncate(LIBRARY_SLOTS);
    if slots.iter().all(|l| l.path.is_none()) {
        if let Some(path) = &s.library {
            slots[0] = LibrarySlot { name: folder_name(path), path: Some(path.clone()) };
        }
    }
    slots
}

// ---- Schutz vor Ordnern, die keine Bibliothek sein können ----
// Archiver liest und beobachtet den ganzen Ordner. Der Benutzerordner, ein
// Laufwerk oder ein Systemordner würde den Start minutenlang blockieren.

const LIBRARY_MAX_FILES: usize = 20_000;
const LIBRARY_COUNT_SECS: u64 = 10;

/// Ebenen unterhalb von ~/Library/CloudStorage bzw. ~/Library/Mobile Documents,
/// None für alles andere. Beispiel: …/CloudStorage/GoogleDrive-x/Meine Ablage/Projekt = 3
fn cloud_depth(root: &Path) -> Option<usize> {
    let home = dirs::home_dir().and_then(|h| h.canonicalize().ok())?;
    for base in ["Library/CloudStorage", "Library/Mobile Documents"] {
        if let Ok(rest) = root.strip_prefix(home.join(base)) {
            return Some(rest.components().count());
        }
    }
    None
}

fn check_library(root: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("library-missing".into());
    }
    let mut blocked: Vec<PathBuf> = ["/", "/Users", "/Volumes", "/home", "/private", "/usr", "/opt", "/bin", "/etc"]
        .iter()
        .map(PathBuf::from)
        .collect();
    let mut system: Vec<PathBuf> = ["/System", "/Library", "/Applications"].iter().map(PathBuf::from).collect();
    if let Some(home) = dirs::home_dir().and_then(|h| h.canonicalize().ok()) {
        for d in ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Public"] {
            blocked.push(home.join(d));
        }
        system.push(home.join("Library"));
        system.push(home.join("Applications"));
        blocked.push(home);
    }
    // ein ganzes Laufwerk (/Volumes/Name) ist ebenfalls zu groß
    let is_volume = root.parent() == Some(Path::new("/Volumes"));
    // Cloud-Ordner (Google Drive, Dropbox, OneDrive, iCloud Drive) liegen unter
    // ~/Library, sind aber normale Ordner. Gesperrt bleibt nur ihre oberste Ebene
    // (das ganze Konto); die Menge prüft danach die Zählung.
    let cloud = cloud_depth(&root);
    if cloud.is_some_and(|d| d <= 1) {
        return Err("library-system".into());
    }
    if blocked.contains(&root) || is_volume || (cloud.is_none() && system.iter().any(|s| root.starts_with(s))) {
        return Err("library-system".into());
    }
    // Vorab zählen: zu viele Dateien oder zu langsam → ablehnen.
    // Geteilte Bibliotheken liegen oft im Netz, dort zählt nur die Menge.
    let shared = studio::is_shared(&root);
    let deadline = std::time::Instant::now() + Duration::from_secs(LIBRARY_COUNT_SECS);
    let mut count = 0usize;
    let walk = walkdir::WalkDir::new(&root)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| e.file_name() != library::META_DIR);
    for _ in walk.filter_map(|e| e.ok()) {
        count += 1;
        if count > LIBRARY_MAX_FILES {
            return Err("library-large".into());
        }
        if !shared && count % 256 == 0 && std::time::Instant::now() > deadline {
            return Err("library-slow".into());
        }
    }
    Ok(())
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
    lib.set_user(load_settings(app).user);
    // „Zuletzt gelöscht“: was älter als 7 Tage ist, geht in den Papierkorb des Macs
    let purge = lib.clone();
    std::thread::spawn(move || purge.purge_deleted(library::DELETED_DAYS));
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

    // Geteilt: Änderungen der anderen kommen übers Netz oft ohne Ereignis an,
    // darum regelmäßig nachsehen, solange diese Bibliothek offen ist.
    if lib.shared {
        let poll_app = app.clone();
        let poll_lib = Arc::downgrade(&lib);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            let Some(lib) = poll_lib.upgrade() else { break };
            let current = poll_app.state::<AppState>().library.lock().unwrap().clone();
            if !current.map(|c| Arc::ptr_eq(&c, &lib)).unwrap_or(false) {
                break;
            }
            let before = lib.signature();
            if lib.scan().unwrap_or(false) || lib.signature() != before {
                let _ = poll_app.emit("library-changed", ());
                kick_thumbs(&poll_app);
            }
        });
    }

    let scan_app = app.clone();
    std::thread::spawn(move || rescan(&scan_app, &lib));
    Ok(())
}

// ---- Befehle ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartInfo {
    library: Option<String>,
    /// Bibliothek aus den Einstellungen, noch nicht geöffnet
    pending: Option<String>,
    suggested_library: String,
    extension_export: Option<String>,
}

#[tauri::command]
async fn start_info(app: AppHandle, state: State<'_, AppState>) -> Result<StartInfo, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let export = dirs::download_dir().unwrap_or_else(|| home.join("Downloads")).join("archiver-export.json");
    Ok(StartInfo {
        library: state.library.lock().unwrap().as_ref().map(|l| l.root.to_string_lossy().into_owned()),
        pending: load_settings(&app).library.filter(|p| Path::new(p).is_dir()),
        suggested_library: home.join("Archiver").to_string_lossy().into_owned(),
        extension_export: export.is_file().then(|| export.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
fn bridge_browsers() -> Vec<String> {
    bridge::connected_browsers()
}

#[tauri::command]
fn extension_status() -> serde_json::Value {
    bridge::extension_status()
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
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        check_library(Path::new(&path))?;
        activate(&worker, Path::new(&path))?;
        let mut settings = load_settings(&worker);
        let mut slots = library_slots(&settings);
        // Neue Bibliothek bekommt einen Platz: den ersten freien, sonst den bisher aktiven
        if !slots.iter().any(|l| l.path.as_deref() == Some(path.as_str())) {
            let i = slots
                .iter()
                .position(|l| l.path.is_none())
                .or_else(|| slots.iter().position(|l| l.path.is_some() && l.path == settings.library))
                .unwrap_or(0);
            slots[i] = LibrarySlot { name: folder_name(&path), path: Some(path.clone()) };
        }
        settings.libraries = slots;
        settings.library = Some(path.clone());
        save_settings(&worker, &settings)?;
        // Hauptfenster, Palette und Leiste ziehen nach (auch beim Wechsel aus der Palette)
        let _ = worker.emit("library-switched", path);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySlotInfo {
    name: String,
    path: Option<String>,
    active: bool,
}

#[tauri::command]
fn libraries(app: AppHandle) -> Vec<LibrarySlotInfo> {
    let settings = load_settings(&app);
    library_slots(&settings)
        .into_iter()
        .map(|l| LibrarySlotInfo { active: l.path.is_some() && l.path == settings.library, name: l.name, path: l.path })
        .collect()
}

/// Platz umbenennen, neuen Ordner zuweisen (wird vorher geprüft) oder leeren.
#[tauri::command]
async fn set_library_slot(app: AppHandle, index: usize, name: Option<String>, path: Option<String>, clear: Option<bool>) -> Result<(), String> {
    if index >= LIBRARY_SLOTS {
        return Err("Unbekannter Platz".into());
    }
    if let Some(p) = path.clone() {
        tauri::async_runtime::spawn_blocking(move || check_library(Path::new(&p))).await.map_err(|e| e.to_string())??;
    }
    let mut settings = load_settings(&app);
    let mut slots = library_slots(&settings);
    let slot = &mut slots[index];
    if clear.unwrap_or(false) {
        if slot.path.is_some() && slot.path == settings.library {
            return Err("library-active".into());
        }
        *slot = LibrarySlot::default();
    }
    if let Some(p) = path {
        if slot.name.trim().is_empty() || slot.path.as_deref().map(folder_name).as_deref() == Some(slot.name.as_str()) {
            slot.name = folder_name(&p);
        }
        slot.path = Some(p);
    }
    if let Some(n) = name {
        slot.name = n.trim().to_string();
    }
    settings.libraries = slots;
    save_settings(&app, &settings)
}

// ---- Demo-Bibliothek für die Einstiegstour ----
// Eigener Ordner ~/Archiver Demo/. Gefüllt mit Kopien aus der eigenen Bibliothek
// (vier Active Zones, Inbox, dazu Bilder für das Browser-Schema in .web/);
// ist die eigene Bibliothek noch zu leer, mit den mitgelieferten Grafiken
// (src-tauri/demo). Geöffnet wird sie, ohne die eigene Bibliothek in den
// Einstellungen zu ersetzen. .seed.json merkt sich, was nicht selbst gesammelt wurde.

const DEMO_BUNDLED: [(&str, &str); 5] = [
    ("typografie", "Typografie"),
    ("plakate", "Plakate"),
    ("verpackung", "Verpackung"),
    ("identitaet", "Identität"),
    ("inbox", library::INBOX),
];
const DEMO_PER_ZONE: usize = 8;
const DEMO_INBOX: usize = 6;
const DEMO_WEB: usize = 6;

fn demo_root() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("Archiver Demo")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoInfo {
    root: String,
    zones: Vec<String>,
    web: Vec<DemoWeb>,
}

/// Bild für das Browser-Schema: `file` liegt in .web/ (zum Ablegen),
/// `show` ist zum Anzeigen (Pfad in der eigenen Bibliothek oder Name der
/// mitgelieferten Grafik unter app/src/tour/).
#[derive(Serialize)]
struct DemoWeb {
    file: String,
    show: String,
}

/// Was in die Demo kommt: (Quelle, Zone, Dateiname)
fn demo_plan(app: &AppHandle, own: Option<&Library>) -> Result<(Vec<(PathBuf, String, String)>, Vec<PathBuf>), String> {
    let mut plan = Vec::new();
    let mut web = Vec::new();
    if let Some(lib) = own {
        let items: Vec<Item> = lib.items()?.into_iter().filter(|i| library::is_image(Path::new(&i.abs))).collect();
        let (order, hot) = lib.zone_order();
        let mut zones: Vec<String> = if hot.is_empty() { order } else { hot };
        zones.retain(|z| !z.is_empty() && z != library::INBOX && items.iter().any(|i| &i.zone == z));
        if zones.len() < 4 {
            let mut counts: Vec<(String, usize)> = Vec::new();
            for i in &items {
                if i.zone.is_empty() || i.zone == library::INBOX || zones.contains(&i.zone) {
                    continue;
                }
                match counts.iter_mut().find(|(z, _)| z == &i.zone) {
                    Some(c) => c.1 += 1,
                    None => counts.push((i.zone.clone(), 1)),
                }
            }
            counts.sort_by(|a, b| b.1.cmp(&a.1));
            zones.extend(counts.into_iter().map(|(z, _)| z).take(4 - zones.len()));
        }
        zones.truncate(4);
        if zones.len() >= 2 {
            let mut used = std::collections::HashSet::new();
            for z in &zones {
                let name = z.rsplit('/').next().unwrap_or(z).to_string();
                for i in items.iter().filter(|i| &i.zone == z).take(DEMO_PER_ZONE) {
                    used.insert(i.path.clone());
                    plan.push((PathBuf::from(&i.abs), name.clone(), i.filename.clone()));
                }
            }
            // Inbox: unsortiert, möglichst aus der eigenen Inbox, sonst aus dem Rest
            let rest: Vec<&Item> = items.iter().filter(|i| !used.contains(&i.path)).collect();
            let mut inbox: Vec<&Item> = rest.iter().copied().filter(|i| i.zone == library::INBOX).take(DEMO_INBOX).collect();
            for i in rest.iter().copied().filter(|i| i.zone != library::INBOX) {
                if inbox.len() >= DEMO_INBOX {
                    break;
                }
                inbox.push(i);
            }
            for i in &inbox {
                used.insert(i.path.clone());
                plan.push((PathBuf::from(&i.abs), library::INBOX.to_string(), i.filename.clone()));
            }
            web = items.iter().filter(|i| !used.contains(&i.path)).take(DEMO_WEB).map(|i| PathBuf::from(&i.abs)).collect();
            if plan.len() >= 12 {
                return Ok((plan, web));
            }
            plan.clear();
            web.clear();
        }
    }
    // Zu wenig Eigenes: mitgelieferte Grafiken
    let res = app.path().resource_dir().map_err(|e| e.to_string())?.join("demo");
    for (dir, zone) in DEMO_BUNDLED {
        let Ok(entries) = std::fs::read_dir(res.join(dir)) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') {
                plan.push((e.path(), zone.to_string(), name));
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(res.join("web")) {
        web = entries.flatten().map(|e| e.path()).collect();
        web.sort();
    }
    Ok((plan, web))
}

#[tauri::command]
async fn open_demo(app: AppHandle, state: State<'_, AppState>) -> Result<DemoInfo, String> {
    let own = state.library.lock().unwrap().clone();
    let (plan, web) = demo_plan(&app, own.as_deref())?;
    let root = demo_root();
    if root.exists() {
        // Reste einer früheren Demo
        let _ = trash::delete(&root);
    }
    let mut seed = Vec::new();
    let mut zones: Vec<String> = Vec::new();
    for (src, zone, name) in plan {
        let dir = root.join(&zone);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = library::unique_path(&dir, &name);
        if std::fs::copy(&src, &dest).is_ok() {
            seed.push(format!("{}/{}", zone, dest.file_name().unwrap_or_default().to_string_lossy()));
            if !zones.contains(&zone) {
                zones.push(zone);
            }
        }
    }
    // Inbox ans Ende: die ersten vier sind die Active Zones
    if let Some(p) = zones.iter().position(|z| z == library::INBOX) {
        let inbox = zones.remove(p);
        zones.push(inbox);
    }
    let web_dir = root.join(".web");
    std::fs::create_dir_all(&web_dir).map_err(|e| e.to_string())?;
    let bundled = app.path().resource_dir().ok();
    let mut web_out = Vec::new();
    for src in web {
        let name = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let dest = library::unique_path(&web_dir, &name);
        if std::fs::copy(&src, &dest).is_ok() {
            let from_bundle = bundled.as_ref().is_some_and(|r| src.starts_with(r));
            web_out.push(DemoWeb {
                file: dest.to_string_lossy().into_owned(),
                show: if from_bundle { format!("tour/{name}") } else { src.to_string_lossy().into_owned() },
            });
        }
    }
    std::fs::write(root.join(".seed.json"), serde_json::to_vec(&seed).unwrap()).map_err(|e| e.to_string())?;
    activate(&app, &root)?;
    Ok(DemoInfo { root: root.to_string_lossy().into_owned(), zones, web: web_out })
}

/// Zurück zur eigenen Bibliothek. Was in der Demo selbst gesammelt wurde,
/// wandert in deren Inbox; ohne `keep` geht der Demo-Ordner in den Papierkorb.
#[tauri::command]
async fn close_demo(app: AppHandle, keep: bool) -> Result<usize, String> {
    let root = demo_root();
    let own = load_settings(&app).library.map(PathBuf::from);
    let seed: std::collections::HashSet<String> = std::fs::read(root.join(".seed.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut moved = 0;
    if let Some(own) = own.as_ref().filter(|o| o.is_dir() && root.is_dir()) {
        let inbox = own.join(library::INBOX);
        std::fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
        for e in walkdir::WalkDir::new(&root)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let rel = e.path().strip_prefix(&root).unwrap_or(e.path()).to_string_lossy().replace('\\', "/");
            if seed.contains(&rel) {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let dest = library::unique_path(&inbox, &name);
            if std::fs::rename(e.path(), &dest).is_err() {
                std::fs::copy(e.path(), &dest).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(e.path());
            }
            moved += 1;
        }
    }
    *app.state::<AppState>().watcher.lock().unwrap() = None;
    if !keep && root.is_dir() {
        trash::delete(&root).map_err(|e| e.to_string())?;
    }
    if let Some(own) = own.filter(|o| o.is_dir()) {
        activate(&app, &own)?;
    }
    Ok(moved)
}

/// Tour, Kapitel „Sammeln im Browser“: Ein Bild aus dem Schema landet wirklich in der Demo-Zone.
/// Es zählt als selbst gesammelt.
#[tauri::command]
async fn demo_collect(file: String, zone: String) -> Result<(), String> {
    let root = demo_root();
    let src = PathBuf::from(&file);
    if !src.starts_with(root.join(".web")) || file.contains("..") || zone.contains("..") || zone.starts_with('.') {
        return Err("Ungültiger Pfad".into());
    }
    let name = src.file_name().ok_or("Ungültiger Name")?.to_string_lossy().into_owned();
    let dir = root.join(&zone);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::copy(&src, library::unique_path(&dir, &name)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_fullscreen(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    root: String,
    name: String,
    zones: Vec<Zone>,
    items: Vec<Item>,
    /// Eigene Reihenfolge je Zone (Hashes), per Ziehen in der Zone gesetzt
    order: std::collections::HashMap<String, Vec<String>>,
    shared: bool,
    user: Option<String>,
    /// Zone für alles ohne Ziel (Standard: Inbox)
    default_zone: String,
    /// Zonentiefe und übersprungene Ordner
    structure: library::Structure,
    /// Alle Ordner unterhalb der Zonen, auch leere (0.27)
    folders: Vec<String>,
    /// Anzahl unter „Zuletzt gelöscht“
    deleted: usize,
}

#[tauri::command]
async fn set_structure(app: AppHandle, state: State<'_, AppState>, structure: library::Structure) -> Result<(), String> {
    let lib = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || lib.set_structure(&structure)).await.map_err(|e| e.to_string())??;
    let _ = app.emit("library-changed", ());
    kick_thumbs(&app);
    Ok(())
}

#[tauri::command]
async fn set_default_zone(app: AppHandle, state: State<'_, AppState>, zone: String) -> Result<(), String> {
    current(&state)?.set_default_zone(&zone)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
async fn snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let lib = current(&state)?;
    let user = lib.user.lock().unwrap().clone();
    Ok(Snapshot {
        root: lib.root.to_string_lossy().into_owned(),
        name: lib.root.file_name().and_then(|n| n.to_str()).unwrap_or("Archiver").to_string(),
        zones: lib.zones()?,
        items: lib.items()?,
        order: lib.item_order(),
        shared: lib.shared,
        user,
        default_zone: lib.default_zone(),
        structure: lib.structure(),
        folders: lib.folders(),
        deleted: lib.deleted_count(),
    })
}

// ---- Notiz, Rechte, geteilte Bibliothek, Reihenfolge, Paket, Moodboard (studio.rs) ----

#[tauri::command]
async fn set_note(app: AppHandle, state: State<'_, AppState>, hashes: Vec<String>, patch: studio::NotePatch) -> Result<(), String> {
    let lib = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || lib.set_note(&hashes, &patch)).await.map_err(|e| e.to_string())??;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
async fn set_quote(app: AppHandle, state: State<'_, AppState>, hash: String, quote: String) -> Result<(), String> {
    let lib = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || lib.set_quote(&hash, &quote)).await.map_err(|e| e.to_string())??;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
async fn set_item_order(state: State<'_, AppState>, zone: String, hashes: Vec<String>) -> Result<(), String> {
    current(&state)?.set_item_order(&zone, &hashes)
}

/// Name merken und die Bibliothek als geteilt markieren (oder zurück).
/// Wechselt der Modus, öffnet die App die Bibliothek neu: die Datenbank zieht
/// dabei vom Bibliotheksordner auf den Mac (geteilt) bzw. zurück.
#[tauri::command]
async fn set_sharing(app: AppHandle, state: State<'_, AppState>, shared: bool, user: Option<String>) -> Result<(), String> {
    let user = user.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    let settings = load_settings(&app);
    save_settings(&app, &Settings { user: user.clone(), ..settings })?;
    let lib = current(&state)?;
    lib.set_user(user);
    if lib.shared == shared {
        return Ok(());
    }
    let root = lib.root.clone();
    // Aktuellen Stand sichern, damit die neue Datenbank ihn wiederfindet
    lib.write_metadata_to(&lib.metadata_path())?;
    if shared {
        lib.write_metadata_to(&lib.person_file())?;
    }
    studio::set_shared(&root, shared)?;
    drop(lib);
    activate(&app, &root)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

/// Zone oder Auswahl als Paket: Ordner wählen, Dateien, Quellen.csv/.md und
/// Kontaktbogen hineinlegen, dann im Finder zeigen.
#[tauri::command]
async fn export_package(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    title: String,
    meta: String,
    sheet: bool,
) -> Result<Option<studio::PackageReport>, String> {
    let lib = current(&state)?;
    let mut dialog = app.dialog().file();
    if let Some(dir) = dirs::desktop_dir() {
        dialog = dialog.set_directory(dir);
    }
    let Some(dest) = dialog.blocking_pick_folder().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let report = tauri::async_runtime::spawn_blocking(move || lib.export_package(&paths, &title, &meta, &dest, sheet))
        .await
        .map_err(|e| e.to_string())??;
    let _ = app.opener().reveal_item_in_dir(&report.path);
    Ok(Some(report))
}

#[tauri::command]
async fn export_moodboard(app: AppHandle, title: String, meta: String, file_name: String, board: pdf::Board) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().add_filter("PDF", &["pdf"]).set_file_name(&file_name);
    if let Some(dir) = dirs::download_dir() {
        dialog = dialog.set_directory(dir);
    }
    let Some(path) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&target, pdf::moodboard(&title, &meta, &board)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn move_items(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, zone: String, exact: Option<bool>) -> Result<Vec<String>, String> {
    let moved = current(&state)?.move_items_to(&paths, &zone, exact.unwrap_or(false))?;
    let _ = app.emit("library-changed", ());
    Ok(moved)
}

#[tauri::command]
async fn trash_items(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<(String, String)>, String> {
    let n = current(&state)?.trash_items(&paths)?;
    let _ = app.emit("library-changed", ());
    Ok(n)
}

#[tauri::command]
async fn create_folder(app: AppHandle, state: State<'_, AppState>, parent: String, name: String) -> Result<String, String> {
    let f = current(&state)?.create_folder(&parent, &name)?;
    let _ = app.emit("library-changed", ());
    Ok(f)
}

/// Notiz-Objekte (0.29)
#[tauri::command]
async fn create_note(app: AppHandle, state: State<'_, AppState>, dir: String, title: String) -> Result<String, String> {
    let p = current(&state)?.create_note(&dir, &title)?;
    let _ = app.emit("library-changed", ());
    Ok(p)
}

#[tauri::command]
async fn read_note(state: State<'_, AppState>, path: String) -> Result<String, String> {
    current(&state)?.read_note(&path)
}

#[derive(serde::Serialize)]
struct NoteSaved {
    path: String,
    hash: String,
}

#[tauri::command]
async fn write_note(app: AppHandle, state: State<'_, AppState>, path: String, text: String, rename: bool) -> Result<NoteSaved, String> {
    let (path, hash) = current(&state)?.write_note(&path, &text, rename)?;
    if rename {
        let _ = app.emit("library-changed", ());
    }
    Ok(NoteSaved { path, hash })
}

#[tauri::command]
async fn deleted_items(state: State<'_, AppState>) -> Result<Vec<library::DeletedItem>, String> {
    let lib = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || lib.deleted_items()).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn restore_deleted(app: AppHandle, state: State<'_, AppState>, files: Vec<String>) -> Result<usize, String> {
    let n = current(&state)?.restore_deleted(&files)?;
    let _ = app.emit("library-changed", ());
    kick_thumbs(&app);
    Ok(n)
}

#[tauri::command]
async fn remove_deleted(app: AppHandle, state: State<'_, AppState>, files: Vec<String>) -> Result<usize, String> {
    let n = current(&state)?.remove_deleted(&files)?;
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

#[tauri::command]
async fn move_folder(app: AppHandle, state: State<'_, AppState>, from: String, into: String) -> Result<String, String> {
    let p = current(&state)?.move_folder(&from, &into)?;
    let _ = app.emit("library-changed", ());
    Ok(p)
}

/// Deckkraft der Zonen beim Ziehen (App und Extension)
#[tauri::command]
async fn set_look(state: State<'_, AppState>, radius: String, alpha: Option<f64>) -> Result<(), String> {
    current(&state)?.set_look(&radius, alpha)
}

/// Reihenfolge der Zonen und die vier Hot Zones (für die Extension)
#[tauri::command]
async fn set_zone_order(state: State<'_, AppState>, order: Vec<String>, hot: Vec<String>) -> Result<(), String> {
    current(&state)?.set_zone_order(&order, &hot)
}

#[tauri::command]
async fn restore_items(app: AppHandle, state: State<'_, AppState>, items: Vec<(String, String)>) -> Result<usize, String> {
    let n = current(&state)?.restore_items(&items)?;
    let _ = app.emit("library-changed", ());
    kick_thumbs(&app);
    Ok(n)
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
async fn drag_icon(state: State<'_, AppState>, hash: String, path: String, color: Option<String>) -> Result<Option<String>, String> {
    let lib = current(&state)?;
    Ok(match color {
        Some(c) => lib.color_icon(&c),
        None => lib.drag_icon(&hash, Path::new(&path)),
    })
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

/// Gesicherte Webseite einer Linkkarte (0.30.1), sonst None
#[tauri::command]
async fn web_archive(state: State<'_, AppState>, hash: String) -> Result<Option<String>, String> {
    Ok(current(&state)?.web_archive(&hash).map(|p| p.to_string_lossy().into_owned()))
}

/// MHTML öffnet Chrome; ohne Chrome das Standardprogramm
#[tauri::command]
async fn open_web_archive(app: AppHandle, state: State<'_, AppState>, hash: String) -> Result<(), String> {
    let path = current(&state)?.web_archive(&hash).ok_or("Keine gesicherte Seite")?;
    let path = path.to_string_lossy().into_owned();
    if app.opener().open_path(path.clone(), Some("Google Chrome")).is_err() {
        app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(())
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

// ---- Am ganzen Mac: Palette und Zonenleiste (system.rs) ----

#[tauri::command]
fn system_prefs(app: AppHandle) -> system::SystemPrefs {
    load_settings(&app).system
}

#[tauri::command]
fn set_system_prefs(app: AppHandle, prefs: system::SystemPrefs) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.system = prefs.clone();
    save_settings(&app, &s)?;
    system::apply(&app, &prefs)
}

/// Hell / Dunkel aus den Einstellungen: Fensterrahmen und Glas passend setzen.
/// Dunkel bleibt das HUD-Glas, Hell nimmt das helle Seitenleisten-Glas.
/// Ecke des Trays in Punkt, aus Einstellungen › Aussehen (0.28)
static TRAY_RADIUS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(12);

#[tauri::command]
fn set_appearance(window: tauri::WebviewWindow, light: bool, radius: Option<f64>) {
    let _ = window.set_theme(Some(if light { tauri::Theme::Light } else { tauri::Theme::Dark }));
    if let Some(r) = radius.filter(|_| window.label() == system::PALETTE) {
        TRAY_RADIUS.store(r.clamp(0.0, 24.0) as u32, std::sync::atomic::Ordering::Relaxed);
    }
    if window.label() == "main" || window.label() == system::PALETTE || window.label() == viewer::LABEL {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        let effect = if light { Effect::Sidebar } else { Effect::HudWindow };
        let radius = if window.label() == system::PALETTE { TRAY_RADIUS.load(std::sync::atomic::Ordering::Relaxed) as f64 } else { 0.0 };
        let mut fx = EffectsBuilder::new().effect(effect).state(EffectState::Active);
        if radius > 0.0 {
            fx = fx.radius(radius);
        }
        let _ = window.set_effects(fx.build());
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
        .plugin(system::shortcut_plugin())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Brücke zur Chrome-Extension anmelden (bei jedem Start, falls die App verschoben wurde).
            std::thread::spawn(bridge::install_manifests);
            // Die Bibliothek öffnet die Oberfläche selbst (open_library), damit das
            // Fenster sofort erscheint, auch wenn das Einlesen dauert.
            if let Some(path) = viewer::from_args() {
                viewer::open(&handle, path);
            }
            system::setup(&handle, &load_settings(&handle).system);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Das Hauptfenster wird beim Schließen nur ausgeblendet: Archiver läuft
            // weiter für Palette und Zonenleiste (system.rs), der Betrachter kann es
            // mit „In Archiver zeigen“ hervorholen, das Dock-Symbol ebenso. ⌘Q beendet.
            match event {
                tauri::WindowEvent::CloseRequested { api, .. }
                    if window.label() == "main" && (cfg!(target_os = "macos") || window.app_handle().get_webview_window(viewer::LABEL).is_some()) =>
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Focused(false) if window.label() == system::PALETTE => {
                    system::palette_blurred(window.app_handle());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_info,
            bridge_browsers,
            extension_status,
            pick_folder,
            pick_export_file,
            open_library,
            libraries,
            set_library_slot,
            open_demo,
            close_demo,
            demo_collect,
            set_fullscreen,
            snapshot,
            move_items,
            trash_items,
            restore_items,
            create_zone,
            create_folder,
            create_note,
            read_note,
            write_note,
            deleted_items,
            restore_deleted,
            remove_deleted,
            rename_zone,
            move_folder,
            set_zone_order,
            set_default_zone,
            set_structure,
            set_look,
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
            export_moodboard,
            export_package,
            set_note,
            set_quote,
            web_archive,
            open_web_archive,
            set_item_order,
            set_sharing,
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
            system::palette_hide,
            system::palette_ghost,
            system::palette_place,
            system_prefs,
            set_system_prefs,
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
                // Mit einem Bild gestartet (Finder): nur der Betrachter, nie das Hauptfenster
                #[cfg(target_os = "macos")]
                if macos::launched_with_documents() {
                    return;
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_guard() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(check_library(&home).unwrap_err(), "library-system");
        assert_eq!(check_library(Path::new("/")).unwrap_err(), "library-system");
        let dir = std::env::temp_dir().join(format!("archiver-guard-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".archiver")).unwrap();
        for i in 0..20 {
            std::fs::write(dir.join(format!("{i}.txt")), "x").unwrap();
        }
        assert!(check_library(&dir).is_ok());
        let big = dir.join("big");
        std::fs::create_dir_all(&big).unwrap();
        for i in 0..=LIBRARY_MAX_FILES {
            std::fs::write(big.join(format!("{i}")), "").unwrap();
        }
        assert_eq!(check_library(&dir).unwrap_err(), "library-large");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cloud_folders_allowed() {
        let home = dirs::home_dir().unwrap().canonicalize().unwrap();
        let drive = home.join("Library/CloudStorage/GoogleDrive-test/Meine Ablage");
        assert_eq!(cloud_depth(&drive), Some(2));
        assert_eq!(cloud_depth(&drive.join("Referenzen")), Some(3));
        assert_eq!(cloud_depth(&home.join("Library/Caches")), None);
    }

    #[test]
    fn slots_from_old_settings() {
        let s = Settings { library: Some("/x/Referenzen".into()), ..Default::default() };
        let slots = library_slots(&s);
        assert_eq!(slots.len(), 3);
        assert_eq!(slots[0].name, "Referenzen");
        assert!(slots[1].path.is_none());
    }
}
