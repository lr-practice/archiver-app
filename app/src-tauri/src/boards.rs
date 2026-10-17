//! Boards (0.39.0): Präsentationen aus Bildern der Bibliothek.
//!
//! Ein Board ist eine lesbare JSON-Datei `Bibliothek/Boards/Name.board`,
//! sichtbar im Finder. Bilder stehen darin nur als Verweis (Hash und Pfad),
//! nie als Kopie. Der Ordner `Boards` ist keine Zone (`Library::zones`).

use crate::library::write_atomic;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

pub const DIR: &str = "Boards";
const EXT: &str = "board";

#[derive(Serialize, Debug)]
pub struct BoardInfo {
    pub name: String,
    pub path: String,
    pub modified: i64,
    /// Kopf der Datei: Name, Anzahl der Folien und die erste Folie, für die Karte
    pub head: serde_json::Value,
}

fn dir(root: &Path) -> PathBuf {
    root.join(DIR)
}

/// Name ohne Pfadzeichen, nicht leer, ohne Punkt am Anfang
pub fn clean_name(name: &str) -> Result<String> {
    let n: String = name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '-' } else { c }).collect();
    let n = n.trim().trim_start_matches('.').trim().to_string();
    if n.is_empty() {
        return Err("Kein Name".into());
    }
    Ok(n.chars().take(120).collect())
}

fn file(root: &Path, name: &str) -> Result<PathBuf> {
    Ok(dir(root).join(format!("{}.{EXT}", clean_name(name)?)))
}

fn mtime(p: &Path) -> i64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Alle Boards, zuletzt geändert zuerst
pub fn list(root: &Path) -> Result<Vec<BoardInfo>> {
    let Ok(rd) = fs::read_dir(dir(root)) else { return Ok(vec![]) };
    let mut out = vec![];
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case(EXT)) != Some(true) {
            continue;
        }
        let Some(name) = p.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        if name.starts_with('.') {
            continue;
        }
        let doc: serde_json::Value = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let slides = doc.get("slides").and_then(|s| s.as_array());
        let head = serde_json::json!({
            "name": doc.get("name").cloned().unwrap_or(serde_json::Value::Null),
            "count": slides.map(|s| s.len()).unwrap_or(0),
            "first": slides.and_then(|s| s.first()).cloned().unwrap_or(serde_json::Value::Null),
        });
        out.push(BoardInfo { modified: mtime(&p), path: p.to_string_lossy().into_owned(), name, head });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

pub fn read(root: &Path, name: &str) -> Result<String> {
    let p = file(root, name)?;
    fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))
}

pub fn write(root: &Path, name: &str, data: &str) -> Result<()> {
    serde_json::from_str::<serde_json::Value>(data).map_err(|e| format!("Board: {e}"))?;
    fs::create_dir_all(dir(root)).map_err(|e| e.to_string())?;
    write_atomic(&file(root, name)?, data.as_bytes())
}

/// Freier Name: „Board“, „Board 2“, „Board 3“ …
pub fn free_name(root: &Path, want: &str) -> Result<String> {
    let base = clean_name(want)?;
    let mut name = base.clone();
    let mut n = 2;
    while file(root, &name)?.exists() {
        name = format!("{base} {n}");
        n += 1;
    }
    Ok(name)
}

pub fn create(root: &Path, want: &str, data: &str) -> Result<String> {
    let name = free_name(root, want)?;
    write(root, &name, data)?;
    Ok(name)
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<String> {
    let to = clean_name(to)?;
    if to == clean_name(from)? {
        return Ok(to);
    }
    let target = file(root, &to)?;
    // Nur Groß-/Kleinschreibung geändert: auf APFS dieselbe Datei
    if target.exists() && !to.eq_ignore_ascii_case(from) {
        return Err(format!("„{to}“ gibt es schon"));
    }
    fs::rename(file(root, from)?, &target).map_err(|e| e.to_string())?;
    Ok(to)
}

/// In den Papierkorb des Macs, nicht endgültig
pub fn delete(root: &Path, name: &str) -> Result<()> {
    trash::delete(file(root, name)?).map_err(|e| e.to_string())
}

/// Fünf Farben aus einem Bild (k-means auf 40 × 40), häufigste zuerst
pub fn palette(path: &Path) -> Result<Vec<String>> {
    let img = image::open(path).map_err(|e| e.to_string())?;
    let small = img.resize_exact(40, 40, image::imageops::FilterType::Triangle).to_rgb8();
    let px: Vec<[f32; 3]> = small.pixels().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect();
    Ok(kmeans(&px, 5))
}

fn kmeans(px: &[[f32; 3]], k: usize) -> Vec<String> {
    if px.is_empty() {
        return vec![];
    }
    let mut cent: Vec<[f32; 3]> = (0..k).map(|i| px[i * (px.len() - 1) / (k - 1).max(1)]).collect();
    let mut count = vec![0usize; k];
    for _ in 0..10 {
        let mut acc = vec![[0f32; 3]; k];
        count = vec![0; k];
        for p in px {
            let mut best = 0;
            let mut bd = f32::MAX;
            for (j, c) in cent.iter().enumerate() {
                let d = (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) + (p[2] - c[2]).powi(2);
                if d < bd {
                    bd = d;
                    best = j;
                }
            }
            for i in 0..3 {
                acc[best][i] += p[i];
            }
            count[best] += 1;
        }
        for j in 0..k {
            if count[j] > 0 {
                cent[j] = [acc[j][0] / count[j] as f32, acc[j][1] / count[j] as f32, acc[j][2] / count[j] as f32];
            }
        }
    }
    let mut order: Vec<usize> = (0..k).filter(|&j| count[j] > 0).collect();
    order.sort_by(|a, b| count[*b].cmp(&count[*a]));
    let mut out: Vec<[f32; 3]> = vec![];
    for j in order {
        let c = cent[j];
        // fast gleiche Farben nur einmal
        if out.iter().all(|o| (o[0] - c[0]).powi(2) + (o[1] - c[1]).powi(2) + (o[2] - c[2]).powi(2) > 1600.0) {
            out.push(c);
        }
    }
    out.iter().map(|c| format!("#{:02x}{:02x}{:02x}", c[0].round() as u8, c[1].round() as u8, c[2].round() as u8)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(list(root).unwrap().is_empty());
        assert_eq!(clean_name(" a/b: c ").unwrap(), "a-b- c");
        assert!(clean_name("  ").is_err());
        let a = create(root, "Kunsthalle", r#"{"name":"Kunsthalle","slides":[{"id":"x"}]}"#).unwrap();
        let b = create(root, "Kunsthalle", r#"{"name":"Kunsthalle","slides":[]}"#).unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("Kunsthalle", "Kunsthalle 2"));
        assert!(write(root, "Kaputt", "{nein").is_err());
        let all = list(root).unwrap();
        assert_eq!(all.len(), 2);
        let k = all.iter().find(|i| i.name == "Kunsthalle").unwrap();
        assert_eq!(k.head["count"], 1);
        assert_eq!(k.head["first"]["id"], "x");
        assert!(rename(root, "Kunsthalle 2", "Kunsthalle").is_err());
        assert_eq!(rename(root, "Kunsthalle 2", "Haltung").unwrap(), "Haltung");
        assert!(read(root, "Haltung").unwrap().contains("slides"));
        assert!(root.join("Boards/Haltung.board").exists());
    }

    #[test]
    fn kmeans_finds_two_colors() {
        let mut px = vec![[255.0, 0.0, 0.0]; 60];
        px.extend(vec![[0.0, 0.0, 0.0]; 40]);
        let out = kmeans(&px, 5);
        assert_eq!(out, vec!["#ff0000".to_string(), "#000000".to_string()]);
    }
}
