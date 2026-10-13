// bridge.rs
// Brücke zur Chrome-Extension über Chrome Native Messaging.
//
// Chrome startet dasselbe Programm wie die App, nur mit der Herkunft der
// Extension als Argument ("chrome-extension://<id>/"). Dann öffnet sich kein
// Fenster: Das Programm liest Anfragen von stdin und antwortet auf stdout
// (je 4 Byte Länge + JSON), bis Chrome die Verbindung schließt.
//
// Damit Chrome das Programm findet, legt die App bei jedem Start eine kleine
// Manifest-Datei in den NativeMessagingHosts-Ordner jedes installierten
// Chromium-Browsers. Läuft die App nicht, funktioniert die Brücke trotzdem:
// Sie arbeitet direkt auf dem Bibliotheksordner. Eine laufende App bemerkt
// neue Dateien über ihren Ordner-Watcher.

use crate::library::{now_ms, Library, Source, Zone};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const HOST_NAME: &str = "app.archiver.bridge";
const APP_IDENTIFIER: &str = "app.archiver.desktop";
const LIST_LIMIT: usize = 500;

/// Erlaubte Extensions. Die erste ID ergibt sich aus dem "key" in
/// extension/manifest.json (entpackte Version). Die Chrome-Web-Store-ID kommt
/// in Phase 4 dazu.
const EXTENSION_IDS: &[&str] = &["gddcmkfpdfkpnieegdplpilmoodghgdd"];

/// Wurde das Programm von Chrome als Native-Messaging-Host gestartet?
pub fn is_host_invocation() -> bool {
    std::env::args().skip(1).any(|a| a.starts_with("chrome-extension://"))
}

// ---- Registrierung in Chrome ----

/// Ordner, in denen Chromium-Browser nach Native-Messaging-Hosts suchen
/// (nur die, deren Browser auf diesem Rechner installiert ist).
fn host_dirs() -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(base) = dirs::home_dir().map(|h| h.join("Library/Application Support")) {
        for (name, browser) in [
            ("Chrome", "Google/Chrome"),
            ("Chrome Beta", "Google/Chrome Beta"),
            ("Chrome Dev", "Google/Chrome Dev"),
            ("Chrome Canary", "Google/Chrome Canary"),
            ("Chromium", "Chromium"),
            ("Brave", "BraveSoftware/Brave-Browser"),
            ("Edge", "Microsoft Edge"),
            ("Vivaldi", "Vivaldi"),
            ("Arc", "Arc/User Data"),
        ] {
            let dir = base.join(browser);
            if dir.is_dir() {
                out.push((name, dir.join("NativeMessagingHosts")));
            }
        }
    }
    #[cfg(target_os = "linux")]
    if let Some(base) = dirs::config_dir() {
        for (name, browser) in [
            ("Chrome", "google-chrome"),
            ("Chrome Beta", "google-chrome-beta"),
            ("Chromium", "chromium"),
            ("Brave", "BraveSoftware/Brave-Browser"),
        ] {
            let dir = base.join(browser);
            if dir.is_dir() {
                out.push((name, dir.join("NativeMessagingHosts")));
            }
        }
    }
    out
}

/// Browser, für die die Brücke eingerichtet ist (Anzeige in den Einstellungen).
pub fn connected_browsers() -> Vec<String> {
    host_dirs()
        .into_iter()
        .filter(|(_, dir)| dir.join(format!("{HOST_NAME}.json")).is_file())
        .map(|(name, _)| name.to_string())
        .collect()
}

/// Schreibt das Host-Manifest für alle gefundenen Browser. Läuft bei jedem
/// App-Start, damit der Pfad auch nach dem Verschieben der App stimmt.
pub fn install_manifests() -> Vec<PathBuf> {
    let Ok(exe) = std::env::current_exe() else { return Vec::new() };
    let manifest = json!({
        "name": HOST_NAME,
        "description": "Archiver",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": EXTENSION_IDS.iter().map(|id| format!("chrome-extension://{id}/")).collect::<Vec<_>>(),
    });
    let text = serde_json::to_vec_pretty(&manifest).unwrap();
    let mut written = Vec::new();
    for (_, dir) in host_dirs() {
        let file = dir.join(format!("{HOST_NAME}.json"));
        if std::fs::read(&file).ok().as_deref() == Some(text.as_slice()) {
            written.push(file);
            continue;
        }
        if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&file, &text).is_ok() {
            written.push(file);
        }
    }
    written
}

// ---- Host ----

/// Bibliotheksordner aus den Einstellungen der App.
fn library_root() -> Option<PathBuf> {
    let root = PathBuf::from(app_settings()?.library?);
    root.is_dir().then_some(root)
}

/// Bibliothek für eine Anfrage: `library` (Pfad) nur, wenn sie in der App als
/// Bibliothek eingetragen ist (⇧ beim Ziehen in der Extension), sonst die aktive.
fn library_root_for(msg: &Value) -> Option<PathBuf> {
    if let Some(want) = str_arg(msg, "library") {
        let known = app_settings()
            .map(|s| s.libraries.iter().any(|l| l.path.as_deref() == Some(want)) || s.library.as_deref() == Some(want))
            .unwrap_or(false);
        let root = PathBuf::from(want);
        if known && root.is_dir() {
            return Some(root);
        }
    }
    library_root()
}

/// Alle Bibliotheken aus den Einstellungen, die es gibt, die aktive markiert.
fn library_list() -> Vec<Value> {
    let Some(s) = app_settings() else { return vec![] };
    let active = s.library.clone();
    let mut out: Vec<Value> = s
        .libraries
        .iter()
        .filter_map(|l| {
            let path = l.path.clone()?;
            if !Path::new(&path).is_dir() {
                return None;
            }
            let name = if l.name.trim().is_empty() {
                Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            } else {
                l.name.clone()
            };
            Some(json!({ "name": name, "path": path, "active": active.as_deref() == Some(path.as_str()) }))
        })
        .collect();
    if out.is_empty() {
        if let Some(root) = library_root() {
            let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            out.push(json!({ "name": name, "path": root.to_string_lossy(), "active": true }));
        }
    }
    out
}

#[derive(Deserialize, Default)]
struct LibrarySlotSetting {
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
struct AppSettings {
    library: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    libraries: Vec<LibrarySlotSetting>,
}

fn app_settings() -> Option<AppSettings> {
    let file = dirs::config_dir()?.join(APP_IDENTIFIER).join("settings.json");
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

fn read_message(input: &mut impl Read) -> Option<Value> {
    let mut len = [0u8; 4];
    input.read_exact(&mut len).ok()?;
    let len = u32::from_ne_bytes(len) as usize;
    let mut buf = vec![0u8; len];
    input.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn write_message(out: &mut impl Write, value: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).unwrap();
    out.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    out.write_all(&bytes)?;
    out.flush()
}

/// Hauptschleife im Host-Modus. Endet, wenn Chrome stdin schließt.
pub fn run_host() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    let mut lib: Vec<(PathBuf, Library)> = Vec::new();
    while let Some(msg) = read_message(&mut input) {
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let reply = match handle(&msg, &mut lib) {
            Ok(mut v) => {
                v["ok"] = json!(true);
                v
            }
            Err(e) => json!({ "ok": false, "error": e }),
        };
        let mut reply = reply;
        reply["id"] = id;
        if write_message(&mut output, &reply).is_err() {
            break;
        }
    }
}

/// Öffnet die Bibliothek der Anfrage bei Bedarf (aktive oder per ⇧ gewählte).
/// Geöffnete Bibliotheken bleiben offen, damit der Wechsel per ⇧ schnell ist.
fn library<'a>(slot: &'a mut Vec<(PathBuf, Library)>, msg: &Value) -> Result<&'a Library, String> {
    let root = library_root_for(msg).ok_or("Keine Bibliothek eingerichtet")?;
    let i = match slot.iter().position(|(r, _)| r == &root) {
        Some(i) => i,
        None => {
            slot.push((root.clone(), Library::open(&root)?));
            slot.len() - 1
        }
    };
    // Name für „abgelegt von“ kann sich in der App jederzeit ändern
    slot[i].1.set_user(app_settings().and_then(|s| s.user));
    Ok(&slot[i].1)
}

/// Ordner innerhalb der Zonen (bis zwei Ebenen tief) fürs Rechtsklickmenü der Extension.
fn zone_folders(lib: &Library, zones: &[Zone]) -> Result<Value, String> {
    let mut map = serde_json::Map::new();
    let mut sets: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> = Default::default();
    for item in lib.items()? {
        if !zones.iter().any(|z| z.path == item.zone) {
            continue;
        }
        let dir = item.path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        let Some(rest) = dir.strip_prefix(&format!("{}/", item.zone)) else { continue };
        let parts: Vec<&str> = rest.split('/').take(2).collect();
        let set = sets.entry(item.zone.clone()).or_default();
        set.insert(parts[0].to_string());
        if parts.len() > 1 {
            set.insert(format!("{}/{}", parts[0], parts[1]));
        }
    }
    for (zone, set) in sets {
        map.insert(zone, json!(set.into_iter().collect::<Vec<_>>()));
    }
    Ok(Value::Object(map))
}

/// Zonen wie in der App: ohne Bibliotheksordner selbst und ohne leere Elternordner.
fn visible_zones(zones: Vec<Zone>) -> Vec<Zone> {
    let paths: Vec<String> = zones.iter().map(|z| z.path.clone()).collect();
    zones
        .into_iter()
        .filter(|z| !z.path.is_empty())
        .filter(|z| z.count > 0 || !paths.iter().any(|p| p.starts_with(&format!("{}/", z.path))))
        .collect()
}

fn str_arg<'a>(msg: &'a Value, key: &str) -> Option<&'a str> {
    msg.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

fn handle(msg: &Value, slot: &mut Vec<(PathBuf, Library)>) -> Result<Value, String> {
    let cmd = str_arg(msg, "cmd").unwrap_or("");
    match cmd {
        "hello" => {
            let root = library_root();
            Ok(json!({
                "app": "Archiver",
                "version": env!("CARGO_PKG_VERSION"),
                "library": root.as_ref().map(|r| r.to_string_lossy().into_owned()),
                "name": root.as_ref().and_then(|r| r.file_name()).map(|n| n.to_string_lossy().into_owned()),
                "libraries": library_list(),
            }))
        }
        "zones" => {
            let lib = library(slot, msg)?;
            lib.scan()?;
            // Reihenfolge und Hot Zones aus der Übersicht der App
            let (order, hot) = lib.zone_order();
            let mut zones = visible_zones(lib.zones()?);
            let rank = |p: &str| order.iter().position(|o| o == p).unwrap_or(order.len());
            zones.sort_by_key(|z| rank(&z.path));
            let hot: Vec<&String> = hot.iter().filter(|h| zones.iter().any(|z| &z.path == *h)).collect();
            let folders = zone_folders(lib, &zones).unwrap_or(Value::Null);
            Ok(json!({
                "zones": zones,
                "hot": hot,
                "alpha": lib.drag_alpha(),
                "default": lib.default_zone(),
                "folders": folders,
                "libraries": library_list(),
            }))
        }
        "create_zone" => {
            let lib = library(slot, msg)?;
            let name = str_arg(msg, "name").ok_or("Name fehlt")?;
            Ok(json!({ "zone": lib.create_zone(name)? }))
        }
        "save" => {
            let lib = library(slot, msg)?;
            let file = PathBuf::from(str_arg(msg, "file").ok_or("Datei fehlt")?);
            let fallback = lib.default_zone();
            let zone = str_arg(msg, "zone").unwrap_or(&fallback);
            let source = Source {
                image_url: str_arg(msg, "imageUrl").filter(|u| u.starts_with("http")).map(String::from),
                page_url: str_arg(msg, "pageUrl").map(String::from),
                page_title: str_arg(msg, "pageTitle").map(String::from),
                captured_at: msg.get("capturedAt").and_then(|v| v.as_i64()).or_else(|| Some(now_ms())),
                quote: str_arg(msg, "quote").map(|q| q.chars().take(20_000).collect()),
            };
            let (path, duplicate) = lib.adopt_file(&file, str_arg(msg, "name"), zone, &source)?;
            remove_if_empty(file.parent());
            // Textkarte: Farbe, die schon beim Markieren gezeigt wurde; Bildtext der Seite (0.29)
            let tone = crate::studio::clean_tone(str_arg(msg, "tone"));
            let caption = str_arg(msg, "caption").map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
            if !duplicate && (tone.is_some() || caption.is_some()) {
                if let Ok((_, hash)) = lib.locate(&path) {
                    let patch = crate::studio::NotePatch { tone, caption, ..Default::default() };
                    let _ = lib.set_note(&[hash], &patch);
                }
            }
            Ok(json!({ "path": path, "duplicate": duplicate }))
        }
        "list" => {
            let lib = library(slot, msg)?;
            lib.scan()?;
            let fallback = lib.default_zone();
            let zone = str_arg(msg, "zone").unwrap_or(&fallback);
            let items: Vec<Value> = lib
                .items()?
                .into_iter()
                .filter(|i| i.zone == zone)
                .take(LIST_LIMIT)
                .map(|i| {
                    json!({
                        "path": i.path,
                        "hash": i.hash,
                        "filename": i.filename,
                        "imageUrl": i.image_url,
                        "pageUrl": i.page_url,
                        "pageTitle": i.page_title,
                        "ts": i.captured_at.unwrap_or(i.added_at),
                        "quote": i.quote.as_ref().map(|q| q.chars().take(400).collect::<String>()),
                        "tone": i.tone,
                    })
                })
                .collect();
            Ok(json!({ "items": items }))
        }
        "preview" => {
            let lib = library(slot, msg)?;
            let (abs, hash) = lib.locate(str_arg(msg, "path").ok_or("Pfad fehlt")?)?;
            let (mime, bytes) = lib.small_preview(&hash, &abs).ok_or("Keine Vorschau")?;
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            Ok(json!({ "hash": hash, "dataUrl": format!("data:{mime};base64,{data}") }))
        }
        "move" => {
            let lib = library(slot, msg)?;
            let paths: Vec<String> = msg
                .get("paths")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let zone = str_arg(msg, "zone").ok_or("Zone fehlt")?;
            Ok(json!({ "moved": lib.move_items(&paths, zone)? }))
        }
        "reveal" => {
            let lib = library(slot, msg)?;
            let (abs, _) = lib.locate(str_arg(msg, "path").ok_or("Pfad fehlt")?)?;
            reveal_in_finder(&abs);
            Ok(json!({}))
        }
        "open_app" => {
            open_app();
            Ok(json!({}))
        }
        other => Err(format!("Unbekannter Befehl: {other}")),
    }
}

/// Den Zwischenordner der Extension in den Downloads wieder entfernen, wenn er leer ist.
fn remove_if_empty(dir: Option<&Path>) {
    if let Some(dir) = dir {
        if dir.file_name().and_then(|n| n.to_str()) == Some(crate::library::TRANSFER_DIR) {
            let _ = std::fs::remove_dir(dir); // schlägt fehl, solange noch etwas drin liegt
        }
    }
}

/// Die App selbst öffnen: die Brücke läuft aus Archiver.app/Contents/MacOS.
fn open_app() {
    let Ok(exe) = std::env::current_exe() else { return };
    if let Some(bundle) = exe.ancestors().find(|p| p.extension().and_then(|e| e.to_str()) == Some("app")) {
        let _ = std::process::Command::new("open").arg(bundle).spawn();
    }
}

fn reveal_in_finder(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(not(target_os = "macos"))]
    let _ = std::process::Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_roundtrip() {
        let mut buf = Vec::new();
        write_message(&mut buf, &json!({ "cmd": "hello", "id": 1 })).unwrap();
        let back = read_message(&mut buf.as_slice()).unwrap();
        assert_eq!(back["cmd"], "hello");
    }

    #[test]
    fn hides_root_and_empty_parents() {
        let z = |p: &str, c| Zone { path: p.into(), name: p.into(), count: c };
        let out = visible_zones(vec![z("Inbox", 1), z("", 2), z("Kunden", 0), z("Kunden/A", 3), z("Leer", 0)]);
        let paths: Vec<_> = out.iter().map(|z| z.path.as_str()).collect();
        assert_eq!(paths, ["Inbox", "Kunden/A", "Leer"]);
    }
}
