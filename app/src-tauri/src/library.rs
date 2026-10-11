// library.rs
// Die Bibliothek: ein normaler Ordner auf der Festplatte. Jeder Unterordner ist
// eine Zone, jede Bilddatei ein Eintrag. Die Datenbank in .archiver/library.db
// ist nur Cache plus Metadaten (Quellen). Fehlt sie, entsteht sie beim nächsten
// Scan neu; die Quellen stehen zusätzlich in .archiver/metadata.json.
//
// Identität per Content-Hash: Quellen hängen am Hash, nicht am Pfad. Wird eine
// Datei im Finder umbenannt oder verschoben, findet der Scan sie über den Hash
// wieder und die Quelle bleibt erhalten.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

pub const META_DIR: &str = ".archiver";
pub const INBOX: &str = "Inbox";
/// Zwischenordner der Extension in den Downloads (wird nach der Übernahme geleert).
pub const TRANSFER_DIR: &str = "Archiver-Transfer";
const THUMB_SIZE: u32 = 720;
const DRAG_ICON_SIZE: u32 = 96;
const SMALL_THUMB_SIZE: u32 = 400; // Galerie der Extension
const RAW_PREVIEW_MAX_BYTES: u64 = 700 * 1024; // SVG & Co. gehen unverändert durch

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff", "svg", "heic", "heif",
];
// Formate, aus denen wir selbst Vorschaubilder rechnen können. Für die übrigen
// (SVG, AVIF, HEIC) zeigt die Oberfläche direkt das Original.
const THUMB_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"];
/// PDF und Video: Vorschau (Seite 1 bzw. ein Standbild) über Quick Look,
/// Seitenzahl, Dauer und Maße über PDFKit bzw. AVFoundation (macos.rs).
pub const PDF_EXTS: &[&str] = &["pdf"];
pub const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "webm"];
/// Audio: Vorschau ist das eingebettete Cover oder eine Wellenform,
/// Dauer, Titel und Format kommen aus AVFoundation (macos.rs).
pub const AUDIO_EXTS: &[&str] = &["wav", "mp3", "aif", "aiff", "m4a", "flac"];

pub type Result<T> = std::result::Result<T, String>;

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub path: String,
    pub name: String,
    pub count: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub abs: String,
    pub zone: String,
    pub filename: String,
    pub hash: String,
    pub bytes: i64,
    pub mtime: i64,
    pub added_at: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub format: String,
    pub thumb: Option<String>,
    pub image_url: Option<String>,
    pub page_url: Option<String>,
    pub page_title: Option<String>,
    pub captured_at: Option<i64>,
    /// Bildinhalt (Apple Vision), Leerzeichen-getrennt; leer, solange nicht analysiert.
    pub labels: Option<String>,
    /// Erkannter Text im Bild.
    pub text: Option<String>,
    /// Farbanteile, z. B. "red:0.42 black:0.30".
    pub colors: Option<String>,
    /// PDF: Anzahl der Seiten
    pub pages: Option<i64>,
    /// Video: Dauer in Sekunden
    pub duration: Option<f64>,
    /// Zitat-Karte: der gesicherte Text
    pub quote: Option<String>,
    /// Audio: Titel, Künstler, Album aus den Metadaten
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Audio: Abtastrate in Hz, Bittiefe (nur unkomprimiert), Kanäle
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    /// Notiz zum Objekt (das Warum einer Referenz)
    pub note: Option<String>,
    /// Rechte: Urheber, Lizenz, nur intern verwenden
    pub credit: Option<String>,
    pub license: Option<String>,
    pub internal: bool,
    /// Wer das Objekt abgelegt hat (geteilte Bibliothek)
    pub added_by: Option<String>,
    /// Farbe der Textkarte, falls gewählt
    pub tone: Option<String>,
}

/// Seitenzahl, Dauer und Maße eines PDFs oder Videos, bei Audio dazu Titel und Format.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MediaInfo {
    pub pages: Option<i64>,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
}

/// Ergebnis der Bildanalyse für ein Bild.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub hash: String,
    pub labels: String,
    pub text: String,
    pub colors: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub image_url: Option<String>,
    pub page_url: Option<String>,
    pub page_title: Option<String>,
    pub captured_at: Option<i64>,
    /// Zitat-Karten: der markierte Text, damit er sich kopieren lässt
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub duplicates: usize,
    pub missing: usize,
    pub with_source: usize,
}

pub struct Library {
    pub root: PathBuf,
    pub(crate) conn: Mutex<Connection>,
    scan_lock: Mutex<()>,
    failed_thumbs: Mutex<HashSet<String>>,
    /// Geteilte Bibliothek (Server, NAS, Dropbox): Datenbank liegt lokal,
    /// Angaben gehen über eine Datei pro Person in .archiver/people/.
    pub shared: bool,
    /// Name oder Kürzel dieser Person; wird bei neuen Objekten als „abgelegt von“ gemerkt.
    pub(crate) user: Mutex<Option<String>>,
    /// Stand der Personen-Dateien beim letzten Abgleich
    pub(crate) people_sig: Mutex<u64>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn time_ms(t: std::io::Result<SystemTime>) -> Option<i64> {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)
}

fn ext_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

pub fn is_image(path: &Path) -> bool {
    IMAGE_EXTS.contains(&ext_of(path).as_str())
}

pub fn is_pdf(path: &Path) -> bool {
    PDF_EXTS.contains(&ext_of(path).as_str())
}

pub fn is_video(path: &Path) -> bool {
    VIDEO_EXTS.contains(&ext_of(path).as_str())
}

pub fn is_audio(path: &Path) -> bool {
    AUDIO_EXTS.contains(&ext_of(path).as_str())
}

/// PDF, Video oder Audio: Vorschau und Eckdaten über macOS statt image
fn is_av(path: &Path) -> bool {
    is_pdf(path) || is_video(path) || is_audio(path)
}

/// Alles, was in die Bibliothek gehört: Bilder, PDFs, Videos, Audio.
pub fn is_media(path: &Path) -> bool {
    is_image(path) || is_pdf(path) || is_video(path) || is_audio(path)
}

/// Endung aus den ersten Bytes, wenn der Name keine passende hat (PDF, Video, Bild).
fn sniff_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF") {
        return Some("pdf");
    }
    if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        if &bytes[8..11] == b"M4A" {
            return Some("m4a");
        }
        return Some(if &bytes[8..10] == b"qt" { "mov" } else { "mp4" });
    }
    if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        return Some("wav");
    }
    if bytes.len() > 12 && bytes.starts_with(b"FORM") && (&bytes[8..12] == b"AIFF" || &bytes[8..12] == b"AIFC") {
        return Some("aif");
    }
    if bytes.starts_with(b"fLaC") {
        return Some("flac");
    }
    if bytes.starts_with(b"ID3") || (bytes.len() > 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0 && (bytes[1] & 0x06) != 0) {
        return Some("mp3");
    }
    if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some("webm");
    }
    image::guess_format(bytes).ok().and_then(|f| f.extensions_str().first().copied())
}

// ---- Platzhalter (Audio ohne Cover) ----

/// Ein Bild für alle Tracks ohne Cover: dunkle Fläche, feiner Ring mit
/// Mittelpunkt wie eine Platte (600 × 600). Gleiche Farben wie der
/// Platzhalter in media.js.
fn audio_placeholder() -> image::RgbImage {
    let n = 600u32;
    let bg = [42.0f32, 42.0, 42.0];
    let fg = [140.0f32, 140.0, 140.0];
    let c = n as f32 / 2.0;
    let (ring, stroke, dot) = (n as f32 * 0.3, 1.6f32, n as f32 * 0.022);
    image::RgbImage::from_fn(n, n, |x, y| {
        let d = ((x as f32 + 0.5 - c).powi(2) + (y as f32 + 0.5 - c).powi(2)).sqrt();
        // Kantenglättung über den Abstand zur Linie bzw. zum Punkt
        let a_ring = (stroke / 2.0 + 0.5 - (d - ring).abs()).clamp(0.0, 1.0);
        let a_dot = (dot + 0.5 - d).clamp(0.0, 1.0);
        let a = a_ring.max(a_dot);
        image::Rgb([0, 1, 2].map(|i| (bg[i] + (fg[i] - bg[i]) * a).round() as u8))
    })
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_str().map(|s| s.starts_with('.')).unwrap_or(false)
}

/// Relativer Pfad mit "/" als Trenner, "" für den Bibliotheksordner selbst.
fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str().map(String::from),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn parent_rel(rel: &str) -> String {
    rel.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default()
}

fn file_name(rel: &str) -> String {
    rel.rsplit_once('/').map(|(_, f)| f.to_string()).unwrap_or_else(|| rel.to_string())
}

/// Prüft einen relativen Pfad aus der Oberfläche: keine "..", keine absoluten
/// Pfade, nichts Verstecktes. Gibt den absoluten Pfad in der Bibliothek zurück.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    let mut out = root.to_path_buf();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if seg == "." || seg == ".." || seg.starts_with('.') || seg.contains('\\') {
            return Err(format!("Ungültiger Pfad: {rel}"));
        }
        out.push(seg);
    }
    Ok(out)
}

/// Zonen- bzw. Ordnernamen bereinigen (wie in der Extension).
pub fn clean_segment(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim().to_string();
    cleaned.chars().take(120).collect()
}

/// Freier Dateiname im Zielordner: "bild.jpg", "bild 2.jpg", "bild 3.jpg" …
pub(crate) fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(filename);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = p.extension().and_then(|s| s.to_str());
    for n in 2.. {
        let name = match ext {
            Some(e) => format!("{stem} {n}.{e}"),
            None => format!("{stem} {n}"),
        };
        let c = dir.join(name);
        if !c.exists() {
            return c;
        }
    }
    unreachable!()
}

/// Dateiname für ein übernommenes Bild: Wunschname bzw. Name der Datei,
/// bereinigt und bei Bedarf mit passender Endung (z. B. "bild" → "bild.webp").
fn image_file_name(src: &Path, wanted: Option<&str>) -> String {
    let base = wanted
        .map(clean_segment)
        .filter(|n| !n.is_empty())
        .or_else(|| src.file_name().and_then(|n| n.to_str()).map(clean_segment))
        .unwrap_or_else(|| "image".into());
    let mut head = vec![0u8; 64];
    let n = fs::File::open(src).and_then(|mut f| std::io::Read::read(&mut f, &mut head)).unwrap_or(0);
    let sniffed = sniff_ext(&head[..n]);
    // Passende Endung behalten; ein PDF oder Video mit Bild-Endung (z. B. aus
    // einer Download-Adresse ohne Endung) bekommt die richtige.
    let named = Path::new(&base);
    let fits = match sniffed {
        Some("pdf") => is_pdf(named),
        Some("mp4" | "mov" | "webm") => is_video(named),
        Some("wav" | "aif" | "flac" | "mp3" | "m4a") => is_audio(named),
        _ => is_media(named),
    };
    if fits {
        return base;
    }
    let ext = sniffed.unwrap_or("jpg");
    if is_media(named) {
        return named.with_extension(ext).to_string_lossy().into_owned();
    }
    format!("{base}.{ext}")
}

/// Farbanteile eines Bildes in groben, benannten Farben (Anteil ≥ 8 %),
/// größter zuerst, z. B. "blue:0.46 white:0.31".
pub fn color_shares(path: &Path) -> Option<String> {
    let img = image::open(path).ok()?.thumbnail(64, 64).to_rgba8();
    let mut counts: HashMap<&'static str, u32> = HashMap::new();
    let mut total = 0u32;
    for p in img.pixels() {
        if p[3] < 128 {
            continue;
        }
        *counts.entry(color_name(p[0], p[1], p[2])).or_default() += 1;
        total += 1;
    }
    if total == 0 {
        return Some(String::new());
    }
    let mut list: Vec<_> = counts.into_iter().map(|(n, c)| (n, c as f32 / total as f32)).filter(|(_, f)| *f >= 0.08).collect();
    list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    Some(list.iter().map(|(n, f)| format!("{n}:{f:.2}")).collect::<Vec<_>>().join(" "))
}

/// Grobe Farbklasse eines Pixels über Helligkeit, Sättigung und Farbton.
pub fn color_name(r: u8, g: u8, b: u8) -> &'static str {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    let s = if d == 0.0 { 0.0 } else { d / (1.0 - (2.0 * l - 1.0).abs()) };
    if l < 0.13 {
        return "black";
    }
    if l > 0.9 && s < 0.5 {
        return "white";
    }
    if s < 0.16 || d < 0.07 {
        return if l > 0.75 { "white" } else { "gray" };
    }
    let mut h = if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    if h < 0.0 {
        h += 360.0;
    }
    match h {
        h if h < 15.0 || h >= 340.0 => {
            if l < 0.4 && s < 0.6 { "brown" } else { "red" }
        }
        h if h < 45.0 => {
            if l < 0.45 { "brown" } else { "orange" }
        }
        h if h < 70.0 => {
            if l < 0.35 { "brown" } else { "yellow" }
        }
        h if h < 165.0 => "green",
        h if h < 195.0 => "teal",
        h if h < 255.0 => "blue",
        h if h < 290.0 => "purple",
        _ => "pink",
    }
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut hasher = blake3::Hasher::new();
    let mut f = fs::File::open(path).map_err(err)?;
    std::io::copy(&mut f, &mut hasher).map_err(err)?;
    Ok(hasher.finalize().to_hex()[..32].to_string())
}

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS item (
  path     TEXT PRIMARY KEY,
  hash     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  mtime    INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  width    INTEGER,
  height   INTEGER,
  format   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS item_hash ON item(hash);
CREATE TABLE IF NOT EXISTS source (
  hash        TEXT PRIMARY KEY,
  image_url   TEXT,
  page_url    TEXT,
  page_title  TEXT,
  captured_at INTEGER
);
CREATE TABLE IF NOT EXISTS thumb (
  hash TEXT PRIMARY KEY,
  file TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  hash        TEXT PRIMARY KEY,
  pages       INTEGER,
  duration    REAL,
  width       INTEGER,
  height      INTEGER,
  title       TEXT,
  artist      TEXT,
  album       TEXT,
  sample_rate INTEGER,
  bit_depth   INTEGER,
  channels    INTEGER
);
CREATE TABLE IF NOT EXISTS analysis (
  hash   TEXT PRIMARY KEY,
  labels TEXT NOT NULL,
  text   TEXT NOT NULL,
  colors TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note (
  hash       TEXT PRIMARY KEY,
  note       TEXT,
  credit     TEXT,
  license    TEXT,
  internal   INTEGER,
  added_by   TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  tone       TEXT
);
";

impl Library {
    /// Öffnet (und legt bei Bedarf an) eine Bibliothek in `root`.
    pub fn open(root: &Path) -> Result<Library> {
        fs::create_dir_all(root.join(META_DIR).join("thumbs")).map_err(err)?;
        fs::create_dir_all(root.join(INBOX)).map_err(err)?;
        let shared = crate::studio::is_shared(root);
        // Geteilt: SQLite gehört nicht auf ein Netzlaufwerk, jede Person hat ihren eigenen Cache.
        let db = if shared { crate::studio::local_db(root)? } else { root.join(META_DIR).join("library.db") };
        let conn = Connection::open(db).map_err(err)?;
        // Die Brücke zur Extension öffnet dieselbe Datenbank parallel zur App.
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;").map_err(err)?;
        conn.execute_batch(SCHEMA).map_err(err)?;
        // ab 0.9: Text der Zitat-Karten (ältere Datenbanken bekommen die Spalte nachgereicht)
        let _ = conn.execute("ALTER TABLE source ADD COLUMN quote TEXT", []);
        // ab 0.20.1: Farbe der Textkarten
        let _ = conn.execute("ALTER TABLE note ADD COLUMN tone TEXT", []);
        // ab 0.12: Audio-Eckdaten (ältere Datenbanken bekommen die Spalten nachgereicht)
        for col in ["title TEXT", "artist TEXT", "album TEXT", "sample_rate INTEGER", "bit_depth INTEGER", "channels INTEGER"] {
            let _ = conn.execute(&format!("ALTER TABLE media ADD COLUMN {col}"), []);
        }
        // ab 0.10: PDF-Vorschauen ohne hellen Rand neu rechnen (einmalig, user_version 1)
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
        if version < 1 {
            let _ = conn.execute("DELETE FROM thumb WHERE hash IN (SELECT hash FROM media WHERE pages IS NOT NULL)", []);
            let _ = conn.execute_batch("PRAGMA user_version = 1;");
        }
        // ab 0.13.1: Audio ohne Cover bekommt den Platzhalter statt der Wellenform
        if version < 2 {
            let _ = conn.execute("DELETE FROM thumb WHERE hash IN (SELECT hash FROM media WHERE sample_rate IS NOT NULL OR title IS NOT NULL)", []);
            let _ = conn.execute_batch("PRAGMA user_version = 2;");
        }
        let lib = Library {
            root: root.to_path_buf(),
            conn: Mutex::new(conn),
            scan_lock: Mutex::new(()),
            failed_thumbs: Mutex::new(HashSet::new()),
            shared,
            user: Mutex::new(None),
            people_sig: Mutex::new(0),
        };
        lib.restore_metadata()?;
        lib.merge_people()?;
        Ok(lib)
    }

    pub(crate) fn metadata_path(&self) -> PathBuf {
        self.root.join(META_DIR).join("metadata.json")
    }

    fn zone_order_path(&self) -> PathBuf {
        self.root.join(META_DIR).join("zones.json")
    }

    /// Reihenfolge der Zonen und die vier Hot Zones aus der Übersicht der App.
    /// Liegt in der Bibliothek, damit die Extension (über die Bridge) dieselben
    /// Zonen zeigt. Fehlt die Datei, sind beide Listen leer.
    pub fn zone_order(&self) -> (Vec<String>, Vec<String>) {
        let v: serde_json::Value = fs::read(self.zone_order_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let list = |key: &str| -> Vec<String> {
            v.get(key)
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        (list("order"), list("hot"))
    }

    /// Speichert Reihenfolge und Hot Zones; schreibt nur bei Änderung.
    /// Weitere Schlüssel in zones.json (z. B. "alpha") bleiben erhalten.
    pub fn set_zone_order(&self, order: &[String], hot: &[String]) -> Result<()> {
        if self.zone_order() == (order.to_vec(), hot.to_vec()) {
            return Ok(());
        }
        let mut v = self.zone_file();
        v["order"] = serde_json::json!(order);
        v["hot"] = serde_json::json!(hot);
        self.write_zone_file(&v)
    }

    /// Deckkraft der Zonen beim Ziehen (0.3–1.0), gilt in App und Extension.
    pub fn drag_alpha(&self) -> Option<f64> {
        self.zone_file().get("alpha").and_then(|a| a.as_f64())
    }

    pub fn set_drag_alpha(&self, alpha: f64) -> Result<()> {
        let mut v = self.zone_file();
        v["alpha"] = serde_json::json!(alpha.clamp(0.3, 1.0));
        self.write_zone_file(&v)
    }

    pub(crate) fn zone_file(&self) -> serde_json::Value {
        let v: serde_json::Value = fs::read(self.zone_order_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if v.is_object() {
            v
        } else {
            serde_json::json!({})
        }
    }

    pub(crate) fn write_zone_file(&self, v: &serde_json::Value) -> Result<()> {
        let body = serde_json::to_vec_pretty(v).map_err(err)?;
        fs::write(self.zone_order_path(), body).map_err(err)
    }

    fn thumbs_dir(&self) -> PathBuf {
        self.root.join(META_DIR).join("thumbs")
    }

    /// Neue oder geleerte Datenbank: Quellen aus metadata.json zurückholen.
    /// Notizen und Rechte werden immer abgeglichen (neuere gewinnt).
    fn restore_metadata(&self) -> Result<()> {
        let Ok(text) = fs::read_to_string(self.metadata_path()) else { return Ok(()) };
        let Ok(meta) = serde_json::from_str::<crate::studio::MetaDoc>(&text) else { return Ok(()) };
        self.merge_notes(&meta.notes)?;
        // Fehlende Quellen ergänzen (z. B. nach dem Wechsel zurück von einer geteilten Bibliothek)
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        for (hash, s) in meta.sources {
            tx.execute(
                "INSERT INTO source (hash, image_url, page_url, page_title, captured_at, quote) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(hash) DO UPDATE SET
                   image_url = COALESCE(source.image_url, ?2),
                   page_url = COALESCE(source.page_url, ?3),
                   page_title = COALESCE(source.page_title, ?4),
                   captured_at = COALESCE(source.captured_at, ?5),
                   quote = COALESCE(source.quote, ?6)",
                params![hash, s.image_url, s.page_url, s.page_title, s.captured_at, s.quote],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    /// Schreibt alle Quellen nach .archiver/metadata.json, damit nichts an der DB hängt.
    /// Geteilt: in die eigene Datei unter .archiver/people/.
    pub fn write_metadata(&self) -> Result<()> {
        let target = if self.shared { self.person_file() } else { self.metadata_path() };
        self.write_metadata_to(&target)
    }

    /// Wie write_metadata, aber in eine bestimmte Datei (Wechsel geteilt ↔ allein).
    pub fn write_metadata_to(&self, target: &Path) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT hash, image_url, page_url, page_title, captured_at, quote FROM source ORDER BY hash")
            .map_err(err)?;
        let mut sources = serde_json::Map::new();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Source {
                        image_url: r.get(1)?,
                        page_url: r.get(2)?,
                        page_title: r.get(3)?,
                        captured_at: r.get(4)?,
                        quote: r.get(5)?,
                    },
                ))
            })
            .map_err(err)?;
        for row in rows {
            let (hash, s) = row.map_err(err)?;
            sources.insert(hash, serde_json::to_value(s).map_err(err)?);
        }
        drop(stmt);
        drop(conn);
        let notes = self.all_notes()?;
        let doc = serde_json::json!({ "version": 1, "sources": sources, "notes": notes });
        // Geteilt: jede Person schreibt nur ihre eigene Datei, so überschreibt niemand den anderen.
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir).map_err(err)?;
        }
        let tmp = target.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&doc).map_err(err)?).map_err(err)?;
        fs::rename(tmp, target).map_err(err)?;
        if self.shared {
            *self.people_sig.lock().unwrap() = self.people_signature();
        }
        Ok(())
    }

    /// Gleicht die Datenbank mit dem Ordner ab. Gibt true zurück, wenn sich etwas geändert hat.
    /// Gehasht werden nur neue oder veränderte Dateien (Größe oder Änderungsdatum anders).
    pub fn scan(&self) -> Result<bool> {
        let _guard = self.scan_lock.lock().unwrap();
        let known: HashMap<String, (i64, i64)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT path, bytes, mtime FROM item").map_err(err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))
                .map_err(err)?;
            rows.collect::<std::result::Result<_, _>>().map_err(err)?
        };

        let mut seen = HashSet::new();
        let mut changed = false;
        let walker = WalkDir::new(&self.root)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| !is_hidden(e.file_name()));
        for entry in walker.filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() || !is_media(entry.path()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let rel = rel_path(&self.root, entry.path());
            let bytes = meta.len() as i64;
            let mtime = time_ms(meta.modified()).unwrap_or(0);
            seen.insert(rel.clone());
            if known.get(&rel) == Some(&(bytes, mtime)) {
                continue;
            }
            let Ok(hash) = hash_file(entry.path()) else { continue };
            let added = time_ms(meta.created()).unwrap_or(mtime);
            self.upsert_item(&rel, &hash, bytes, mtime, added, entry.path())?;
            changed = true;
        }

        let gone: Vec<&String> = known.keys().filter(|p| !seen.contains(*p)).collect();
        if !gone.is_empty() {
            let conn = self.conn.lock().unwrap();
            for p in gone {
                conn.execute("DELETE FROM item WHERE path = ?1", params![p]).map_err(err)?;
            }
            changed = true;
        }
        // Geteilt: Angaben der anderen übernehmen, sobald sich ihre Dateien ändern
        if self.merge_people()? {
            changed = true;
        }
        Ok(changed)
    }

    fn upsert_item(&self, rel: &str, hash: &str, bytes: i64, mtime: i64, added: i64, abs: &Path) -> Result<()> {
        let (w, h) = match image::image_dimensions(abs) {
            Ok((w, h)) => (Some(w as i64), Some(h as i64)),
            Err(_) => (None, None),
        };
        let format = ext_of(abs);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO item (path, hash, bytes, mtime, added_at, width, height, format)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(path) DO UPDATE SET hash=?2, bytes=?3, mtime=?4, width=?6, height=?7, format=?8",
            params![rel, hash, bytes, mtime, added, w, h, format],
        )
        .map_err(err)?;
        Ok(())
    }

    /// Kurzer Fingerabdruck des Bestands (Anzahl, Pfade, Quellen), um Änderungen
    /// von außen zu bemerken, die schon in der Datenbank stehen.
    pub fn signature(&self) -> (i64, i64, i64, i64) {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM item), (SELECT TOTAL(LENGTH(path)) FROM item),
                    (SELECT TOTAL(mtime % 1000003) FROM item),
                    (SELECT COUNT(*) FROM source) + (SELECT TOTAL(updated_at % 1000003) FROM note)",
            [],
            |r| Ok((r.get(0)?, r.get::<_, f64>(1)? as i64, r.get::<_, f64>(2)? as i64, r.get::<_, f64>(3)? as i64)),
        )
        .unwrap_or_default()
    }

    /// Alle Zonen: jeder sichtbare Unterordner, Inbox zuerst, dann alphabetisch.
    /// Liegen Bilder direkt im Bibliotheksordner, gibt es zusätzlich die Zone "".
    pub fn zones(&self) -> Result<Vec<Zone>> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT path FROM item").map_err(err)?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
            for p in rows {
                *counts.entry(parent_rel(&p.map_err(err)?)).or_default() += 1;
            }
        }
        let mut zones: Vec<Zone> = WalkDir::new(&self.root)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| !is_hidden(e.file_name()))
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_dir())
            .map(|e| {
                let path = rel_path(&self.root, e.path());
                Zone { count: counts.get(&path).copied().unwrap_or(0), name: path.clone(), path }
            })
            .collect();
        zones.sort_by(|a, b| {
            let rank = |z: &Zone| if z.path == INBOX { 0 } else { 1 };
            rank(a).cmp(&rank(b)).then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
        });
        if let Some(&count) = counts.get("") {
            let name = self.root.file_name().and_then(|n| n.to_str()).unwrap_or("Archiver").to_string();
            zones.insert(1.min(zones.len()), Zone { path: String::new(), name, count });
        }
        Ok(zones)
    }

    /// Alle Einträge mit Quelle und Vorschaubild, neueste zuerst.
    pub fn items(&self) -> Result<Vec<Item>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT i.path, i.hash, i.bytes, i.mtime, i.added_at,
                        COALESCE(i.width, m.width), COALESCE(i.height, m.height), i.format,
                        s.image_url, s.page_url, s.page_title, s.captured_at, t.file,
                        a.labels, a.text, a.colors, m.pages, m.duration, s.quote,
                        m.title, m.artist, m.album, m.sample_rate, m.bit_depth, m.channels,
                        n.note, n.credit, n.license, n.internal, n.added_by, n.tone
                 FROM item i
                 LEFT JOIN note n ON n.hash = i.hash
                 LEFT JOIN source s ON s.hash = i.hash
                 LEFT JOIN thumb t ON t.hash = i.hash
                 LEFT JOIN analysis a ON a.hash = i.hash
                 LEFT JOIN media m ON m.hash = i.hash
                 ORDER BY COALESCE(s.captured_at, i.added_at) DESC, i.path",
            )
            .map_err(err)?;
        let thumbs = self.thumbs_dir();
        let rows = stmt
            .query_map([], |r| {
                let path: String = r.get(0)?;
                let thumb: Option<String> = r.get(12)?;
                Ok(Item {
                    abs: self.root.join(&path).to_string_lossy().into_owned(),
                    zone: parent_rel(&path),
                    filename: file_name(&path),
                    hash: r.get(1)?,
                    bytes: r.get(2)?,
                    mtime: r.get(3)?,
                    added_at: r.get(4)?,
                    width: r.get(5)?,
                    height: r.get(6)?,
                    format: r.get(7)?,
                    image_url: r.get(8)?,
                    page_url: r.get(9)?,
                    page_title: r.get(10)?,
                    captured_at: r.get(11)?,
                    thumb: thumb.map(|f| thumbs.join(f).to_string_lossy().into_owned()),
                    labels: r.get(13)?,
                    text: r.get(14)?,
                    colors: r.get(15)?,
                    pages: r.get(16)?,
                    duration: r.get(17)?,
                    quote: r.get(18)?,
                    title: r.get(19)?,
                    artist: r.get(20)?,
                    album: r.get(21)?,
                    sample_rate: r.get(22)?,
                    bit_depth: r.get(23)?,
                    channels: r.get(24)?,
                    note: r.get(25)?,
                    credit: r.get(26)?,
                    license: r.get(27)?,
                    internal: r.get::<_, Option<i64>>(28)?.unwrap_or(0) != 0,
                    added_by: r.get(29)?,
                    tone: r.get(30)?,
                    path,
                })
            })
            .map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)
    }

    // ---- Vorschaubilder ----

    /// Einträge, für die noch ein Vorschaubild fehlt (je Hash einmal).
    pub fn missing_thumbs(&self) -> Result<Vec<(String, PathBuf)>> {
        let failed = self.failed_thumbs.lock().unwrap().clone();
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT i.hash, MIN(i.path), i.format FROM item i
                 LEFT JOIN thumb t ON t.hash = i.hash
                 WHERE t.hash IS NULL GROUP BY i.hash",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let (hash, path, format) = row.map_err(err)?;
            let media = PDF_EXTS.contains(&format.as_str())
                || VIDEO_EXTS.contains(&format.as_str())
                || AUDIO_EXTS.contains(&format.as_str());
            if (THUMB_EXTS.contains(&format.as_str()) || media) && !failed.contains(&hash) {
                out.push((hash, self.root.join(path)));
            }
        }
        Ok(out)
    }

    /// Rechnet ein Vorschaubild (max. 720 px, JPEG bzw. PNG bei Transparenz).
    pub fn make_thumb(&self, hash: &str, src: &Path) -> Option<String> {
        let result = (|| -> Result<String> {
            let img = if is_av(src) {
                let (img, info) = if is_audio(src) { self.audio_preview(src)? } else { self.media_preview(hash, src)? };
                let conn = self.conn.lock().unwrap();
                conn.execute(
                    "INSERT OR REPLACE INTO media (hash, pages, duration, width, height, title, artist, album, sample_rate, bit_depth, channels)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        hash,
                        info.pages,
                        info.duration,
                        info.width,
                        info.height,
                        info.title,
                        info.artist,
                        info.album,
                        info.sample_rate,
                        info.bit_depth,
                        info.channels
                    ],
                )
                .map_err(err)?;
                img
            } else {
                image::open(src).map_err(err)?
            };
            let small = if img.width() > THUMB_SIZE || img.height() > THUMB_SIZE {
                img.thumbnail(THUMB_SIZE, THUMB_SIZE)
            } else {
                img
            };
            let file = if small.color().has_alpha() {
                let name = format!("{hash}.png");
                small.to_rgba8().save(self.thumbs_dir().join(&name)).map_err(err)?;
                name
            } else {
                let name = format!("{hash}.jpg");
                let out = fs::File::create(self.thumbs_dir().join(&name)).map_err(err)?;
                let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(out), 82);
                enc.encode_image(&small.to_rgb8()).map_err(err)?;
                name
            };
            let conn = self.conn.lock().unwrap();
            conn.execute("INSERT OR REPLACE INTO thumb (hash, file) VALUES (?1, ?2)", params![hash, file])
                .map_err(err)?;
            Ok(self.thumbs_dir().join(file).to_string_lossy().into_owned())
        })();
        match result {
            Ok(p) => Some(p),
            Err(_) => {
                self.failed_thumbs.lock().unwrap().insert(hash.to_string());
                None
            }
        }
    }

    /// Audio: eingebettetes Cover, sonst der Standard-Platzhalter. Eckdaten aus AVFoundation.
    fn audio_preview(&self, src: &Path) -> Result<(image::DynamicImage, MediaInfo)> {
        #[cfg(target_os = "macos")]
        let (info, cover) = (crate::macos::media_info(src), crate::macos::audio_artwork(src));
        #[cfg(not(target_os = "macos"))]
        let (info, cover): (MediaInfo, Option<Vec<u8>>) = (MediaInfo::default(), None);
        if let Some(img) = cover.and_then(|b| image::load_from_memory(&b).ok()) {
            return Ok((img, info));
        }
        Ok((image::DynamicImage::ImageRgb8(audio_placeholder()), info))
    }

    /// Vorschau und Eckdaten eines PDFs oder Videos. Das Bild kommt von Quick Look
    /// (`qlmanage -t`, Seite 1 bzw. ein Standbild), die Eckdaten von macos.rs.
    fn media_preview(&self, hash: &str, src: &Path) -> Result<(image::DynamicImage, MediaInfo)> {
        let tmp = self.thumbs_dir().join(format!("ql-{hash}"));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).map_err(err)?;
        let result = (|| -> Result<(image::DynamicImage, MediaInfo)> {
            let mut child = std::process::Command::new("/usr/bin/qlmanage")
                .args(["-t", "-s", &THUMB_SIZE.to_string(), "-o"])
                .arg(&tmp)
                .arg(src)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(err)?;
            // Quick Look hängt selten, dann nach 30 s abbrechen
            let start = std::time::Instant::now();
            loop {
                if child.try_wait().map_err(err)?.is_some() {
                    break;
                }
                if start.elapsed() > std::time::Duration::from_secs(30) {
                    let _ = child.kill();
                    return Err("Quick Look antwortet nicht".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let png = fs::read_dir(&tmp)
                .map_err(err)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .find(|p| ext_of(p) == "png")
                .ok_or("Keine Vorschau")?;
            let mut img = image::open(&png).map_err(err)?;
            // Quick Look zeichnet PDF-Seiten mit hellem Randpixel: 2 px rundum abschneiden
            if is_pdf(src) && img.width() > 40 && img.height() > 40 {
                img = img.crop_imm(2, 2, img.width() - 4, img.height() - 4);
            }
            #[cfg(target_os = "macos")]
            let mut info = crate::macos::media_info(src);
            #[cfg(not(target_os = "macos"))]
            let mut info = MediaInfo::default();
            // Hochkant gedrehte Videos: Maße an der Vorschau ausrichten
            if let (Some(w), Some(h)) = (info.width, info.height) {
                if (w > h) != (img.width() > img.height()) && img.width() != img.height() {
                    info.width = Some(h);
                    info.height = Some(w);
                }
            } else {
                info.width = Some(img.width() as i64);
                info.height = Some(img.height() as i64);
            }
            Ok((img, info))
        })();
        let _ = fs::remove_dir_all(&tmp);
        result
    }

    // ---- Bildanalyse (Farben hier, Inhalt und Text über Apple Vision) ----

    /// Bilder mit Vorschau, aber noch ohne Analyse: (Hash, Vorschaudatei).
    pub fn missing_analysis(&self) -> Result<Vec<(String, PathBuf)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.hash, t.file FROM thumb t
                 LEFT JOIN analysis a ON a.hash = t.hash
                 WHERE a.hash IS NULL",
            )
            .map_err(err)?;
        let thumbs = self.thumbs_dir();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, thumbs.join(r.get::<_, String>(1)?))))
            .map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)
    }

    pub fn save_analysis(&self, a: &Analysis) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO analysis (hash, labels, text, colors) VALUES (?1, ?2, ?3, ?4)",
            params![a.hash, a.labels, a.text, a.colors],
        )
        .map_err(err)?;
        Ok(())
    }

    /// Vorschaubild eines Hashs, falls schon gerechnet.
    pub fn thumb_file(&self, hash: &str) -> Option<PathBuf> {
        let conn = self.conn.lock().unwrap();
        let file: Option<String> = conn
            .query_row("SELECT file FROM thumb WHERE hash = ?1", params![hash], |r| r.get(0))
            .optional()
            .ok()?;
        file.map(|f| self.thumbs_dir().join(f)).filter(|p| p.is_file())
    }

    /// Kleines Bild für den Drag-Cursor (max. 96 px), damit beim Ziehen die Zonen sichtbar bleiben.
    pub fn drag_icon(&self, hash: &str, src: &Path) -> Option<String> {
        let out = self.thumbs_dir().join(format!("{hash}-drag.png"));
        if !out.is_file() {
            let img = image::open(src).ok()?;
            img.thumbnail(DRAG_ICON_SIZE, DRAG_ICON_SIZE).to_rgba8().save(&out).ok()?;
        }
        Some(out.to_string_lossy().into_owned())
    }

    /// Kleines Vorschaubild für die Extension (max. 400 px) als (MIME-Typ, Bytes).
    /// Formate, die wir nicht selbst verkleinern können, gehen bis 700 KB unverändert durch.
    pub fn small_preview(&self, hash: &str, src: &Path) -> Option<(String, Vec<u8>)> {
        // PDF und Video: aus dem Vorschaubild (Seite 1 bzw. Standbild)
        let thumb;
        let src = if is_av(src) {
            thumb = self.thumb_file(hash)?;
            thumb.as_path()
        } else {
            src
        };
        let jpg = self.thumbs_dir().join(format!("{hash}-s.jpg"));
        let png = self.thumbs_dir().join(format!("{hash}-s.png"));
        for (path, mime) in [(&jpg, "image/jpeg"), (&png, "image/png")] {
            if let Ok(bytes) = fs::read(path) {
                return Some((mime.into(), bytes));
            }
        }
        if THUMB_EXTS.contains(&ext_of(src).as_str()) {
            if let Ok(img) = image::open(src) {
                let small = if img.width() > SMALL_THUMB_SIZE || img.height() > SMALL_THUMB_SIZE {
                    img.thumbnail(SMALL_THUMB_SIZE, SMALL_THUMB_SIZE)
                } else {
                    img
                };
                let saved = if small.color().has_alpha() {
                    small.to_rgba8().save(&png).ok().map(|_| (&png, "image/png"))
                } else {
                    fs::File::create(&jpg).ok().and_then(|f| {
                        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(f), 78);
                        enc.encode_image(&small.to_rgb8()).ok().map(|_| (&jpg, "image/jpeg"))
                    })
                };
                if let Some((path, mime)) = saved {
                    return fs::read(path).ok().map(|b| (mime.into(), b));
                }
            }
        }
        let size = fs::metadata(src).ok()?.len();
        if size > RAW_PREVIEW_MAX_BYTES {
            return None;
        }
        let mime = match ext_of(src).as_str() {
            "svg" => "image/svg+xml",
            "avif" => "image/avif",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/jpeg",
        };
        fs::read(src).ok().map(|b| (mime.into(), b))
    }

    /// Absoluter Pfad und Hash eines Eintrags (für Vorschau und Finder).
    pub fn locate(&self, rel: &str) -> Result<(PathBuf, String)> {
        let abs = safe_join(&self.root, rel)?;
        let conn = self.conn.lock().unwrap();
        let hash: Option<String> = conn
            .query_row("SELECT hash FROM item WHERE path = ?1", params![rel], |r| r.get(0))
            .optional()
            .map_err(err)?;
        drop(conn);
        let hash = match hash {
            Some(h) => h,
            None => hash_file(&abs)?,
        };
        Ok((abs, hash))
    }

    // ---- Sortieren ----

    /// Verschiebt Dateien in eine Zone. Gibt die neuen relativen Pfade zurück.
    pub fn move_items(&self, paths: &[String], zone: &str) -> Result<Vec<String>> {
        let target = safe_join(&self.root, zone)?;
        if !target.is_dir() {
            return Err(format!("Zone nicht gefunden: {zone}"));
        }
        let mut moved = Vec::new();
        for rel in paths {
            let src = safe_join(&self.root, rel)?;
            if parent_rel(rel) == zone || !src.is_file() {
                continue;
            }
            let dst = unique_path(&target, &file_name(rel));
            fs::rename(&src, &dst).map_err(err)?;
            let new_rel = rel_path(&self.root, &dst);
            let mtime = fs::metadata(&dst).ok().and_then(|m| time_ms(m.modified()));
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE item SET path = ?2, mtime = COALESCE(?3, mtime) WHERE path = ?1",
                params![rel, new_rel, mtime],
            )
            .map_err(err)?;
            moved.push(new_rel);
        }
        Ok(moved)
    }

    /// Legt Dateien in den macOS-Papierkorb (wiederherstellbar).
    pub fn trash_items(&self, paths: &[String]) -> Result<usize> {
        let abs: Vec<PathBuf> = paths
            .iter()
            .map(|p| safe_join(&self.root, p))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|p| p.is_file())
            .collect();
        if abs.is_empty() {
            return Ok(0);
        }
        trash::delete_all(&abs).map_err(err)?;
        let conn = self.conn.lock().unwrap();
        for p in paths {
            conn.execute("DELETE FROM item WHERE path = ?1", params![p]).map_err(err)?;
        }
        Ok(abs.len())
    }

    pub fn create_zone(&self, name: &str) -> Result<String> {
        let name = clean_segment(name);
        if name.is_empty() {
            return Err("Leerer Name".into());
        }
        let dir = unique_path(&self.root, &name);
        fs::create_dir(&dir).map_err(err)?;
        Ok(rel_path(&self.root, &dir))
    }

    pub fn rename_zone(&self, zone: &str, new_name: &str) -> Result<String> {
        if zone.is_empty() {
            return Err("Der Bibliotheksordner selbst lässt sich hier nicht umbenennen".into());
        }
        let name = clean_segment(new_name);
        if name.is_empty() {
            return Err("Leerer Name".into());
        }
        let src = safe_join(&self.root, zone)?;
        let parent = src.parent().unwrap_or(&self.root).to_path_buf();
        if src.file_name().and_then(|n| n.to_str()) == Some(name.as_str()) {
            return Ok(zone.to_string());
        }
        let dst = unique_path(&parent, &name);
        fs::rename(&src, &dst).map_err(err)?;
        let new_zone = rel_path(&self.root, &dst);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE item SET path = ?2 || substr(path, length(?1) + 1) WHERE path LIKE ?1 || '/%'",
            params![zone, new_zone],
        )
        .map_err(err)?;
        drop(conn);
        self.rename_item_order(zone, &new_zone)?;
        Ok(new_zone)
    }

    /// Legt eine Zone samt Inhalt in den Papierkorb. Inbox und Bibliotheksordner bleiben.
    pub fn trash_zone(&self, zone: &str) -> Result<()> {
        if zone.is_empty() || zone == INBOX {
            return Err("Diese Zone lässt sich nicht löschen".into());
        }
        let dir = safe_join(&self.root, zone)?;
        if !dir.is_dir() {
            return Err(format!("Zone nicht gefunden: {zone}"));
        }
        trash::delete(&dir).map_err(err)?;
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM item WHERE path LIKE ?1 || '/%'", params![zone]).map_err(err)?;
        Ok(())
    }

    // ---- Import ----

    /// Relativer Pfad einer Datei in der Bibliothek: direkt, wenn sie im
    /// Bibliotheksordner liegt, sonst über den Inhalt (gleiches Bild woanders).
    pub fn find_file(&self, src: &Path) -> Option<String> {
        if let Ok(rest) = src.strip_prefix(&self.root) {
            if !rest.as_os_str().is_empty() {
                return Some(rel_path(&self.root, src));
            }
        }
        let hash = hash_file(src).ok()?;
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT path FROM item WHERE hash = ?1 LIMIT 1", params![hash], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
    }

    fn hash_known(&self, hash: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1 FROM item WHERE hash = ?1 LIMIT 1", params![hash], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    /// Quelle eintragen. Vorhandene Angaben werden nur ergänzt, nicht überschrieben.
    pub fn set_source(&self, hash: &str, s: &Source) -> Result<bool> {
        if s.page_url.is_none() && s.image_url.is_none() {
            return Ok(false);
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO source (hash, image_url, page_url, page_title, captured_at, quote) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(hash) DO UPDATE SET
               image_url = COALESCE(source.image_url, ?2),
               page_url = COALESCE(source.page_url, ?3),
               page_title = COALESCE(source.page_title, ?4),
               captured_at = COALESCE(source.captured_at, ?5),
               quote = COALESCE(source.quote, ?6)",
            params![hash, s.image_url, s.page_url, s.page_title, s.captured_at, s.quote],
        )
        .map_err(err)?;
        Ok(true)
    }

    /// Kopiert eine Datei in eine Zone. Bereits vorhandene Bilder (gleicher Hash)
    /// werden nicht doppelt angelegt; ihre Quelle wird trotzdem ergänzt.
    fn import_one(&self, src: &Path, zone: &str, source: Option<&Source>, report: &mut ImportReport) -> Result<()> {
        if !src.is_file() {
            report.missing += 1;
            return Ok(());
        }
        let hash = hash_file(src)?;
        if let Some(s) = source {
            if self.set_source(&hash, s)? {
                report.with_source += 1;
            }
        }
        if self.hash_known(&hash) {
            report.duplicates += 1;
            return Ok(());
        }
        let dir = safe_join(&self.root, zone)?;
        fs::create_dir_all(&dir).map_err(err)?;
        let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("image");
        let dst = unique_path(&dir, name);
        fs::copy(src, &dst).map_err(err)?;
        let meta = fs::metadata(&dst).map_err(err)?;
        let mtime = time_ms(meta.modified()).unwrap_or(0);
        let added = source.and_then(|s| s.captured_at).unwrap_or_else(now_ms);
        self.upsert_item(&rel_path(&self.root, &dst), &hash, meta.len() as i64, mtime, added, &dst)?;
        self.mark_added_by(&hash)?;
        report.imported += 1;
        Ok(())
    }

    /// Übernimmt eine fertig geladene Datei aus der Extension: verschiebt sie in
    /// die Zone und merkt sich die Quelle. Ist das Bild schon in der Bibliothek,
    /// wird die neue Datei verworfen und der vorhandene Pfad zurückgegeben.
    pub fn adopt_file(&self, src: &Path, name: Option<&str>, zone: &str, source: &Source) -> Result<(String, bool)> {
        if !src.is_file() {
            return Err(format!("Datei nicht gefunden: {}", src.display()));
        }
        let hash = hash_file(src)?;
        self.set_source(&hash, source)?;
        let existing: Option<String> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row("SELECT path FROM item WHERE hash = ?1 ORDER BY path LIMIT 1", params![hash], |r| r.get(0))
                .optional()
                .map_err(err)?
        };
        if let Some(path) = existing {
            if self.root.join(&path).is_file() {
                let _ = fs::remove_file(src);
                self.write_metadata()?;
                return Ok((path, true));
            }
        }
        let dir = safe_join(&self.root, zone)?;
        fs::create_dir_all(&dir).map_err(err)?;
        let name = image_file_name(src, name);
        let dst = unique_path(&dir, &name);
        if fs::rename(src, &dst).is_err() {
            // anderes Volume: kopieren, dann Original entfernen
            fs::copy(src, &dst).map_err(err)?;
            let _ = fs::remove_file(src);
        }
        let meta = fs::metadata(&dst).map_err(err)?;
        let mtime = time_ms(meta.modified()).unwrap_or(0);
        let added = source.captured_at.unwrap_or_else(now_ms);
        let rel = rel_path(&self.root, &dst);
        self.upsert_item(&rel, &hash, meta.len() as i64, mtime, added, &dst)?;
        self.mark_added_by(&hash)?;
        self.write_metadata()?;
        Ok((rel, false))
    }

    /// Einzelne Dateien (z. B. aus dem Finder hereingezogen) in eine Zone kopieren.
    pub fn import_files(&self, files: &[PathBuf], zone: &str) -> Result<ImportReport> {
        let mut report = ImportReport::default();
        for f in files.iter().filter(|f| is_media(f)) {
            self.import_one(f, zone, None, &mut report)?;
        }
        if report.imported > 0 && self.user.lock().unwrap().is_some() {
            self.write_metadata()?;
        }
        Ok(report)
    }

    /// Einen ganzen Ordner übernehmen: Unterordner werden zu Zonen, lose Bilder landen in der Inbox.
    pub fn import_folder(&self, dir: &Path) -> Result<ImportReport> {
        let mut report = ImportReport::default();
        let walker = WalkDir::new(dir).min_depth(1).into_iter().filter_entry(|e| !is_hidden(e.file_name()));
        for entry in walker.filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() || !is_media(entry.path()) {
                continue;
            }
            let rel = rel_path(dir, entry.path());
            let zone = match parent_rel(&rel) {
                p if p.is_empty() => INBOX.to_string(),
                p => p.split('/').map(clean_segment).collect::<Vec<_>>().join("/"),
            };
            self.import_one(entry.path(), &zone, None, &mut report)?;
        }
        self.write_metadata()?;
        Ok(report)
    }

    /// Import aus der Extension: die Datei archiver-export.json (Einstellungen →
    /// „Für die App exportieren“) kennt Zone, Speicherort und Quelle jedes Bildes.
    pub fn import_extension_export(&self, json_path: &Path) -> Result<ImportReport> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ExportItem {
            zone: String,
            file: String,
            url: Option<String>,
            page_url: Option<String>,
            page_title: Option<String>,
            ts: Option<i64>,
        }
        #[derive(Deserialize)]
        struct Export {
            #[serde(default)]
            zones: Vec<String>,
            items: Vec<ExportItem>,
        }
        let text = fs::read_to_string(json_path).map_err(err)?;
        let export: Export = serde_json::from_str(&text).map_err(|e| format!("Keine gültige Export-Datei: {e}"))?;
        let zone_for = |z: &str| -> String {
            let cleaned = z.split('/').map(clean_segment).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/");
            if cleaned.is_empty() { INBOX.to_string() } else { cleaned }
        };
        for z in &export.zones {
            let _ = fs::create_dir_all(safe_join(&self.root, &zone_for(z))?);
        }
        let mut report = ImportReport::default();
        for it in &export.items {
            let source = Source {
                image_url: it.url.clone(),
                page_url: it.page_url.clone(),
                page_title: it.page_title.clone(),
                captured_at: it.ts,
                quote: None,
            };
            self.import_one(Path::new(&it.file), &zone_for(&it.zone), Some(&source), &mut report)?;
        }
        self.write_metadata()?;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn audio_sniff_and_placeholder() {
        let mut wav = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&[0; 16]);
        wav.extend_from_slice(b"data");
        let samples: Vec<i16> = vec![0, 1000, -2000, 500, 16000, -100, 0, 8000];
        wav.extend_from_slice(&((samples.len() * 2) as u32).to_le_bytes());
        for v in &samples {
            wav.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(sniff_ext(&wav), Some("wav"));
        assert_eq!(sniff_ext(b"FORM\0\0\0\0AIFFCOMM"), Some("aif"));
        assert_eq!(sniff_ext(b"ID3\x04\0\0\0\0\0\0\0\0"), Some("mp3"));
        assert_eq!(sniff_ext(b"fLaC\0\0\0\x22"), Some("flac"));
        assert_eq!(sniff_ext(b"\0\0\0\x20ftypM4A \0\0"), Some("m4a"));
        assert_eq!(sniff_ext(b"\0\0\0\x20ftypisom\0\0"), Some("mp4"));
        let img = audio_placeholder();
        assert_eq!((img.width(), img.height()), (600, 600));
        assert_eq!(img.get_pixel(0, 0).0, [42, 42, 42]);
        assert_eq!(img.get_pixel(300, 300).0, [140, 140, 140]);
        assert!(is_media(Path::new("a/Song.AIFF")) && is_audio(Path::new("b.flac")));
    }

    #[test]
    fn color_classes() {
        assert_eq!(color_name(220, 30, 40), "red");
        assert_eq!(color_name(30, 80, 220), "blue");
        assert_eq!(color_name(10, 10, 10), "black");
        assert_eq!(color_name(245, 245, 245), "white");
        assert_eq!(color_name(128, 128, 128), "gray");
        assert_eq!(color_name(120, 70, 30), "brown");
        assert_eq!(color_name(240, 200, 60), "yellow");
    }

    use super::*;

    fn write_png(path: &Path, w: u32, h: u32, shade: u8) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::RgbImage::from_pixel(w, h, image::Rgb([shade, 0, 0])).save(path).unwrap();
    }

    #[test]
    fn zone_order_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(&tmp.path().join("Bib")).unwrap();
        assert_eq!(lib.zone_order(), (vec![], vec![]));
        let order: Vec<String> = ["Typo", "Inbox", "Farbe"].map(String::from).to_vec();
        let hot: Vec<String> = order[..2].to_vec();
        lib.set_zone_order(&order, &hot).unwrap();
        assert_eq!(lib.zone_order(), (order, hot));
    }

    #[test]
    fn scan_zones_move_and_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Bib");
        let lib = Library::open(&root).unwrap();
        write_png(&root.join("Inbox/a.png"), 40, 20, 10);
        write_png(&root.join("Projekt 1/b.png"), 10, 30, 20);
        write_png(&root.join(".archiver/thumbs/ignore.png"), 2, 2, 1);
        assert!(lib.scan().unwrap());
        assert!(!lib.scan().unwrap(), "zweiter Scan ohne Änderung");

        let zones = lib.zones().unwrap();
        assert_eq!(zones.iter().map(|z| z.path.as_str()).collect::<Vec<_>>(), ["Inbox", "Projekt 1"]);
        assert_eq!(zones[0].count, 1);

        let items = lib.items().unwrap();
        assert_eq!(items.len(), 2);
        let a = items.iter().find(|i| i.filename == "a.png").unwrap();
        assert_eq!((a.width, a.height), (Some(40), Some(20)));

        // Quelle hängt am Hash und überlebt das Verschieben
        lib.set_source(&a.hash, &Source { page_url: Some("https://example.com/x".into()), ..Default::default() }).unwrap();
        let moved = lib.move_items(&["Inbox/a.png".into()], "Projekt 1").unwrap();
        assert_eq!(moved, ["Projekt 1/a.png"]);
        assert!(!lib.scan().unwrap(), "Verschieben hält die DB aktuell");
        let a2 = lib.items().unwrap().into_iter().find(|i| i.filename == "a.png").unwrap();
        assert_eq!(a2.zone, "Projekt 1");
        assert_eq!(a2.page_url.as_deref(), Some("https://example.com/x"));

        // Namenskonflikt beim Verschieben
        write_png(&root.join("Inbox/b.png"), 5, 5, 99);
        lib.scan().unwrap();
        let moved = lib.move_items(&["Inbox/b.png".into()], "Projekt 1").unwrap();
        assert_eq!(moved, ["Projekt 1/b 2.png"]);

        // Im Finder umbenannt: Scan findet die Quelle über den Hash wieder
        fs::rename(root.join("Projekt 1/a.png"), root.join("Projekt 1/umbenannt.png")).unwrap();
        assert!(lib.scan().unwrap());
        let r = lib.items().unwrap().into_iter().find(|i| i.filename == "umbenannt.png").unwrap();
        assert_eq!(r.page_url.as_deref(), Some("https://example.com/x"));

        // Zone umbenennen
        let z = lib.rename_zone("Projekt 1", "Kunde: A").unwrap();
        assert_eq!(z, "Kunde_ A");
        assert!(!lib.scan().unwrap());
        assert!(lib.items().unwrap().iter().all(|i| i.zone != "Projekt 1"));

        assert!(lib.move_items(&["../x.png".into()], "Inbox").is_err());
        assert!(lib.trash_zone("Inbox").is_err());
        assert!(lib.trash_zone("").is_err());
    }

    #[test]
    fn thumbs_and_metadata_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Bib");
        let lib = Library::open(&root).unwrap();
        write_png(&root.join("Inbox/gross.png"), 2000, 1000, 50);
        fs::write(root.join("Inbox/kaputt.jpg"), b"nope").unwrap();
        lib.scan().unwrap();
        let missing = lib.missing_thumbs().unwrap();
        assert_eq!(missing.len(), 2);
        let mut made = 0;
        for (hash, path) in missing {
            if let Some(t) = lib.make_thumb(&hash, &path) {
                let (w, h) = image::image_dimensions(&t).unwrap();
                assert_eq!((w, h), (720, 360));
                made += 1;
            }
        }
        assert_eq!(made, 1);
        let item = lib.items().unwrap().into_iter().find(|i| i.filename == "gross.png").unwrap();
        let icon = lib.drag_icon(&item.hash, Path::new(item.thumb.as_ref().unwrap())).unwrap();
        assert_eq!(image::image_dimensions(&icon).unwrap(), (96, 48));
        assert!(lib.missing_thumbs().unwrap().is_empty(), "kaputte Dateien nicht endlos neu versuchen");

        let hash = lib.items().unwrap()[0].hash.clone();
        lib.set_source(&hash, &Source { page_url: Some("https://a.b/".into()), ..Default::default() }).unwrap();
        lib.write_metadata().unwrap();
        drop(lib);
        fs::remove_file(root.join(".archiver/library.db")).unwrap();
        let _ = fs::remove_file(root.join(".archiver/library.db-wal"));
        let _ = fs::remove_file(root.join(".archiver/library.db-shm"));
        let lib = Library::open(&root).unwrap();
        lib.scan().unwrap();
        let item = lib.items().unwrap().into_iter().find(|i| i.hash == hash).unwrap();
        assert_eq!(item.page_url.as_deref(), Some("https://a.b/"));
    }

    #[test]
    fn import_export_and_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let downloads = tmp.path().join("Downloads");
        write_png(&downloads.join("Projekt 1/x.png"), 8, 8, 1);
        write_png(&downloads.join("lose.png"), 8, 8, 2);
        write_png(&downloads.join("Projekt 1/y.png"), 8, 8, 1); // Duplikat von x
        let export = serde_json::json!({
            "version": 1,
            "zones": ["Projekt 1", "Projekt 2", "Downloads"],
            "items": [
                { "zone": "Projekt 1", "file": downloads.join("Projekt 1/x.png"), "url": "https://cdn/x.png",
                  "pageUrl": "https://site/x", "pageTitle": "Seite X", "ts": 1700000000000i64 },
                { "zone": "", "file": downloads.join("lose.png"), "pageUrl": "https://site/l" },
                { "zone": "Projekt 1", "file": downloads.join("Projekt 1/fehlt.png") },
            ]
        });
        let json = tmp.path().join("archiver-export.json");
        fs::write(&json, export.to_string()).unwrap();

        let root = tmp.path().join("Bib");
        let lib = Library::open(&root).unwrap();
        let r = lib.import_extension_export(&json).unwrap();
        assert_eq!((r.imported, r.missing, r.with_source), (2, 1, 2));
        assert!(root.join("Projekt 2").is_dir());
        let items = lib.items().unwrap();
        let x = items.iter().find(|i| i.filename == "x.png").unwrap();
        assert_eq!(x.zone, "Projekt 1");
        assert_eq!(x.page_title.as_deref(), Some("Seite X"));
        assert_eq!(items.iter().find(|i| i.filename == "lose.png").unwrap().zone, "Inbox");
        assert!(root.join(".archiver/metadata.json").is_file());

        let r = lib.import_folder(&downloads).unwrap();
        assert_eq!((r.imported, r.duplicates), (0, 3));
        assert!(!lib.scan().unwrap(), "Import hält die DB aktuell");
    }

    #[test]
    fn adopt_from_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Bib");
        let lib = Library::open(&root).unwrap();
        let dl = tmp.path().join("Downloads/Archiver-Transfer");
        write_png(&dl.join("foto.png"), 900, 500, 30);
        let source = Source {
            image_url: Some("https://x.test/foto.png".into()),
            page_url: Some("https://x.test/".into()),
            page_title: Some("Seite".into()),
            captured_at: Some(5),
            quote: Some("Form folgt Funktion".into()),
        };
        let (rel, _) = lib.adopt_file(&dl.join("foto.png"), None, "Typo", &source).unwrap();
        assert_eq!(rel, "Typo/foto.png");
        assert!(!dl.join("foto.png").exists(), "Datei wurde verschoben");
        let item = lib.items().unwrap().into_iter().find(|i| i.path == rel).unwrap();
        assert_eq!(item.page_title.as_deref(), Some("Seite"));
        assert_eq!(item.quote.as_deref(), Some("Form folgt Funktion"));
        let meta = std::fs::read_to_string(root.join(META_DIR).join("metadata.json")).unwrap();
        assert!(meta.contains("Form folgt Funktion"), "Zitat steht auch in metadata.json");
        assert!(!lib.scan().unwrap(), "DB ist aktuell");

        // gleiches Bild nochmal: keine Kopie, vorhandener Pfad
        write_png(&dl.join("nochmal.png"), 900, 500, 30);
        assert_eq!(lib.adopt_file(&dl.join("nochmal.png"), None, "Inbox", &source).unwrap(), (rel.clone(), true));
        assert!(!dl.join("nochmal.png").exists());

        // ohne Endung (z. B. Download-ID als Name): Endung aus dem Inhalt
        image::RgbImage::from_pixel(30, 30, image::Rgb([90, 0, 0]))
            .save_with_format(dl.join("1234-abcd"), image::ImageFormat::Png)
            .unwrap();
        assert_eq!(lib.adopt_file(&dl.join("1234-abcd"), Some("wunsch"), "Inbox", &source).unwrap().0, "Inbox/wunsch.png");

        // PDF und Video ohne Endung: am Inhalt erkannt, als Eintrag gezählt
        std::fs::write(dl.join("dl-1"), b"%PDF-1.7\n%...").unwrap();
        assert_eq!(lib.adopt_file(&dl.join("dl-1"), Some("katalog"), "Inbox", &source).unwrap().0, "Inbox/katalog.pdf");
        std::fs::write(dl.join("dl-2"), b"\0\0\0\x18ftypisom\0\0\x02\0isomiso2").unwrap();
        assert_eq!(lib.adopt_file(&dl.join("dl-2"), Some("clip"), "Inbox", &source).unwrap().0, "Inbox/clip.mp4");
        std::fs::write(dl.join("dl-3"), b"%PDF-1.4\n").unwrap();
        assert_eq!(lib.adopt_file(&dl.join("dl-3"), Some("download.jpg"), "Inbox", &source).unwrap().0, "Inbox/download.pdf");
        let pdf = lib.items().unwrap().into_iter().find(|i| i.path == "Inbox/katalog.pdf").unwrap();
        assert_eq!((pdf.format.as_str(), pdf.pages, pdf.width), ("pdf", None, None));
        assert!(!lib.scan().unwrap(), "PDF und Video bleiben beim Scan erhalten");
        assert_eq!(lib.items().unwrap().len(), 5);

        let (abs, hash) = lib.locate(&rel).unwrap();
        let (mime, bytes) = lib.small_preview(&hash, &abs).unwrap();
        assert_eq!(mime, "image/jpeg");
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (400, 222));
    }
}
