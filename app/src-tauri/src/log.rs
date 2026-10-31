// log.rs
// Ein schlichtes Protokoll unter ~/Library/Logs/Archery/archery.log (0.31.0,
// bis 0.43.2 ~/Library/Logs/Archiver/archiver.log, wird beim ersten Schreiben übernommen).
// App und Brücke (eigener Prozess) schreiben hinein; jede Zeile ist ein
// eigenes append, damit sich beide nicht in die Quere kommen. Ab 1 MB wird die
// Datei zu archery.log.1 und neu begonnen. Fehler beim Protokollieren selbst
// werden ignoriert: das Protokoll darf nie die eigentliche Arbeit stören.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

const MAX_BYTES: u64 = 1024 * 1024;

pub fn path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let (old, dir) = dirs::home_dir().map(|h| (h.join("Library/Logs/Archiver"), h.join("Library/Logs/Archery"))).unzip();
    #[cfg(not(target_os = "macos"))]
    let (old, dir) = dirs::data_local_dir().map(|d| (d.join("Archiver/logs"), d.join("Archery/logs"))).unzip();
    let (old, dir) = (old?, dir?);
    adopt_old(&old, &dir);
    Some(dir.join("archery.log"))
}

/// Altes Protokoll (bis 0.43.2) einmal übernehmen: Ordner umbenennen, Datei mit.
fn adopt_old(old: &std::path::Path, dir: &std::path::Path) {
    if dir.exists() || !old.is_dir() {
        return;
    }
    if fs::rename(old, dir).is_ok() {
        for (from, to) in [("archiver.log", "archery.log"), ("archiver.log.1", "archery.log.1")] {
            let _ = fs::rename(dir.join(from), dir.join(to));
        }
    }
}

fn write(level: &str, area: &str, msg: &str) {
    if let Some(file) = path() {
        write_to(&file, level, area, msg);
    }
}

fn write_to(file: &std::path::Path, level: &str, area: &str, msg: &str) {
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if fs::metadata(file).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(file, file.with_extension("log.1"));
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = format!("{secs} {level} [{area}] {}\n", msg.replace('\n', " ⏎ "));
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(file) {
        let _ = f.write_all(line.as_bytes());
    }
    #[cfg(debug_assertions)]
    eprint!("{line}");
}

pub fn error(area: &str, msg: impl std::fmt::Display) {
    write("ERROR", area, &msg.to_string());
}

pub fn warn(area: &str, msg: impl std::fmt::Display) {
    write("WARN", area, &msg.to_string());
}

/// Ergebnis protokollieren, ohne es zu verbrauchen: `log::check("scan", lib.scan())`
pub fn check<T, E: std::fmt::Display>(area: &str, r: Result<T, E>) -> Result<T, E> {
    if let Err(e) = &r {
        error(area, e);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_per_entry_and_rotation() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("Logs/archiver.log");
        write_to(&file, "ERROR", "scan", "Ordner\nnicht lesbar");
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text.lines().count(), 1, "Zeilenumbruch in der Meldung bleibt eine Zeile");
        assert!(text.contains("ERROR [scan] Ordner ⏎ nicht lesbar"));
        fs::write(&file, vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        write_to(&file, "WARN", "bridge", "neu");
        assert!(file.with_extension("log.1").is_file(), "alte Datei beiseitegelegt");
        assert!(fs::read_to_string(&file).unwrap().starts_with(|c: char| c.is_ascii_digit()));
        assert!(fs::metadata(&file).unwrap().len() < 200);
    }

    #[test]
    fn adopts_old_log_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, dir) = (tmp.path().join("Archiver"), tmp.path().join("Archery"));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("archiver.log"), "alt\n").unwrap();
        adopt_old(&old, &dir);
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(dir.join("archery.log")).unwrap(), "alt\n");
        // Gibt es den neuen Ordner schon, bleibt der alte, wie er ist
        fs::create_dir_all(&old).unwrap();
        adopt_old(&old, &dir);
        assert!(old.is_dir());
    }
}
