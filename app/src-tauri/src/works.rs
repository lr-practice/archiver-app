// works.rs — Works (0.38.0): laufende Kundenprojekte, getrennt von der Bibliothek.
//
// Eine eigene Wurzel, darin Kunde/Projekt mit sechs festen Ordnern:
//   Works/<Kunde>/_Assets/…                     gilt für alle Projekte des Kunden
//   Works/<Kunde>/<Projekt>/00 Post, 01 Brief, 02 Recherche, 03 Layout,
//                           04 Reinzeichnung, 05 Übergabe
// Eigene Namen werden am Wort erkannt („Entwurf“ = Layout, „Druckdaten“ =
// Reinzeichnung …). Die Phase ist der höchste Phasenordner mit Inhalt, Archiver
// verschiebt dafür nie eine Datei (InDesign-Links, offene Dateien).
//
// Geschrieben wird nur: neue Projektordner samt brief.md, brief.md selbst,
// neue Stände (Kopie mit nächster Kennung im selben Ordner), Kopien nach
// 02 Recherche und <Wurzel>/.archiver/ (Vorschauen, works.json mit „bezahlt“).
// Arbeitsdateien werden nie verschoben, umbenannt, überschrieben oder gelöscht.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const META_DIR: &str = ".archiver";
const STATE_FILE: &str = "works.json";
pub const ASSETS: &str = "_Assets";
pub const BRIEF_FILE: &str = "brief.md";
/// Tiefe unterhalb eines Phasenordners (Phase/a/b/Datei)
const SLOT_DEPTH: usize = 3;
/// Höchstens so viele Dateien je Phasenordner, damit ein Exportordner die App nicht lähmt
const SLOT_MAX_FILES: usize = 2000;
/// Ordner, die Works überspringt: InDesign-Pakete, Schriften, Backups
const SKIP_DIRS: &[&str] = &["links", "document fonts", "fonts", "backup", "backups", "__macosx"];
/// Ab so vielen Tagen gilt eine offene Rechnung als überfällig (Oberfläche färbt rot)
pub const INVOICE_DUE_DAYS: u64 = 30;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Post,
    Brief,
    Research,
    Layout,
    Final,
    Delivery,
}

pub const SLOTS: [Slot; 6] = [Slot::Post, Slot::Brief, Slot::Research, Slot::Layout, Slot::Final, Slot::Delivery];

impl Slot {
    /// Ordnername beim Anlegen
    pub fn folder(self, lang: &str) -> &'static str {
        let de = lang != "en";
        match self {
            Slot::Post => if de { "00 Post" } else { "00 Mail" },
            Slot::Brief => "01 Brief",
            Slot::Research => if de { "02 Recherche" } else { "02 Research" },
            Slot::Layout => "03 Layout",
            Slot::Final => if de { "04 Reinzeichnung" } else { "04 Artwork" },
            Slot::Delivery => if de { "05 Übergabe" } else { "05 Delivery" },
        }
    }

    /// Phase 0–4 (Brief … Übergabe); Post ist keine Phase
    pub fn phase(self) -> Option<u8> {
        match self {
            Slot::Post => None,
            Slot::Brief => Some(0),
            Slot::Research => Some(1),
            Slot::Layout => Some(2),
            Slot::Final => Some(3),
            Slot::Delivery => Some(4),
        }
    }
}

/// Welcher Phase ein Ordner entspricht, am Wort erkannt. Nummern allein zählen
/// nicht („01 Fotos“ ist kein Brief). Reihenfolge: „Final Export“ ist Übergabe.
pub fn slot_of_folder(name: &str) -> Option<Slot> {
    let lower = name.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !w.chars().all(|c| c.is_ascii_digit()))
        .collect();
    if words.is_empty() {
        return None;
    }
    let has = |list: &[&str]| words.iter().any(|w| list.contains(w));
    const DELIVERY: &[&str] = &["übergabe", "uebergabe", "abgabe", "delivery", "export", "exports", "lieferung", "auslieferung", "handoff", "handover"];
    const POST: &[&str] = &["post", "mail", "mails", "email", "korrespondenz", "verwaltung", "admin", "angebot", "angebote", "rechnung", "rechnungen", "buchhaltung", "finanzen", "kommunikation", "correspondence", "invoices", "offers"];
    const BRIEF: &[&str] = &["brief", "briefing", "auftrag", "input"];
    const RESEARCH: &[&str] = &["recherche", "research", "referenz", "referenzen", "references", "moodboard", "moodboards", "inspiration", "ideen"];
    const FINAL: &[&str] = &["reinzeichnung", "reinzeichnungen", "rz", "final", "druckdaten", "artwork", "produktion", "druck", "print", "production"];
    const LAYOUT: &[&str] = &["layout", "layouts", "entwurf", "entwürfe", "entwuerfe", "design", "gestaltung", "konzept", "scribble", "scribbles", "drafts"];
    if has(DELIVERY) {
        Some(Slot::Delivery)
    } else if has(POST) {
        Some(Slot::Post)
    } else if has(BRIEF) {
        Some(Slot::Brief)
    } else if has(RESEARCH) {
        Some(Slot::Research)
    } else if has(FINAL) {
        Some(Slot::Final)
    } else if has(LAYOUT) {
        Some(Slot::Layout)
    } else {
        None
    }
}

/// Lock-, Temp- und Systemdateien, die nie als Arbeit zählen
pub fn is_noise(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with('.')
        || name.starts_with('~')
        || name.starts_with("._")
        || lower.ends_with(".idlk")
        || lower.ends_with(".tmp")
        || lower.ends_with(".lck")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".part")
        || lower == "thumbs.db"
        || lower == "desktop.ini"
        || lower == "icon\r"
}

// ---- Stände: Stamm und Kennung am Dateinamen ----

/// Stamm, Schlüssel (für die Gruppe) und Kennung eines Dateinamens.
/// „Plakat_A1_V3_KORR.indd“ → Stamm „Plakat_A1“, Kennung „V3 KORR“.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Version {
    pub stem: String,
    pub key: String,
    pub tag: String,
}

fn is_tag_word(w: &str) -> bool {
    let l = w.to_lowercase();
    const WORDS: &[&str] = &[
        "final", "finale", "endgültig", "endgueltig", "korr", "korrektur", "entwurf", "draft", "wip", "fix", "alt", "neu",
        "kopie", "copy", "rz", "freigabe", "ok", "druck", "print",
    ];
    if WORDS.contains(&l.as_str()) {
        return true;
    }
    // V1, v02, ver3, version 4 (ohne Leerzeichen), K1 (Korrekturlauf)
    for prefix in ["version", "ver", "v", "k"] {
        if let Some(rest) = l.strip_prefix(prefix) {
            if !rest.is_empty() && rest.len() <= 3 && rest.chars().all(|c| c.is_ascii_digit()) {
                return true;
            }
        }
    }
    // (2), Datum 2026-10-14, 20261014, 261014, laufende Nummer 1–99
    if l.starts_with('(') && l.ends_with(')') && l.len() <= 4 && l[1..l.len() - 1].chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    let digits = l.chars().all(|c| c.is_ascii_digit());
    if digits && (l.len() <= 2 || l.len() == 6 || l.len() == 8) {
        return true;
    }
    let b = l.as_bytes();
    l.len() == 10 && b[4] == b'-' && b[7] == b'-' && l.chars().filter(|c| c.is_ascii_digit()).count() == 8
}

pub fn version_of(filename: &str) -> Version {
    let base = match filename.rfind('.') {
        Some(i) if i > 0 => &filename[..i],
        _ => filename,
    };
    let mut stem = base.to_string();
    let mut tags: Vec<String> = Vec::new();
    loop {
        // Datum am Ende („Flyer_2026-10-14“) als ein Wort, obwohl es Bindestriche hat
        if stem.len() > 11 && stem.is_char_boundary(stem.len() - 11) && stem.is_char_boundary(stem.len() - 10) {
            let (head, date) = stem.split_at(stem.len() - 10);
            if is_tag_word(date) && head.ends_with([' ', '_', '-', '.']) {
                tags.insert(0, date.to_string());
                stem = head[..head.len() - 1].to_string();
                continue;
            }
        }
        // letztes Wort hinter einem Trenner (Leerzeichen, _, -, .)
        let Some(cut) = stem.rfind([' ', '_', '-', '.']) else { break };
        if cut == 0 {
            break;
        }
        let word = &stem[cut + 1..];
        // „Version 4“: Zahl allein, davor „Version“
        if !word.is_empty() && word.chars().all(|c| c.is_ascii_digit()) && word.len() <= 3 {
            let before = stem[..cut].trim_end_matches([' ', '_', '-', '.']);
            if before.to_lowercase().ends_with("version") && before.len() > 7 {
                let cut2 = before.len() - 7;
                tags.insert(0, format!("V{word}"));
                stem = before[..cut2].trim_end_matches([' ', '_', '-', '.']).to_string();
                if stem.is_empty() {
                    break;
                }
                continue;
            }
        }
        if word.is_empty() || !is_tag_word(word) {
            break;
        }
        tags.insert(0, word.to_uppercase());
        stem.truncate(cut);
    }
    if stem.is_empty() {
        stem = base.to_string();
        tags.clear();
    }
    let key = stem
        .to_lowercase()
        .split([' ', '_', '-', '.'])
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    Version { stem, key, tag: tags.join(" ") }
}

/// V-Nummer in der Kennung eines Namens, mit Schreibweise: („V“, 2, Breite 1)
fn version_number(filename: &str) -> Option<(String, u32, usize)> {
    let base = match filename.rfind('.') {
        Some(i) if i > 0 => &filename[..i],
        _ => filename,
    };
    let v = version_of(filename);
    let tail = &base[v.stem.len().min(base.len())..];
    let mut found = None;
    for word in tail.split([' ', '_', '-', '.']) {
        let lower = word.to_lowercase();
        for prefix in ["version", "ver", "v"] {
            if let Some(rest) = lower.strip_prefix(prefix) {
                if !rest.is_empty() && rest.len() <= 3 && rest.chars().all(|c| c.is_ascii_digit()) {
                    found = Some((word[..prefix.len()].to_string(), rest.parse().unwrap_or(1), rest.len()));
                    break;
                }
            }
        }
    }
    found
}

/// Name mit Stand `n`: Stamm, Trenner wie im Namen, V-Wort in alter Schreibweise.
/// Die Kennung KORR, RZ … fällt weg, der neue Stand ist wieder eine Arbeitsfassung.
fn version_name(filename: &str, n: u32) -> String {
    let (base, ext) = match filename.rfind('.') {
        Some(i) if i > 0 => (&filename[..i], &filename[i..]),
        _ => (filename, ""),
    };
    let v = version_of(filename);
    let sep = if v.stem.contains('_') || base.contains('_') {
        "_"
    } else if v.stem.contains(' ') {
        " "
    } else if v.stem.contains('-') {
        "-"
    } else {
        "_"
    };
    let (prefix, width) = version_number(filename).map(|(p, _, w)| (p, w)).unwrap_or(("V".into(), 1));
    format!("{}{sep}{prefix}{:0width$}{ext}", v.stem, n, width = width)
}

/// Name für den nächsten Stand: V2 → V3, ohne Nummer kommt „_V2“ an den Stamm
pub fn next_version_name(filename: &str) -> String {
    let n = version_number(filename).map(|(_, n, _)| n).unwrap_or(1);
    version_name(filename, n + 1)
}

// ---- Dateien ----

fn ext_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn kind_of(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "tif" | "tiff" | "bmp" | "heic" | "avif" | "svg" => "image",
        "pdf" => "pdf",
        "indd" | "idml" | "indt" | "ai" | "ait" | "psd" | "psb" | "eps" | "afdesign" | "afphoto" | "afpub" | "sketch" | "fig" | "xd" => "work",
        "eml" | "emlx" | "msg" => "mail",
        "md" | "txt" | "rtf" | "doc" | "docx" | "pages" | "odt" | "xls" | "xlsx" | "numbers" | "csv" | "key" | "ppt" | "pptx" => "doc",
        "otf" | "ttf" | "ttc" | "woff" | "woff2" => "font",
        "ase" | "aco" | "ase2" => "swatch",
        "webloc" | "url" => "link",
        "mp4" | "mov" | "m4v" | "webm" => "video",
        "zip" | "rar" | "7z" => "archive",
        _ => "other",
    }
}

/// Bilder, die der Browser selbst zeigt (Original statt Vorschau)
pub fn web_image(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "avif" | "bmp")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    /// Unterordner relativ zum Phasenordner ("" = direkt darin)
    pub dir: String,
    pub ext: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime: u64,
    pub stem: String,
    pub key: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post: Option<PostInfo>,
}

fn entry(path: &Path, base: &Path, meta: &fs::Metadata) -> FileEntry {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = path
        .parent()
        .and_then(|p| p.strip_prefix(base).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let ext = ext_of(path);
    let v = version_of(&name);
    FileEntry {
        path: path.to_string_lossy().into_owned(),
        kind: kind_of(&ext),
        name,
        dir,
        ext,
        size: meta.len(),
        mtime: mtime_ms(meta),
        stem: v.stem,
        key: v.key,
        tag: v.tag,
        post: None,
    }
}

fn skip_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    SKIP_DIRS.contains(&lower.as_str()) || name.starts_with('.') || lower.ends_with(".app")
}

/// Dateien eines Ordners bis zur Tiefe `depth`, ohne Lock-Dateien und Links-Ordner.
/// InDesign-Pakete und Ordner mit Endung (z. B. .fcpbundle) gelten als eine Datei nicht, sie fallen weg.
pub fn list_files(dir: &Path, depth: usize) -> Vec<FileEntry> {
    let mut out = Vec::new();
    let walk = walkdir::WalkDir::new(dir)
        .min_depth(1)
        .max_depth(depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                return !skip_dir(&name);
            }
            !is_noise(&name)
        });
    for e in walk.filter_map(|e| e.ok()) {
        if !e.file_type().is_file() {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        out.push(entry(e.path(), dir, &meta));
        if out.len() >= SLOT_MAX_FILES {
            break;
        }
    }
    out.sort_by(|a, b| a.dir.cmp(&b.dir).then(a.mtime.cmp(&b.mtime)));
    out
}

// ---- Post: Angebote, Rechnungen, Mails ----

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostInfo {
    /// "invoice" | "offer" | "mail" | "doc"
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    /// Betrag in Cent, nur wenn „€“ oder „EUR“ im Namen steht
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Datum aus der Mail, sonst Änderungsdatum der Datei
    pub date: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paid: Option<u64>,
}

/// Zahl wie „1.850,00“, „1850“, „4.200“ oder „1850.50“ in Cent
pub fn parse_amount(s: &str) -> Option<i64> {
    let s = s.trim_matches(|c: char| !c.is_ascii_digit());
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
        return None;
    }
    let (int, frac) = match (s.rfind(','), s.rfind('.')) {
        (Some(c), _) if s.len() - c - 1 == 2 && s.rfind('.').is_none_or(|d| d < c) => (&s[..c], &s[c + 1..]),
        (None, Some(d)) if s.len() - d - 1 == 2 && s.matches('.').count() == 1 => (&s[..d], &s[d + 1..]),
        _ => (s, ""),
    };
    // Tausenderpunkte und -kommas: Gruppen zu je drei Ziffern
    let groups: Vec<&str> = int.split(['.', ',']).collect();
    if groups.len() > 1 && groups[1..].iter().any(|g| g.len() != 3) {
        return None;
    }
    let whole: i64 = groups.concat().parse().ok()?;
    let cents: i64 = if frac.is_empty() { 0 } else { frac.parse().ok()? };
    Some(whole * 100 + cents)
}

/// Betrag neben „€“ oder „EUR“ im Dateinamen
fn amount_in(stem: &str) -> Option<i64> {
    let lower = stem.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let is_num = |c: char| c.is_ascii_digit() || c == '.' || c == ',';
    let mut marks = Vec::new();
    for (i, w) in chars.windows(3).enumerate() {
        if w == ['e', 'u', 'r'] && !chars.get(i + 3).is_some_and(|c| c.is_alphabetic()) && (i == 0 || !chars[i - 1].is_alphabetic()) {
            marks.push((i, 3));
        }
    }
    for (i, c) in chars.iter().enumerate() {
        if *c == '€' {
            marks.push((i, 1));
        }
    }
    for (at, len) in marks {
        // davor: „1.850,00 EUR“, „1850€“
        let mut end = at;
        while end > 0 && chars[end - 1] == ' ' {
            end -= 1;
        }
        let mut start = end;
        while start > 0 && is_num(chars[start - 1]) {
            start -= 1;
        }
        // „2026-031 EUR“: Teil einer Nummer, kein Betrag
        let free = start == 0 || matches!(chars[start - 1], ' ' | '_' | '(');
        if start < end && free {
            let num: String = chars[start..end].iter().collect();
            if let Some(a) = parse_amount(&num) {
                return Some(a);
            }
        }
        // dahinter: „EUR 1.850“
        let mut s = at + len;
        while s < chars.len() && chars[s] == ' ' {
            s += 1;
        }
        let mut e = s;
        while e < chars.len() && is_num(chars[e]) {
            e += 1;
        }
        if s < e {
            let num: String = chars[s..e].iter().collect();
            if let Some(a) = parse_amount(&num) {
                return Some(a);
            }
        }
    }
    None
}

/// Angebot oder Rechnung am Namen, mit Nummer und Betrag
pub fn post_of_name(name: &str) -> Option<PostInfo> {
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    };
    let lower = stem.to_lowercase();
    let tokens: Vec<&str> = lower.split([' ', '_']).filter(|t| !t.is_empty()).collect();
    let numeric = |t: &str| t.chars().any(|c| c.is_ascii_digit()) && t.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '/');
    let mut kind = None;
    let mut number = None;
    for (i, tok) in tokens.iter().enumerate() {
        // „RE-2026-014“, „AN-031“: Kürzel mit Nummer in einem Wort
        for (prefix, k) in [("re-", "invoice"), ("rg-", "invoice"), ("an-", "offer"), ("ang-", "offer")] {
            if let Some(rest) = tok.strip_prefix(prefix) {
                if numeric(rest) && kind.is_none() {
                    kind = Some(k);
                    number = Some(rest.to_string());
                }
            }
        }
        let word: String = tok.chars().take_while(|c| c.is_alphabetic()).collect();
        let k = match word.as_str() {
            "rechnung" | "invoice" | "re" | "rg" | "schlussrechnung" | "abschlagsrechnung" | "teilrechnung" => Some("invoice"),
            "angebot" | "offer" | "quote" | "kostenvoranschlag" | "kva" | "an" => Some("offer"),
            _ => None,
        };
        // „RE“ und „AN“ allein zählen nur mit einer Nummer dahinter
        let short = matches!(word.as_str(), "re" | "rg" | "an" | "kva");
        let next_num = tokens.get(i + 1).copied().filter(|t| numeric(t));
        let rest = &tok[word.len()..];
        let inline = rest.trim_start_matches('-');
        if let Some(k) = k {
            if word.len() != tok.len() && !(numeric(inline) && !inline.is_empty()) {
                continue; // „Angebotsentwurf“, „Ankündigung“
            }
            if short && next_num.is_none() && inline.is_empty() {
                continue;
            }
            if kind.is_none() {
                kind = Some(k);
                number = if !inline.is_empty() { Some(inline.to_string()) } else { next_num.map(str::to_string) };
            }
        }
    }
    let kind = kind?;
    let amount = amount_in(stem);
    // Die Nummer ist nicht der Betrag
    if let (Some(n), Some(_)) = (&number, amount) {
        if !n.contains('-') && !n.contains('/') && n.len() <= 4 && stem.to_lowercase().contains(&format!("{n} eur")) {
            number = None;
        }
    }
    Some(PostInfo { kind, number, amount, ..Default::default() })
}

// ---- Mails (.eml, .emlx): Betreff, Absender, Datum ----

fn decode_words(s: &str) -> String {
    // RFC 2047: =?utf-8?Q?…?= und =?utf-8?B?…?=, dazwischen nur Leerraum
    use base64::Engine;
    let mut out = String::new();
    let mut rest = s;
    let mut last_encoded = false;
    while let Some(start) = rest.find("=?") {
        let before = &rest[..start];
        let after = &rest[start + 2..];
        let parts: Vec<&str> = after.splitn(3, '?').collect();
        if parts.len() < 3 {
            break;
        }
        let (charset, enc, tail) = (parts[0].to_lowercase(), parts[1].to_lowercase(), parts[2]);
        let Some(end) = tail.find("?=") else { break };
        let text = &tail[..end];
        let bytes: Option<Vec<u8>> = match enc.as_str() {
            "b" => base64::engine::general_purpose::STANDARD.decode(text.trim()).ok(),
            "q" => {
                let mut b = Vec::new();
                let raw = text.as_bytes();
                let mut i = 0;
                while i < raw.len() {
                    match raw[i] {
                        b'_' => b.push(b' '),
                        b'=' if i + 2 < raw.len() => {
                            let hex = std::str::from_utf8(&raw[i + 1..(i + 3).min(raw.len())]).unwrap_or("");
                            match u8::from_str_radix(hex, 16) {
                                Ok(v) => {
                                    b.push(v);
                                    i += 2;
                                }
                                Err(_) => b.push(b'='),
                            }
                        }
                        c => b.push(c),
                    }
                    i += 1;
                }
                Some(b)
            }
            _ => None,
        };
        let Some(bytes) = bytes else { break };
        if !(last_encoded && before.trim().is_empty()) {
            out.push_str(before);
        }
        if charset.contains("utf-8") || charset.contains("utf8") {
            out.push_str(&String::from_utf8_lossy(&bytes));
        } else {
            // ISO-8859-1 / Windows-1252: Byte = Zeichen (für deutsche Umlaute genug)
            out.extend(bytes.iter().map(|&b| b as char));
        }
        last_encoded = true;
        rest = &tail[end + 2..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// „Tue, 14 Oct 2026 09:12:00 +0200“ → ms seit 1970
pub fn parse_mail_date(s: &str) -> Option<u64> {
    let s = s.split('(').next().unwrap_or(s);
    let s = match s.find(',') {
        Some(i) => &s[i + 1..],
        None => s,
    };
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let day: i64 = parts[0].parse().ok()?;
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let mon = MONTHS.iter().position(|m| parts[1].to_lowercase().starts_with(m))? as i64 + 1;
    let mut year: i64 = parts[2].parse().ok()?;
    if year < 100 {
        year += if year < 50 { 2000 } else { 1900 };
    }
    let hms: Vec<i64> = parts[3].split(':').map(|x| x.parse().unwrap_or(0)).collect();
    let (h, mi, se) = (hms.first().copied().unwrap_or(0), hms.get(1).copied().unwrap_or(0), hms.get(2).copied().unwrap_or(0));
    let mut offset = 0i64;
    if let Some(z) = parts.get(4) {
        let b = z.as_bytes();
        if z.len() == 5 && (b[0] == b'+' || b[0] == b'-') {
            let v: i64 = z[1..].parse().unwrap_or(0);
            offset = (v / 100) * 3600 + (v % 100) * 60;
            if b[0] == b'-' {
                offset = -offset;
            }
        }
    }
    let secs = days_from_civil(year, mon, day) * 86400 + h * 3600 + mi * 60 + se - offset;
    (secs > 0).then_some(secs as u64 * 1000)
}

/// Kopfzeilen einer Mail: Betreff, Absender (Name statt Adresse), Datum
pub fn parse_mail(raw: &[u8]) -> PostInfo {
    let mut text = String::from_utf8_lossy(raw).into_owned();
    // .emlx: erste Zeile ist die Länge der Nachricht
    if let Some(nl) = text.find('\n') {
        if !text[..nl].trim().is_empty() && text[..nl].trim().chars().all(|c| c.is_ascii_digit()) {
            text = text[nl + 1..].to_string();
        }
    }
    let head_end = text.find("\r\n\r\n").or_else(|| text.find("\n\n")).unwrap_or(text.len());
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in text[..head_end].lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(last) = headers.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
        } else if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }
    let get = |k: &str| headers.iter().find(|(h, _)| h == k).map(|(_, v)| v.clone());
    let subject = get("subject").map(|s| decode_words(&s)).filter(|s| !s.is_empty());
    let from = get("from").map(|f| {
        let f = decode_words(&f);
        match f.find('<') {
            Some(i) if i > 0 => f[..i].trim().trim_matches('"').trim().to_string(),
            _ => f.trim_matches(['<', '>']).to_string(),
        }
    });
    let date = get("date").and_then(|d| parse_mail_date(&d)).unwrap_or(0);
    PostInfo { kind: "mail", subject, from, date, ..Default::default() }
}

fn read_head(path: &Path, max: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Ok(f) = fs::File::open(path) {
        let _ = f.take(max as u64).read_to_end(&mut buf);
    }
    buf
}

// ---- Brief ----

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub path: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact: Option<String>,
}

/// Datum als JJJJ-MM-TT aus „2026-10-30“, „30.10.2026“ oder „30.10.26“
pub fn parse_day(s: &str) -> Option<String> {
    let s = s.trim();
    let nums: Vec<&str> = s.split(['-', '.', '/']).map(str::trim).collect();
    if nums.len() != 3 || !nums.iter().all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = if nums[0].len() == 4 {
        (nums[0].parse().ok()?, nums[1].parse().ok()?, nums[2].parse().ok()?)
    } else {
        let mut y: i64 = nums[2].parse().ok()?;
        if y < 100 {
            y += 2000;
        }
        (y, nums[1].parse().ok()?, nums[0].parse().ok()?)
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(1990..=2200).contains(&y) {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

pub fn parse_brief(text: &str) -> Brief {
    let mut b = Brief { text: text.to_string(), ..Default::default() };
    let body = text.trim_start_matches('\u{feff}');
    let mut lines = body.lines();
    if lines.next().map(str::trim) != Some("---") {
        return b;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim().to_lowercase();
        let val = v.trim().trim_matches('"').trim().to_string();
        if val.is_empty() {
            continue;
        }
        match key.as_str() {
            "termin" | "deadline" | "due" | "abgabe" => b.deadline = parse_day(&val),
            "status" => {
                let l = val.to_lowercase();
                b.done = ["abgeschlossen", "fertig", "erledigt", "done", "closed", "archiv", "archiviert", "beendet"].iter().any(|w| l.starts_with(w));
                b.status = Some(val);
            }
            "nächster schritt" | "naechster schritt" | "next" | "next step" | "nächstes" => b.next = Some(val),
            "ansprechpartner" | "ansprechpartnerin" | "kontakt" | "contact" => b.contact = Some(val),
            _ => {}
        }
    }
    b
}

pub fn brief_template(client: &str, name: &str, lang: &str) -> String {
    if lang == "en" {
        format!("---\ndeadline: \nstatus: running\nnext step: \ncontact: \n---\n\n# {name}\n\nClient: {client}\n\n## Task\n\n\n## Formats\n\n\n## Notes\n\n")
    } else {
        format!("---\ntermin: \nstatus: laufend\nnächster schritt: \nansprechpartner: \n---\n\n# {name}\n\nKunde: {client}\n\n## Aufgabe\n\n\n## Formate\n\n\n## Notizen\n\n")
    }
}

fn find_brief(project: &Path, slots: &[(Slot, PathBuf)]) -> Option<PathBuf> {
    for (s, dir) in slots {
        if *s == Slot::Brief {
            let p = dir.join(BRIEF_FILE);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let p = project.join(BRIEF_FILE);
    p.is_file().then_some(p)
}

// ---- Projekte ----

/// Phasenordner eines Projekts (erster Treffer je Phase gewinnt) und die übrigen Ordner
pub fn project_slots(project: &Path) -> (Vec<(Slot, PathBuf)>, Vec<PathBuf>) {
    let mut slots: Vec<(Slot, PathBuf)> = Vec::new();
    let mut other = Vec::new();
    let mut dirs: Vec<PathBuf> = fs::read_dir(project)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| p.file_name().map(|n| !skip_dir(&n.to_string_lossy())).unwrap_or(false))
        .collect();
    dirs.sort();
    for d in dirs {
        let name = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match slot_of_folder(&name) {
            Some(s) if !slots.iter().any(|(x, _)| *x == s) => slots.push((s, d)),
            _ => other.push(d),
        }
    }
    (slots, other)
}

/// Sieht ein Ordner aus wie ein Projekt? (zwei Phasenordner oder ein brief.md)
/// Sieht der Ordner wie eine Works-Wurzel aus? Streng: irgendwo auf Ebene
/// Projekt oder Kunde/Projekt liegt ein brief.md (direkt oder in „01 Brief“).
/// Damit lehnt Archiver ihn als Bibliothek ab (0.38.2).
pub fn looks_like_root(root: &Path) -> bool {
    let subdirs = |d: &Path| -> Vec<PathBuf> {
        fs::read_dir(d)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| !n.to_string_lossy().starts_with('.')))
            .take(400)
            .collect()
    };
    let has_brief = |p: &Path| {
        p.join(BRIEF_FILE).is_file() || subdirs(p).iter().any(|d| slot_of_folder(&d.file_name().unwrap_or_default().to_string_lossy()) == Some(Slot::Brief) && d.join(BRIEF_FILE).is_file())
    };
    subdirs(root).iter().any(|a| has_brief(a) || subdirs(a).iter().any(|b| has_brief(b)))
}

pub fn looks_like_project(dir: &Path) -> bool {
    if dir.join(BRIEF_FILE).is_file() {
        return true;
    }
    project_slots(dir).0.len() >= 2
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub path: String,
    pub client: String,
    pub name: String,
    /// 0–4: Brief … Übergabe
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<u8>,
    /// Der neueste Stand in Layout oder Reinzeichnung trägt KORR
    pub correction: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub modified: u64,
    pub files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<FileEntry>,
    pub open_invoices: usize,
    pub open_amount: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotFiles {
    pub slot: Slot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherDir {
    pub path: String,
    pub name: String,
    pub files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub summary: Summary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief: Option<Brief>,
    pub slots: Vec<SlotFiles>,
    pub other: Vec<OtherDir>,
    /// _Assets des Kunden
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_dir: Option<String>,
    pub assets: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub root: String,
    pub clients: Vec<String>,
    pub projects: Vec<Summary>,
}

/// works.json: was Archiver selbst über Works weiß (bezahlte Rechnungen)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    /// Pfad relativ zur Wurzel → bezahlt am (ms)
    #[serde(default)]
    pub paid: BTreeMap<String, u64>,
}

fn state_path(root: &Path) -> PathBuf {
    root.join(META_DIR).join(STATE_FILE)
}

pub fn load_state(root: &Path) -> State {
    fs::read(state_path(root)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn rel_key(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

pub fn set_paid(root: &Path, path: &Path, paid: bool, now: u64) -> Result<(), String> {
    let mut st = load_state(root);
    let key = rel_key(root, path);
    if paid {
        st.paid.insert(key, now);
    } else {
        st.paid.remove(&key);
    }
    let p = state_path(root);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::library::write_atomic(&p, &serde_json::to_vec_pretty(&st).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Post-Angaben an die Dateien hängen (Mail-Köpfe lesen, Beträge am Namen)
fn annotate_post(root: &Path, files: &mut [FileEntry], st: &State) {
    for f in files.iter_mut() {
        let mut info = if f.kind == "mail" && f.ext != "msg" {
            Some(parse_mail(&read_head(Path::new(&f.path), 64 * 1024)))
        } else {
            post_of_name(&f.name)
        };
        if let Some(i) = info.as_mut() {
            if i.date == 0 {
                i.date = f.mtime;
            }
            if i.kind == "invoice" {
                i.paid = st.paid.get(&rel_key(root, Path::new(&f.path))).copied();
            }
        } else {
            info = Some(PostInfo { kind: "doc", date: f.mtime, ..Default::default() });
        }
        f.post = info;
    }
}

fn read_project(root: &Path, client: &str, dir: &Path, st: &State) -> Project {
    let (slots, other) = project_slots(dir);
    let brief = find_brief(dir, &slots).map(|p| {
        let text = fs::read_to_string(&p).unwrap_or_default();
        let mut b = parse_brief(&text);
        b.path = p.to_string_lossy().into_owned();
        b
    });
    let mut out_slots = Vec::new();
    let mut phase: Option<u8> = None;
    let mut modified = 0u64;
    let mut count = 0usize;
    let mut cover: Option<FileEntry> = None;
    let mut research_cover: Option<FileEntry> = None;
    let mut correction = false;
    let (mut open_invoices, mut open_amount) = (0usize, 0i64);
    for s in SLOTS {
        let found = slots.iter().find(|(x, _)| *x == s);
        let mut files = found.map(|(_, d)| list_files(d, SLOT_DEPTH)).unwrap_or_default();
        if s == Slot::Post {
            annotate_post(root, &mut files, st);
            for f in &files {
                if let Some(p) = &f.post {
                    if p.kind == "invoice" && p.paid.is_none() {
                        open_invoices += 1;
                        open_amount += p.amount.unwrap_or(0);
                    }
                }
            }
        }
        // brief.md zählt für die Phase, gehört aber nicht in die Dateiliste
        let has_work = files.iter().any(|f| !(s == Slot::Brief && f.name.eq_ignore_ascii_case(BRIEF_FILE)))
            || (s == Slot::Brief && brief.is_some());
        if has_work {
            if let Some(p) = s.phase() {
                phase = Some(phase.map_or(p, |q| q.max(p)));
            }
        }
        for f in &files {
            modified = modified.max(f.mtime);
            let visual = matches!(f.kind, "image" | "pdf" | "work");
            if visual && matches!(s, Slot::Layout | Slot::Final) && cover.as_ref().is_none_or(|c| f.mtime > c.mtime) {
                cover = Some(f.clone());
            }
            if f.kind == "image" && s == Slot::Research && research_cover.as_ref().is_none_or(|c| f.mtime > c.mtime) {
                research_cover = Some(f.clone());
            }
        }
        if matches!(s, Slot::Layout | Slot::Final) {
            if let Some(newest) = files.iter().filter(|f| matches!(f.kind, "pdf" | "work" | "image")).max_by_key(|f| f.mtime) {
                if newest.tag.contains("KORR") {
                    correction = true;
                }
            }
        }
        count += files.len();
        out_slots.push(SlotFiles { slot: s, dir: found.map(|(_, d)| d.to_string_lossy().into_owned()), files });
    }
    let other = other
        .iter()
        .map(|d| OtherDir {
            path: d.to_string_lossy().into_owned(),
            name: d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            files: list_files(d, SLOT_DEPTH).len(),
        })
        .collect();
    if modified == 0 {
        modified = fs::metadata(dir).map(|m| mtime_ms(&m)).unwrap_or(0);
    }
    let (assets_dir, assets) = if client.is_empty() {
        (None, Vec::new())
    } else {
        let a = root.join(client).join(ASSETS);
        if a.is_dir() {
            (Some(a.to_string_lossy().into_owned()), list_files(&a, SLOT_DEPTH))
        } else {
            (None, Vec::new())
        }
    };
    let summary = Summary {
        path: dir.to_string_lossy().into_owned(),
        client: client.to_string(),
        name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        phase,
        correction,
        deadline: brief.as_ref().and_then(|b| b.deadline.clone()),
        status: brief.as_ref().and_then(|b| b.status.clone()),
        done: brief.as_ref().is_some_and(|b| b.done),
        next: brief.as_ref().and_then(|b| b.next.clone()),
        modified,
        files: count,
        cover: cover.or(research_cover),
        open_invoices,
        open_amount,
    };
    Project { summary, brief, slots: out_slots, other, assets_dir, assets }
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            !n.starts_with('.') && !n.starts_with('_') && !skip_dir(&n)
        })
        .collect();
    v.sort();
    v
}

/// Kunde und Projekt zu einem Projektordner (Kunde "" bei Projekten direkt in der Wurzel)
fn locate_project(root: &Path, dir: &Path) -> Option<String> {
    let rel = dir.strip_prefix(root).ok()?;
    let parts: Vec<_> = rel.components().collect();
    match parts.len() {
        1 => Some(String::new()),
        2 => Some(parts[0].as_os_str().to_string_lossy().into_owned()),
        _ => None,
    }
}

pub fn scan(root: &Path) -> Overview {
    let st = load_state(root);
    let mut clients = Vec::new();
    let mut projects = Vec::new();
    for top in subdirs(root) {
        let name = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if looks_like_project(&top) {
            projects.push(read_project(root, "", &top, &st).summary);
            continue;
        }
        clients.push(name.clone());
        for p in subdirs(&top) {
            projects.push(read_project(root, &name, &p, &st).summary);
        }
    }
    Overview { root: root.to_string_lossy().into_owned(), clients, projects }
}

pub fn project(root: &Path, dir: &Path) -> Result<Project, String> {
    let client = locate_project(root, dir).ok_or("Kein Projekt in Works")?;
    if !dir.is_dir() {
        return Err("works-missing".into());
    }
    Ok(read_project(root, &client, dir, &load_state(root)))
}

// ---- Schreiben ----

fn clean_name(s: &str) -> Result<String, String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 120 || s.starts_with('.') || s.contains(['/', '\\', ':']) || s == ".." {
        return Err("works-name".into());
    }
    Ok(s.to_string())
}

/// Neues Projekt: Kunde/Projekt mit den sechs Ordnern, _Assets beim Kunden, brief.md
pub fn create_project(root: &Path, client: &str, name: &str, lang: &str) -> Result<PathBuf, String> {
    let name = clean_name(name)?;
    let client = client.trim();
    let base = if client.is_empty() { root.to_path_buf() } else { root.join(clean_name(client)?) };
    let dir = base.join(&name);
    if dir.exists() {
        return Err("works-exists".into());
    }
    for s in SLOTS {
        fs::create_dir_all(dir.join(s.folder(lang))).map_err(|e| e.to_string())?;
    }
    if !client.is_empty() {
        create_assets(&base, lang)?;
    }
    let brief = dir.join(Slot::Brief.folder(lang)).join(BRIEF_FILE);
    fs::write(&brief, brief_template(client, &name, lang)).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// _Assets beim Kunden mit Logos, Schriften, Farben, Bilder (bestehende bleiben)
pub fn create_assets(client_dir: &Path, lang: &str) -> Result<PathBuf, String> {
    let assets = client_dir.join(ASSETS);
    let subs: [&str; 4] = if lang == "en" { ["Logos", "Fonts", "Colours", "Images"] } else { ["Logos", "Schriften", "Farben", "Bilder"] };
    for sub in subs {
        fs::create_dir_all(assets.join(sub)).map_err(|e| e.to_string())?;
    }
    Ok(assets)
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

/// Neuer Stand: Kopie mit nächster Kennung im selben Ordner, nie über eine bestehende Datei
pub fn new_version(path: &Path) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err("works-missing".into());
    }
    let dir = path.parent().ok_or("works-missing")?;
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    // Höchster Stand derselben Arbeit im Ordner, egal welches Format („V3_KORR.pdf“
    // neben „V2.indd“): der neue Stand bekommt die Nummer danach
    let key = version_of(&name).key;
    let mut n = version_number(&name).map(|(_, n, _)| n).unwrap_or(1);
    for e in fs::read_dir(dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()) {
        let other = e.file_name().to_string_lossy().into_owned();
        if !is_noise(&other) && version_of(&other).key == key {
            n = n.max(version_number(&other).map(|(_, m, _)| m).unwrap_or(1));
        }
    }
    let mut dest = dir.join(version_name(&name, n + 1));
    while dest.exists() && n < 999 {
        n += 1;
        dest = dir.join(version_name(&name, n + 1));
    }
    if dest.exists() {
        return Err("works-exists".into());
    }
    copy_new(path, &dest)?;
    // Der neue Stand ist der neueste, auch wenn das System das Datum mitkopiert
    if let Ok(f) = fs::OpenOptions::new().write(true).open(&dest) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
    Ok(dest)
}

/// Dateien in einen Phasenordner kopieren (Ziehen aus Archiver oder dem Finder)
pub fn import(project: &Path, slot: Slot, paths: &[PathBuf], lang: &str) -> Result<usize, String> {
    let (slots, _) = project_slots(project);
    let dir = slots.iter().find(|(s, _)| *s == slot).map(|(_, d)| d.clone()).unwrap_or_else(|| project.join(slot.folder(lang)));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut n = 0;
    for src in paths {
        if !src.is_file() || src.parent() == Some(dir.as_path()) {
            continue;
        }
        let name = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if is_noise(&name) {
            continue;
        }
        copy_new(src, &free_name(&dir, &name))?;
        n += 1;
    }
    Ok(n)
}

pub fn save_brief(project: &Path, text: &str, lang: &str) -> Result<PathBuf, String> {
    if text.len() > 256 * 1024 {
        return Err("works-large".into());
    }
    let (slots, _) = project_slots(project);
    let path = find_brief(project, &slots).unwrap_or_else(|| {
        let dir = slots.iter().find(|(s, _)| *s == Slot::Brief).map(|(_, d)| d.clone()).unwrap_or_else(|| project.join(Slot::Brief.folder(lang)));
        dir.join(BRIEF_FILE)
    });
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::library::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path)
}

// ---- Vorschauen ----

/// Vorschau zwischengespeichert unter <Wurzel>/.archiver/thumbs, nach Pfad,
/// Änderungsdatum und Größe. Bilder über image, alles andere über Quick Look.
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

/// Betreffen Dateisystem-Ereignisse Works? Vorschauen, Lock- und Temp-Dateien nicht.
pub fn relevant_change(paths: &[PathBuf]) -> bool {
    paths.iter().any(|p| {
        !p.components().any(|c| c.as_os_str() == META_DIR)
            && !p.file_name().map(|n| is_noise(&n.to_string_lossy())).unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn root_detection() {
        let root = std::env::temp_dir().join(format!("works-root-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Design/Plakate")).unwrap();
        fs::write(root.join("Design/Plakate/a.jpg"), b"x").unwrap();
        assert!(!looks_like_root(&root));
        create_project(&root, "Via", "Website", "de").unwrap();
        assert!(looks_like_root(&root));
        let _ = fs::remove_dir_all(&root);
    }

    use super::*;

    #[test]
    fn folders_by_word() {
        assert_eq!(slot_of_folder("00 Post"), Some(Slot::Post));
        assert_eq!(slot_of_folder("01 Brief"), Some(Slot::Brief));
        assert_eq!(slot_of_folder("02_Recherche"), Some(Slot::Research));
        assert_eq!(slot_of_folder("03 Layout"), Some(Slot::Layout));
        assert_eq!(slot_of_folder("Entwürfe"), Some(Slot::Layout));
        assert_eq!(slot_of_folder("04 Reinzeichnung"), Some(Slot::Final));
        assert_eq!(slot_of_folder("Druckdaten"), Some(Slot::Final));
        assert_eq!(slot_of_folder("Final Export"), Some(Slot::Delivery));
        assert_eq!(slot_of_folder("05 Übergabe"), Some(Slot::Delivery));
        assert_eq!(slot_of_folder("Rechnungen"), Some(Slot::Post));
        assert_eq!(slot_of_folder("01 Fotos"), None);
        assert_eq!(slot_of_folder("2026"), None);
    }

    #[test]
    fn noise_files() {
        for n in ["~Plakat~abc.idlk", ".DS_Store", "~$Angebot.docx", "datei.tmp", "._Plakat.indd"] {
            assert!(is_noise(n), "{n}");
        }
        assert!(!is_noise("Plakat_V1.indd"));
    }

    #[test]
    fn versions() {
        let v = version_of("Plakat_A1_V3_KORR.indd");
        assert_eq!((v.stem.as_str(), v.tag.as_str()), ("Plakat_A1", "V3 KORR"));
        assert_eq!(version_of("Plakat_A1_V1.indd").key, version_of("Plakat A1 RZ.pdf").key);
        assert_eq!(version_of("Plakat A1.indd").tag, "");
        // Sonderzeichen kurz vor dem Ende brachten den Scan zum Absturz (0.38.2)
        assert_eq!(version_of("Erscheinungsbild – Auftrag.eml").stem, "Erscheinungsbild – Auftrag");
        for n in ["Angebot – Auftrag.eml", "Plakat_Eröffnung.pdf", "Café_Übergabe_V2.indd", "Notiz ✓ fertig.txt"] {
            let _ = version_of(n);
        }
        assert_eq!(version_of("Katalog Version 4.pdf").tag, "V4");
        assert_eq!(version_of("Katalog Version 4.pdf").stem, "Katalog");
        assert_eq!(version_of("Flyer_2026-10-14.pdf").tag, "2026-10-14");
        assert_eq!(version_of("V1.indd").stem, "V1");
        assert_eq!(version_of("Logo_final_final.ai").tag, "FINAL FINAL");
    }

    #[test]
    fn next_versions() {
        assert_eq!(next_version_name("Plakat_A1_V3_KORR.indd"), "Plakat_A1_V4.indd");
        assert_eq!(next_version_name("Plakat_A1_v09.indd"), "Plakat_A1_v10.indd");
        assert_eq!(next_version_name("Plakat A1.indd"), "Plakat A1 V2.indd");
        assert_eq!(next_version_name("Plakat_A1_RZ.indd"), "Plakat_A1_V2.indd");
        assert_eq!(next_version_name("Plakat-A1-V2.indd"), "Plakat-A1-V3.indd");
    }

    #[test]
    fn amounts() {
        assert_eq!(parse_amount("1.850,00"), Some(185000));
        assert_eq!(parse_amount("1850"), Some(185000));
        assert_eq!(parse_amount("4.200"), Some(420000));
        assert_eq!(parse_amount("1850.50"), Some(185050));
        assert_eq!(parse_amount("12,5"), None);
    }

    #[test]
    fn post_names() {
        let p = post_of_name("Rechnung_2026-014_1.850,00 EUR.pdf").unwrap();
        assert_eq!((p.kind, p.number.as_deref(), p.amount), ("invoice", Some("2026-014"), Some(185000)));
        let p = post_of_name("RE-2026-014 Kunsthalle 1850€.pdf").unwrap();
        assert_eq!((p.kind, p.number.as_deref(), p.amount), ("invoice", Some("2026-014"), Some(185000)));
        let p = post_of_name("Angebot 2026-031 EUR 4.200.pdf").unwrap();
        assert_eq!((p.kind, p.amount), ("offer", Some(420000)));
        let p = post_of_name("Angebot Plakat.pdf").unwrap();
        assert_eq!((p.kind, p.amount, p.number), ("offer", None, None));
        assert!(post_of_name("Ankündigung.pdf").is_none());
        assert!(post_of_name("an Frau Weber.pdf").is_none());
        assert!(post_of_name("Angebotsentwurf.docx").is_none());
        // Ohne „EUR“ oder „€“ kein Betrag, auch wenn eine Zahl im Namen steht
        assert_eq!(post_of_name("Rechnung 2026-014 1850.pdf").unwrap().amount, None);
    }

    #[test]
    fn mails() {
        let raw = b"From: =?utf-8?Q?J=C3=BCrgen_Weber?= <weber@example.org>\r\nSubject: =?utf-8?B?S29ycmVrdHVyIFBsYWthdA==?=\r\n =?utf-8?Q?_V3?=\r\nDate: Tue, 14 Oct 2026 09:12:00 +0200\r\n\r\nHallo";
        let m = parse_mail(raw);
        assert_eq!(m.subject.as_deref(), Some("Korrektur Plakat V3"));
        assert_eq!(m.from.as_deref(), Some("Jürgen Weber"));
        assert_eq!(m.date, 1_791_961_920_000);
        let emlx = b"123\nSubject: Hallo\nFrom: a@b.de\n\nText";
        let m = parse_mail(emlx);
        assert_eq!((m.subject.as_deref(), m.from.as_deref()), (Some("Hallo"), Some("a@b.de")));
    }

    #[test]
    fn briefs() {
        let b = parse_brief("---\ntermin: 30.10.2026\nstatus: laufend\nnächster schritt: V3 schicken\n---\n# Plakat\n");
        assert_eq!(b.deadline.as_deref(), Some("2026-10-30"));
        assert_eq!(b.next.as_deref(), Some("V3 schicken"));
        assert!(!b.done);
        assert!(parse_brief("---\nstatus: Abgeschlossen\n---\n").done);
        assert_eq!(parse_brief("# Ohne Kopf\ntermin: 2026-01-01").deadline, None);
        let t = parse_brief(&brief_template("Kunde", "Projekt", "de"));
        assert_eq!((t.deadline, t.done), (None, false));
    }

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"x").unwrap();
    }

    #[test]
    fn project_phase_and_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = create_project(root, "Kunsthalle", "2026-014 Plakat", "de").unwrap();
        assert!(root.join("Kunsthalle/_Assets/Logos").is_dir());
        assert!(dir.join("01 Brief/brief.md").is_file());
        assert!(matches!(create_project(root, "Kunsthalle", "2026-014 Plakat", "de"), Err(e) if e == "works-exists"));
        assert!(create_project(root, "Kunsthalle", "../x", "de").is_err());

        let ov = scan(root);
        assert_eq!(ov.clients, vec!["Kunsthalle".to_string()]);
        assert_eq!(ov.projects[0].phase, Some(0));

        touch(&dir.join("03 Layout/Plakat_V1.indd"));
        touch(&dir.join("03 Layout/~Plakat_V1~abc.idlk"));
        touch(&dir.join("03 Layout/Links/foto.tif"));
        touch(&dir.join("00 Post/Rechnung_2026-014_1.850,00 EUR.pdf"));
        let p = project(root, &dir).unwrap();
        assert_eq!(p.summary.phase, Some(2));
        let layout = p.slots.iter().find(|s| s.slot == Slot::Layout).unwrap();
        assert_eq!(layout.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["Plakat_V1.indd"]);
        assert_eq!((p.summary.open_invoices, p.summary.open_amount), (1, 185000));

        let inv = dir.join("00 Post/Rechnung_2026-014_1.850,00 EUR.pdf");
        set_paid(root, &inv, true, 1).unwrap();
        assert_eq!(project(root, &dir).unwrap().summary.open_invoices, 0);
        set_paid(root, &inv, false, 1).unwrap();
        assert_eq!(project(root, &dir).unwrap().summary.open_invoices, 1);

        // Neuer Stand: Kopie daneben, das Original bleibt
        let v2 = new_version(&dir.join("03 Layout/Plakat_V1.indd")).unwrap();
        assert_eq!(v2.file_name().unwrap(), "Plakat_V2.indd");
        assert!(dir.join("03 Layout/Plakat_V1.indd").is_file());
        let v3 = new_version(&dir.join("03 Layout/Plakat_V1.indd")).unwrap();
        assert_eq!(v3.file_name().unwrap(), "Plakat_V3.indd");
        // Aus V2 wird V5, wenn es schon einen V4 in anderem Format gibt
        touch(&dir.join("03 Layout/Plakat_V4_KORR.pdf"));
        let v5 = new_version(&dir.join("03 Layout/Plakat_V2.indd")).unwrap();
        assert_eq!(v5.file_name().unwrap(), "Plakat_V5.indd");

        // Kopieren nach Recherche, doppelte Namen bekommen eine Nummer
        let src = tmp.path().join("ref.jpg");
        fs::write(&src, b"x").unwrap();
        assert_eq!(import(&dir, Slot::Research, &[src.clone(), src.clone()], "de").unwrap(), 2);
        assert!(dir.join("02 Recherche/ref 2.jpg").is_file());

        // Brief speichern und lesen
        save_brief(&dir, "---\ntermin: 2026-10-30\nstatus: abgeschlossen\n---\n", "de").unwrap();
        let s = &scan(root).projects[0];
        assert_eq!((s.deadline.as_deref(), s.done), (Some("2026-10-30"), true));
        assert_eq!(s.phase, Some(2));

        // Nur in der Wurzel, nie in .archiver
        assert!(inside(root, &dir).is_some());
        assert!(inside(root, &root.join(".archiver/works.json")).is_none());
        assert!(inside(root, tmp.path().parent().unwrap()).is_none());
    }

    #[test]
    fn project_without_client_and_own_names() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("Website Relaunch/Entwürfe/Start_V2.fig"));
        touch(&root.join("Website Relaunch/Druckdaten/Visitenkarte.pdf"));
        touch(&root.join("Website Relaunch/Fotos/a.jpg"));
        let ov = scan(root);
        assert!(ov.clients.is_empty());
        let s = &ov.projects[0];
        assert_eq!((s.client.as_str(), s.phase), ("", Some(3)));
        let p = project(root, &root.join("Website Relaunch")).unwrap();
        assert_eq!(p.other.len(), 1);
        assert_eq!(p.other[0].name, "Fotos");
    }

    #[test]
    fn changes_that_count() {
        assert!(!relevant_change(&[PathBuf::from("/w/.archiver/thumbs/a.jpg")]));
        assert!(!relevant_change(&[PathBuf::from("/w/K/P/03 Layout/~Plakat~x.idlk")]));
        assert!(relevant_change(&[PathBuf::from("/w/K/P/03 Layout/Plakat_V2.indd")]));
    }
}

