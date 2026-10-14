// naming.rs — Einheitliche Dateinamen (F10, 0.36.0) und Namensvorschlag aus dem
// Inhalt (F11). Nur vorhandene Daten: Datum, Zone, Quelle, Bibliothek, Nummer,
// Typ, dazu Seitentitel, Motiv und Farbe aus der Analyse. Kein Dienst, nichts
// verlässt den Mac. Umbenannt wird nur, was die Einstellungen sagen oder wer im
// Umbenennen-Blatt bestätigt.

use serde::{Deserialize, Serialize};

use crate::library::Item;

/// Einstellungen › Dateinamen. Ab Werk „original“: nichts wird umbenannt.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Naming {
    /// original, date-zone-nr, zone-nr, date-source-nr, zone-content, custom
    pub preset: String,
    /// Eigenes Schema: prefix, zone, date, nr, source, library, kind, content
    pub parts: Vec<String>,
    pub sep: String,
    /// iso (2026-10-14) oder short (261014)
    pub date: String,
    pub lower: bool,
    pub prefix: String,
    /// Beim Ablegen umbenennen (App und Extension)
    pub on_save: bool,
    /// Uneinheitliche Namen (IMG_…, Bild (3)) markieren
    pub flag: bool,
    /// Sprache für Typ, Motiv und Farbe (de, en), von der App gesetzt
    pub lang: String,
    /// Abstand zur UTC in Minuten, damit das Datum dem Kalender am Mac folgt
    pub tz: i64,
}

impl Default for Naming {
    fn default() -> Self {
        Naming {
            preset: "original".into(),
            parts: vec!["prefix".into(), "zone".into(), "date".into(), "nr".into()],
            sep: "-".into(),
            date: "short".into(),
            lower: true,
            prefix: String::new(),
            on_save: false,
            flag: true,
            lang: "de".into(),
            tz: 0,
        }
    }
}

impl Naming {
    pub fn active(&self) -> bool {
        self.preset != "original"
    }

    /// Bausteine und Trenner des gewählten Schemas
    fn layout(&self) -> (Vec<&str>, &str, &str, bool) {
        match self.preset.as_str() {
            "date-zone-nr" => (vec!["date", "zone", "nr"], "_", "iso", true),
            "zone-nr" => (vec!["zone", "nr"], "_", "iso", true),
            "date-source-nr" => (vec!["date", "source", "nr"], "_", "iso", true),
            "zone-content" => (vec!["zone", "content"], "_", "iso", true),
            _ => (self.parts.iter().map(|s| s.as_str()).collect(), self.sep.as_str(), self.date.as_str(), self.lower),
        }
    }
}

/// Was ein Name braucht, aus dem Objekt und seiner Umgebung.
pub struct Ctx<'a> {
    pub item: &'a Item,
    pub library: &'a str,
    /// laufende Nummer in der Zone, ab 1
    pub nr: usize,
}

/// Neuer Dateiname ohne Endung, None bei „Original behalten“ oder wenn nichts
/// Brauchbares herauskommt.
pub fn render(n: &Naming, c: &Ctx) -> Option<String> {
    if !n.active() {
        return None;
    }
    let (parts, sep, date_fmt, lower) = n.layout();
    let sep = match sep {
        "_" | "-" | "." | " " => sep,
        "·" => "·",
        "" => "",
        _ => "-",
    };
    let mut out: Vec<String> = Vec::new();
    for p in parts {
        let piece = match p {
            "prefix" => slug(&n.prefix, lower),
            "zone" => slug(&zone_word(&c.item.zone), lower),
            "date" => date(c.item.captured_at.unwrap_or(c.item.added_at), n.tz, date_fmt),
            "nr" => format!("{:03}", c.nr.max(1)),
            "source" => c.item.page_url.as_deref().map(domain_word).map(|d| slug(&d, lower)).unwrap_or_default(),
            "library" => slug(c.library, lower),
            "kind" => kind_word(c.item, &n.lang).to_string(),
            "content" => suggest(c.item, &n.lang).unwrap_or_default(),
            _ => String::new(),
        };
        if !piece.is_empty() {
            out.push(piece);
        }
    }
    // Zone_Inhalt ohne Inhalt: Nummer, damit zwei Objekte nicht gleich heißen
    if n.preset == "zone-content" && out.len() < 2 {
        out.push(format!("{:03}", c.nr.max(1)));
    }
    let name = out.join(sep);
    let name: String = name.chars().take(120).collect();
    let name = name.trim_matches(|ch: char| ch == '.' || ch == ' ' || ch == '-' || ch == '_').to_string();
    (!name.is_empty()).then_some(name)
}

/// Namensvorschlag aus dem Inhalt (F11): Seitentitel, Motiv, Farbe, etwa
/// „form-und-farbe_plakat_rot“. None, wenn nichts davon da ist.
pub fn suggest(item: &Item, lang: &str) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(t) = item.page_title.as_deref().map(title_words).filter(|t| !t.is_empty()) {
        parts.push(slug(&t, true));
    } else if let Some(q) = item.quote.as_deref().or(item.title.as_deref()) {
        let words: Vec<&str> = q.split_whitespace().take(4).collect();
        parts.push(slug(&words.join(" "), true));
    }
    if let Some(l) = item.labels.as_deref().and_then(|l| top_label(l, lang)) {
        if !parts.iter().any(|p| p.contains(&l)) {
            parts.push(l);
        }
    }
    if let Some(c) = item.colors.as_deref().and_then(|c| top_color(c, lang)) {
        parts.push(c.to_string());
    }
    parts.retain(|p| !p.is_empty());
    (!parts.is_empty()).then(|| parts.join("_"))
}

/// Uneinheitlicher Name: Kamera- und Systemnamen, Kopien, Zufallsketten.
pub fn messy(filename: &str) -> bool {
    let stem = filename.rsplit_once('.').map(|(s, _)| s).unwrap_or(filename).trim();
    let low = stem.to_lowercase();
    let starts = ["img_", "img-", "dsc", "dscf", "dscn", "pxl_", "photo_", "image", "bild", "screenshot", "bildschirmfoto", "untitled", "unbenannt", "download", "file", "whatsapp image", "snapshot"];
    if starts.iter().any(|s| low.starts_with(s)) {
        return true;
    }
    if low.ends_with(')') && low.rfind(" (").is_some() {
        return true; // Bild (3), x (1)
    }
    if low.contains(" kopie") || low.contains(" copy") || low.ends_with("-copy") {
        return true;
    }
    // lange Zufallsketten (Hash, UUID, Instagram-IDs)
    let alnum: String = low.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let digits = alnum.chars().filter(|c| c.is_ascii_digit()).count();
    alnum.len() >= 16 && digits * 3 >= alnum.len() && !low.contains(' ')
}

/// Kleinbuchstaben, Umlaute ausgeschrieben, Wörter mit Bindestrich.
pub fn slug(s: &str, lower: bool) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in s.chars() {
        let rep: Option<&str> = match ch {
            'ä' => Some("ae"),
            'ö' => Some("oe"),
            'ü' => Some("ue"),
            'Ä' => Some("Ae"),
            'Ö' => Some("Oe"),
            'Ü' => Some("Ue"),
            'ß' => Some("ss"),
            _ => None,
        };
        if let Some(r) = rep {
            out.push_str(r);
            dash = false;
        } else if ch.is_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    let out: String = out.chars().take(48).collect();
    let out = out.trim_end_matches('-').to_string();
    if lower {
        out.to_lowercase()
    } else {
        out
    }
}

/// Dateiname ohne Pfadzeichen, mit der alten Endung (für Eingaben im Blatt).
pub fn clean_stem(s: &str) -> String {
    let s: String = s.chars().filter(|c| !c.is_control() && *c != '/' && *c != ':' && *c != '\\').collect();
    let s = s.trim().trim_start_matches('.').trim();
    s.chars().take(160).collect()
}

fn zone_word(zone: &str) -> String {
    let last = zone.rsplit('/').next().unwrap_or(zone);
    last.trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '_' | '-' | '.' | ' ')).to_string()
}

fn domain_word(url: &str) -> String {
    let host = url.split("://").nth(1).unwrap_or(url).split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split('@').next_back().unwrap_or(host).split(':').next().unwrap_or(host);
    let host = host.strip_prefix("www.").unwrap_or(host);
    let parts: Vec<&str> = host.split('.').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => String::new(),
        1 => parts[0].to_string(),
        // co.uk, com.au: eine Ebene mehr wegnehmen
        n if n >= 3 && parts[n - 2].len() <= 3 && parts[n - 1].len() == 2 => parts[n - 3].to_string(),
        n => parts[n - 2].to_string(),
    }
}

/// Seitentitel ohne Site-Namen: „Form und Farbe – Plakat | museum-digital“ → „Form und Farbe“
fn title_words(t: &str) -> String {
    let first = t.split([ '|', '–', '—', '·', '•']).next().unwrap_or(t);
    let first = first.split(" - ").next().unwrap_or(first);
    let first = first.split(" on Instagram").next().unwrap_or(first);
    let words: Vec<&str> = first.split_whitespace().take(5).collect();
    words.join(" ")
}

fn kind_word(item: &Item, lang: &str) -> &'static str {
    let ext = item.filename.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
    let de = lang != "en";
    if crate::library::NOTE_EXTS.contains(&ext.as_str()) {
        return if de { "notiz" } else { "note" };
    }
    if item.quote.is_some() {
        return "text";
    }
    if crate::library::PDF_EXTS.contains(&ext.as_str()) {
        return "pdf";
    }
    if crate::library::VIDEO_EXTS.contains(&ext.as_str()) {
        return "video";
    }
    if crate::library::AUDIO_EXTS.contains(&ext.as_str()) {
        return if de { "ton" } else { "audio" };
    }
    if de {
        "bild"
    } else {
        "image"
    }
}

/// Sicherstes Motiv ab 0,5 (wie Suche und Motiv-Filter), auf Deutsch, wo bekannt
fn top_label(labels: &str, lang: &str) -> Option<String> {
    let mut best: Option<(&str, f32)> = None;
    for part in labels.split([',', ' ']).map(str::trim).filter(|p| !p.is_empty()) {
        let (name, conf) = match part.rsplit_once(':') {
            Some((n, c)) => (n, c.parse::<f32>().unwrap_or(0.0)),
            None => continue,
        };
        if conf >= 0.5 && best.is_none_or(|(_, b)| conf > b) {
            best = Some((name, conf));
        }
    }
    let (name, _) = best?;
    let name = name.replace('_', " ");
    let de = [
        ("poster", "plakat"),
        ("typography", "typografie"),
        ("text", "text"),
        ("document", "dokument"),
        ("book", "buch"),
        ("magazine", "magazin"),
        ("people", "menschen"),
        ("adult", "menschen"),
        ("portrait", "portraet"),
        ("architecture", "architektur"),
        ("building", "gebaeude"),
        ("interior room", "innenraum"),
        ("furniture", "moebel"),
        ("chair", "stuhl"),
        ("landscape", "landschaft"),
        ("sky", "himmel"),
        ("water", "wasser"),
        ("plant", "pflanze"),
        ("flower", "blume"),
        ("food", "essen"),
        ("animal", "tier"),
        ("car", "auto"),
        ("illustration", "illustration"),
        ("painting", "gemaelde"),
        ("art", "kunst"),
        ("drawing", "zeichnung"),
        ("logo", "logo"),
        ("sign", "schild"),
        ("packaging", "verpackung"),
        ("clothing", "kleidung"),
        ("shoes", "schuhe"),
        ("outdoor", "draussen"),
        ("structure", "struktur"),
        ("pattern", "muster"),
    ];
    let word = if lang == "en" { name } else { de.iter().find(|(e, _)| *e == name).map(|(_, d)| d.to_string()).unwrap_or(name) };
    Some(slug(&word, true))
}

/// Größter Farbanteil ab 25 %, außer Weiß und Grau (Papier, Hintergrund)
fn top_color(colors: &str, lang: &str) -> Option<&'static str> {
    for part in colors.split_whitespace() {
        let (name, share) = part.rsplit_once(':')?;
        let share: f32 = share.parse().unwrap_or(0.0);
        if share < 0.25 {
            return None;
        }
        if matches!(name, "white" | "gray") {
            continue;
        }
        let (en, de) = match name {
            "red" => ("red", "rot"),
            "orange" => ("orange", "orange"),
            "yellow" => ("yellow", "gelb"),
            "green" => ("green", "gruen"),
            "teal" => ("teal", "petrol"),
            "cyan" => ("cyan", "cyan"),
            "blue" => ("blue", "blau"),
            "purple" => ("purple", "violett"),
            "violet" => ("violet", "violett"),
            "pink" => ("pink", "rosa"),
            "brown" => ("brown", "braun"),
            "beige" => ("beige", "beige"),
            "black" => ("black", "schwarz"),
            _ => continue,
        };
        return Some(if lang == "en" { en } else { de });
    }
    None
}

/// Datum am Mac-Kalender: 2026-10-14 oder 261014
fn date(ms: i64, tz_min: i64, fmt: &str) -> String {
    let days = (ms + tz_min * 60_000).div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    if fmt == "short" {
        format!("{:02}{m:02}{d:02}", y.rem_euclid(100))
    } else {
        format!("{y}-{m:02}-{d:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn item(zone: &str, filename: &str) -> Item {
        Item {
            path: format!("{zone}/{filename}"),
            abs: String::new(),
            zone: zone.into(),
            folder: String::new(),
            filename: filename.into(),
            hash: "h".into(),
            bytes: 1,
            mtime: 0,
            added_at: 1_791_979_200_000, // 2026-10-14, 12 Uhr UTC
            width: None,
            height: None,
            format: "png".into(),
            thumb: None,
            image_url: None,
            page_url: Some("https://www.museum-digital.de/object/4821".into()),
            page_title: Some("Form und Farbe – Plakat, Dessau 1926 | museum-digital".into()),
            captured_at: None,
            labels: Some("poster:0.94, typography:0.71".into()),
            text: None,
            colors: Some("white:0.40 red:0.30 black:0.20".into()),
            pages: None,
            duration: None,
            quote: None,
            title: None,
            artist: None,
            album: None,
            sample_rate: None,
            bit_depth: None,
            channels: None,
            note: None,
            credit: None,
            license: None,
            internal: false,
            added_by: None,
            tone: None,
            caption: None,
            links: None,
        }
    }

    #[test]
    fn presets() {
        let it = item("01_Typo", "IMG_4821.png");
        let ctx = Ctx { item: &it, library: "Archiver", nr: 1 };
        let mut n = Naming::default();
        assert_eq!(render(&n, &ctx), None, "ab Werk bleibt der Name");
        n.preset = "date-zone-nr".into();
        assert_eq!(render(&n, &ctx).as_deref(), Some("2026-10-14_typo_001"));
        n.preset = "zone-nr".into();
        assert_eq!(render(&n, &ctx).as_deref(), Some("typo_001"));
        n.preset = "date-source-nr".into();
        assert_eq!(render(&n, &ctx).as_deref(), Some("2026-10-14_museum-digital_001"));
        n.preset = "zone-content".into();
        assert_eq!(render(&n, &ctx).as_deref(), Some("typo_form-und-farbe_plakat_rot"));
        n.preset = "custom".into();
        n.prefix = "AR".into();
        assert_eq!(render(&n, &ctx).as_deref(), Some("ar-typo-261014-001"));
        n.lower = false;
        n.sep = "_".into();
        n.parts = vec!["library".into(), "kind".into(), "nr".into()];
        assert_eq!(render(&n, &ctx).as_deref(), Some("Archiver_bild_001"));
    }

    #[test]
    fn suggestion_and_messy() {
        let it = item("Typo", "IMG_4821.png");
        assert_eq!(suggest(&it, "de").as_deref(), Some("form-und-farbe_plakat_rot"));
        assert_eq!(suggest(&it, "en").as_deref(), Some("form-und-farbe_poster_red"));
        for m in ["IMG_4821.png", "Bild (3).png", "Screenshot 2026-10-12 um 14.03.11.png", "DSC0012.jpg", "3f9a8c7d6e5b4a3f2e1d0c9b.jpg", "plakat Kopie.png"] {
            assert!(messy(m), "{m}");
        }
        for ok in ["bauhaus_plakat_final.png", "2026-10-14_typo_001.png", "form-und-farbe.png"] {
            assert!(!messy(ok), "{ok}");
        }
        assert_eq!(slug("Größe & Maß", true), "groesse-mass");
        assert_eq!(domain_word("https://news.bbc.co.uk/x"), "bbc");
        assert_eq!(clean_stem("  a/b:c  "), "abc");
    }
}
