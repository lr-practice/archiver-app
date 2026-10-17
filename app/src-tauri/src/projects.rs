// projects.rs — Projekte (0.40.0): leichtes Projektmanagement als eigener Bereich.
// Ersetzt Works. Eine eigene Wurzel, getrennt von der Bibliothek:
//   Projekte/<JJJJ-MM_Kunde_Name_Kürzel>/01_Briefing … 08_Admin
//   Projekte/Archiv/<Jahr>/<Projekt>          abgeschlossene Projekte
// Kunde, Kürzel, Phase, Fristen, offene Punkte und Notiz stehen lesbar in
// <Projekt>/.archiver/projekt.json. Der Ordner bleibt ohne Archiver lesbar.
//
// Geschrieben wird nur: neue Projektordner samt Vorlage, projekt.json, das
// Verschieben ganzer Projekte nach Archiv/<Jahr> und zurück, Vorschauen unter
// <Wurzel>/.archiver/thumbs. Dateien in Projekten werden nie verändert.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const META_DIR: &str = ".archiver";
const META_FILE: &str = "projekt.json";
pub const ARCHIVE: &str = "Archiv";
/// Tiefe unterhalb eines Ordners (Ordner/a/b/Datei)
const LIST_DEPTH: usize = 4;
/// Höchstens so viele Dateien je Ordner, damit ein Exportordner die App nicht lähmt
const LIST_MAX: usize = 3000;
/// Ordner, die übersprungen werden: InDesign-Pakete, Backups
const SKIP_DIRS: &[&str] = &["links", "document fonts", "backup", "backups", "__macosx"];

/// Vorlage: Ordner mit Unterordnern. Die Nummern halten die Reihenfolge auch im Finder.
pub const TEMPLATE: [(&str, &[&str]); 8] = [
    ("01_Briefing", &[]),
    ("02_Recherche", &["Moodboard", "Typografie", "Farbe-Material", "Wettbewerb"]),
    ("03_Entwurf", &["Skizzen", "Varianten", "Praesentationen"]),
    ("04_Arbeitsdateien", &[]),
    ("05_Assets", &["Logos", "Fonts", "Fotos", "Icons", "Sound", "Texturen"]),
    ("06_Reinzeichnung", &["Druck", "Web", "Motion"]),
    ("07_Ausgabe", &[]),
    ("08_Admin", &[]),
];

/// Ordner, die als Bilder gezeigt werden (Recherche, Entwurf, Assets); alle anderen als Liste
pub fn visual_folder(top: &str) -> bool {
    let n = top.to_lowercase();
    n.starts_with("02") || n.starts_with("03") || n.starts_with("05")
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Due {
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Todo {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Meta {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub client: String,
    #[serde(default)]
    pub code: String,
    /// 0 Briefing, 1 Recherche, 2 Entwurf, 3 Reinzeichnung, 4 Abgabe
    #[serde(default)]
    pub phase: u8,
    /// JJJJ-MM-TT
    #[serde(default)]
    pub start: String,
    /// Nächste Frist: Datum und Wort („Präsentation“)
    #[serde(default)]
    pub next: Due,
    /// Abgabe, JJJJ-MM-TT
    #[serde(default)]
    pub deadline: String,
    #[serde(default)]
    pub todos: Vec<Todo>,
    #[serde(default)]
    pub note: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub path: String,
    pub folder: String,
    pub meta: Meta,
    pub archived: bool,
    /// Bis zu drei Bilder aus 02_Recherche (sonst Entwurf, Assets) fürs Mosaik
    pub cover: Vec<String>,
    pub open_todos: usize,
    pub mtime: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    /// relativ zum Projekt, z. B. „02_Recherche/Moodboard“
    pub rel: String,
    pub name: String,
    pub depth: u8,
    pub count: usize,
    pub visual: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub summary: Summary,
    pub folders: Vec<Folder>,
    /// Dateien direkt im Projektordner (außerhalb der Vorlage)
    pub loose: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    /// Unterordner relativ zum gewählten Ordner ("" = direkt darin)
    pub dir: String,
    pub ext: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime: u64,
}

// ---- Hilfen ----

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn ext_of(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Lock-, Temp- und Systemdateien, die nie zählen
pub fn is_noise(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with('.')
        || name.starts_with('~')
        || lower.ends_with(".idlk")
        || lower.ends_with(".tmp")
        || lower.ends_with(".lck")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".part")
        || lower == "thumbs.db"
        || lower == "desktop.ini"
        || lower == "icon\r"
}

pub fn kind_of(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "tif" | "tiff" | "bmp" | "heic" | "avif" | "svg" => "image",
        "pdf" => "pdf",
        "indd" | "idml" | "indt" | "ai" | "ait" | "psd" | "psb" | "eps" | "afdesign" | "afphoto" | "afpub" | "sketch" | "fig" | "xd" | "glyphs" => "work",
        "eml" | "emlx" | "msg" => "mail",
        "md" | "txt" | "rtf" | "doc" | "docx" | "pages" | "odt" | "xls" | "xlsx" | "numbers" | "csv" | "key" | "ppt" | "pptx" => "doc",
        "otf" | "ttf" | "ttc" | "woff" | "woff2" => "font",
        "wav" | "aif" | "aiff" | "mp3" | "m4a" | "flac" | "logicx" | "als" => "audio",
        "webloc" | "url" => "link",
        "mp4" | "mov" | "m4v" | "webm" => "video",
        "zip" | "rar" | "7z" => "archive",
        _ => "other",
    }
}

fn skip_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    SKIP_DIRS.contains(&lower.as_str()) || name.starts_with('.') || lower.ends_with(".app")
}

/// Ordner mit Endung (.logicx, .fcpbundle, .rtfd) sind Dokumente, keine Ordner
fn is_package(path: &Path) -> bool {
    path.extension().is_some_and(|e| matches!(e.to_string_lossy().to_lowercase().as_str(), "logicx" | "fcpbundle" | "rtfd" | "band" | "key" | "pages" | "numbers" | "photoslibrary"))
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join(META_DIR).join(META_FILE)
}

pub fn is_project(dir: &Path) -> bool {
    meta_path(dir).is_file()
}

pub fn read_meta(dir: &Path) -> Meta {
    let mut m: Meta = fs::read(meta_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if m.name.trim().is_empty() {
        m.name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    }
    m.phase = m.phase.min(4);
    m
}

pub fn save_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
    let mut m = meta.clone();
    m.phase = m.phase.min(4);
    m.todos.retain(|t| !t.text.trim().is_empty());
    let p = meta_path(dir);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.part");
    fs::write(&tmp, serde_json::to_vec_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Ordnername aus Teilen: „2026-10_Acrolith_Relaunch_BR-WE“, ohne Zeichen, die der Finder nicht mag
pub fn folder_name(month: &str, client: &str, name: &str, code: &str) -> String {
    let clean = |s: &str| -> String {
        s.trim()
            .chars()
            .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
    };
    [month.to_string(), clean(client), clean(name), clean(code)].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("_")
}

// ---- Lesen ----

/// Dateien eines Ordners bis zur Tiefe LIST_DEPTH, neueste zuerst
pub fn list_files(dir: &Path) -> Vec<FileEntry> {
    let mut out = Vec::new();
    fn walk(base: &Path, dir: &Path, depth: usize, out: &mut Vec<FileEntry>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            if out.len() >= LIST_MAX {
                return;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if is_noise(&name) {
                continue;
            }
            let path = e.path();
            let Ok(meta) = fs::metadata(&path) else { continue };
            if meta.is_dir() && !is_package(&path) {
                if depth > 1 && !skip_dir(&name) {
                    walk(base, &path, depth - 1, out);
                }
                continue;
            }
            let ext = ext_of(&path);
            let rel = path.parent().and_then(|p| p.strip_prefix(base).ok()).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            out.push(FileEntry {
                path: path.to_string_lossy().into_owned(),
                kind: kind_of(&ext),
                name,
                dir: rel,
                ext,
                size: if meta.is_dir() { 0 } else { meta.len() },
                mtime: mtime_ms(&meta),
            });
        }
    }
    walk(dir, dir, LIST_DEPTH, &mut out);
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.name.cmp(&b.name)));
    out
}

fn count_files(dir: &Path) -> usize {
    list_files(dir).len()
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir() && !is_package(p) && !p.file_name().map(|n| skip_dir(&n.to_string_lossy())).unwrap_or(true))
                .collect()
        })
        .unwrap_or_default();
    v.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default());
    v
}

fn cover(dir: &Path) -> Vec<String> {
    let mut tops: Vec<PathBuf> = subdirs(dir);
    tops.sort_by_key(|p| {
        let n = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if n.starts_with("02") { 0 } else if n.starts_with("03") { 1 } else if n.starts_with("05") { 2 } else { 3 }
    });
    for top in tops.iter().filter(|p| visual_folder(&p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())) {
        let imgs: Vec<String> = list_files(top).into_iter().filter(|f| f.kind == "image").take(3).map(|f| f.path).collect();
        if !imgs.is_empty() {
            return imgs;
        }
    }
    Vec::new()
}

fn summary(dir: &Path, archived: bool) -> Summary {
    let meta = read_meta(dir);
    Summary {
        path: dir.to_string_lossy().into_owned(),
        folder: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        open_todos: meta.todos.iter().filter(|t| !t.done).count(),
        mtime: fs::metadata(meta_path(dir)).map(|m| mtime_ms(&m)).unwrap_or(0),
        cover: cover(dir),
        meta,
        archived,
    }
}

/// Alle Projekte: laufende in der Wurzel, abgeschlossene unter Archiv/<Jahr>
pub fn scan(root: &Path) -> Vec<Summary> {
    let mut out = Vec::new();
    for d in subdirs(root) {
        let name = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name == ARCHIVE {
            for year in subdirs(&d) {
                for p in subdirs(&year).into_iter().filter(|p| is_project(p)) {
                    out.push(summary(&p, true));
                }
            }
        } else if is_project(&d) {
            out.push(summary(&d, false));
        }
    }
    out.sort_by(|a, b| a.archived.cmp(&b.archived).then_with(|| b.folder.cmp(&a.folder)));
    out
}

pub fn project(root: &Path, dir: &Path) -> Result<Project, String> {
    if !is_project(dir) {
        return Err("projects-not-project".into());
    }
    let archived = dir.parent().and_then(|y| y.parent()).is_some_and(|a| a.file_name().is_some_and(|n| n == ARCHIVE) && a.parent() == Some(root));
    let mut folders = Vec::new();
    for top in subdirs(dir) {
        let name = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let visual = visual_folder(&name);
        folders.push(Folder { rel: name.clone(), count: count_files(&top), name: name.clone(), depth: 0, visual });
        for sub in subdirs(&top) {
            let sn = sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            folders.push(Folder { rel: format!("{name}/{sn}"), count: count_files(&sub), name: sn, depth: 1, visual });
        }
    }
    let loose = fs::read_dir(dir)
        .map(|rd| rd.flatten().filter(|e| e.path().is_file() && !is_noise(&e.file_name().to_string_lossy())).count())
        .unwrap_or(0);
    Ok(Project { summary: summary(dir, archived), folders, loose })
}

// ---- Schreiben ----

pub fn create(root: &Path, month: &str, today: &str, client: &str, name: &str, code: &str) -> Result<PathBuf, String> {
    if name.trim().is_empty() {
        return Err("projects-name".into());
    }
    let folder = folder_name(month, client, name, code);
    let dir = root.join(&folder);
    if dir.exists() {
        return Err("projects-exists".into());
    }
    for (top, subs) in TEMPLATE {
        fs::create_dir_all(dir.join(top)).map_err(|e| e.to_string())?;
        for s in subs {
            fs::create_dir_all(dir.join(top).join(s)).map_err(|e| e.to_string())?;
        }
    }
    let meta = Meta {
        name: name.trim().to_string(),
        client: client.trim().to_string(),
        code: code.trim().to_string(),
        start: today.to_string(),
        ..Default::default()
    };
    save_meta(&dir, &meta)?;
    Ok(dir)
}

/// Abschließen: nach Archiv/<Jahr>. Wieder öffnen: zurück in die Wurzel.
pub fn set_archived(root: &Path, dir: &Path, archived: bool, year: &str) -> Result<PathBuf, String> {
    let name = dir.file_name().ok_or("projects-name")?;
    let target = if archived { root.join(ARCHIVE).join(year).join(name) } else { root.join(name) };
    if target == dir {
        return Ok(target);
    }
    if target.exists() {
        return Err("projects-exists".into());
    }
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::rename(dir, &target).map_err(|e| e.to_string())?;
    // leeres Jahr im Archiv aufräumen
    if !archived {
        if let Some(year_dir) = dir.parent() {
            let _ = fs::remove_dir(year_dir);
        }
    }
    Ok(target)
}

/// Freier Name im Ordner: „Name.ext“, sonst „Name 2.ext“, „Name 3.ext“ …
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..10_000).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

fn copy_new(src: &Path, dest: &Path) -> Result<(), String> {
    let mut input = fs::File::open(src).map_err(|e| e.to_string())?;
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(dest).map_err(|e| e.to_string())?;
    if let Err(e) = std::io::copy(&mut input, &mut out) {
        drop(out);
        let _ = fs::remove_file(dest);
        return Err(e.to_string());
    }
    Ok(())
}

/// Dateien von außen (Finder, Bibliothek) in einen Projektordner kopieren, nie überschreiben
pub fn import(dir: &Path, paths: &[PathBuf]) -> Result<usize, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut n = 0;
    for src in paths {
        if !src.is_file() || src.parent() == Some(dir) {
            continue;
        }
        let name = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if is_noise(&name) {
            continue;
        }
        copy_new(src, &free_name(dir, &name))?;
        n += 1;
    }
    Ok(n)
}

// ---- Vorschauen ----

pub fn thumb(root: &Path, path: &Path, size: u32) -> Option<PathBuf> {
    let meta = fs::metadata(path).ok()?;
    let size = size.clamp(64, 2400);
    let key = blake3::hash(format!("{}|{}|{}|{}", path.display(), mtime_ms(&meta), meta.len(), size).as_bytes()).to_hex();
    let dir = root.join(META_DIR).join("thumbs");
    for ext in ["jpg", "png"] {
        let p = dir.join(format!("{}.{ext}", &key[..32]));
        if p.is_file() {
            return Some(p);
        }
    }
    fs::create_dir_all(&dir).ok()?;
    let ext = ext_of(path);
    let img = if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "tif" | "tiff" | "bmp") && meta.len() < 200 * 1024 * 1024 {
        image::open(path).ok().or_else(|| ql(root, path, size))
    } else {
        ql(root, path, size)
    }?;
    let img = if img.width() > size || img.height() > size { img.thumbnail(size, size) } else { img };
    let alpha = img.color().has_alpha();
    let out = dir.join(format!("{}.{}", &key[..32], if alpha { "png" } else { "jpg" }));
    let tmp = out.with_extension("part");
    let ok = if alpha {
        img.save_with_format(&tmp, image::ImageFormat::Png).is_ok()
    } else {
        fs::File::create(&tmp)
            .ok()
            .map(|f| {
                let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(f), 84);
                enc.encode_image(&img.to_rgb8()).is_ok()
            })
            .unwrap_or(false)
    };
    if !ok || fs::rename(&tmp, &out).is_err() {
        let _ = fs::remove_file(&tmp);
        return None;
    }
    Some(out)
}

fn ql(root: &Path, path: &Path, size: u32) -> Option<image::DynamicImage> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = root.join(META_DIR).join(format!("ql-{}-{n}", std::process::id()));
    crate::library::ql_image(path, size, &tmp)
}

// ---- Wurzel prüfen ----

/// Liegt `path` in der Wurzel (nach Auflösen von Verknüpfungen) und nicht in .archiver?
pub fn inside(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let p = path.canonicalize().ok()?;
    let rel = p.strip_prefix(&root).ok()?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| c.as_os_str() == META_DIR) {
        return None;
    }
    Some(p)
}

/// Sieht der Ordner nach einer Projekte-Wurzel aus (ein Projekt mit projekt.json darin)?
pub fn looks_like_root(root: &Path) -> bool {
    subdirs(root).iter().any(|d| is_project(d))
}

/// Betreffen Dateisystem-Ereignisse die Projekte? Vorschauen, Lock- und Temp-Dateien nicht.
pub fn relevant_change(paths: &[PathBuf]) -> bool {
    paths.iter().any(|p| {
        let in_meta = p.components().any(|c| c.as_os_str() == META_DIR);
        let meta_file = p.file_name().is_some_and(|n| n == META_FILE);
        (!in_meta || meta_file) && !p.file_name().map(|n| is_noise(&n.to_string_lossy())).unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_scan_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Projekte");
        fs::create_dir_all(&root).unwrap();
        assert!(!looks_like_root(&root));
        let dir = create(&root, "2026-10", "2026-10-17", "Acrolith", "Relaunch", "BR/WE").unwrap();
        assert_eq!(dir.file_name().unwrap(), "2026-10_Acrolith_Relaunch_BR-WE");
        assert!(dir.join("02_Recherche/Moodboard").is_dir());
        assert!(dir.join("08_Admin").is_dir());
        assert!(looks_like_root(&root));
        assert_eq!(create(&root, "2026-10", "2026-10-17", "Acrolith", "Relaunch", "BR/WE").unwrap_err(), "projects-exists");

        fs::write(dir.join("02_Recherche/Moodboard/a.png"), b"x").unwrap();
        fs::write(dir.join("04_Arbeitsdateien/Logo_v01.ai"), b"x").unwrap();
        fs::write(dir.join("04_Arbeitsdateien/.DS_Store"), b"x").unwrap();
        let p = project(&root, &dir).unwrap();
        let f = |rel: &str| p.folders.iter().find(|f| f.rel == rel).unwrap().clone();
        assert_eq!(f("02_Recherche").count, 1);
        assert!(f("02_Recherche").visual && !f("04_Arbeitsdateien").visual);
        assert_eq!(f("04_Arbeitsdateien").count, 1, "ohne .DS_Store");
        assert_eq!(p.summary.cover.len(), 1);
        assert_eq!(list_files(&dir.join("04_Arbeitsdateien"))[0].kind, "work");

        let mut m = read_meta(&dir);
        assert_eq!((m.client.as_str(), m.start.as_str()), ("Acrolith", "2026-10-17"));
        m.phase = 9;
        m.todos = vec![Todo { text: "Logo".into(), done: false }, Todo { text: " ".into(), done: false }];
        save_meta(&dir, &m).unwrap();
        let m2 = read_meta(&dir);
        assert_eq!((m2.phase, m2.todos.len()), (4, 1));

        let arch = set_archived(&root, &dir, true, "2026").unwrap();
        assert!(arch.ends_with("Archiv/2026/2026-10_Acrolith_Relaunch_BR-WE"));
        let all = scan(&root);
        assert_eq!(all.len(), 1);
        assert!(all[0].archived);
        assert!(project(&root, &arch).unwrap().summary.archived);
        let back = set_archived(&root, &arch, false, "2026").unwrap();
        assert_eq!(back, dir);
        assert!(!root.join("Archiv/2026").exists(), "leeres Jahr aufgeräumt");
        assert!(dir.join("04_Arbeitsdateien/Logo_v01.ai").is_file());

        let src = tmp.path().join("ref.jpg");
        fs::write(&src, b"x").unwrap();
        let target = dir.join("02_Recherche/Moodboard");
        assert_eq!(import(&target, &[src.clone(), src.clone()]).unwrap(), 2);
        assert!(target.join("ref 2.jpg").is_file());
    }

    #[test]
    fn names_and_changes() {
        assert_eq!(folder_name("2026-10", " Kunst halle ", "Katalog: 2027", ""), "2026-10_Kunst-halle_Katalog--2027");
        assert!(relevant_change(&[PathBuf::from("/P/x/02_Recherche/a.png")]));
        assert!(!relevant_change(&[PathBuf::from("/P/.archiver/thumbs/a.jpg")]));
        assert!(relevant_change(&[PathBuf::from("/P/x/.archiver/projekt.json")]));
        assert!(!relevant_change(&[PathBuf::from("/P/x/a.indd.idlk")]));
    }
}
