//! Atlas als Bild (App 0.42.0): die ganze Anordnung als PNG. Die Lage rechnet
//! cloud.js aus, hier wird nur gesetzt: Grund, dann jedes Bild randlos auf
//! sein Feld zugeschnitten, in der Reihenfolge der Ebenen. Seit 0.42.1 liegen
//! darunter die Linien, gestrichelt wie am Schirm.

use image::{imageops::FilterType, DynamicImage, Rgb, RgbImage};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Lange Seite höchstens so groß, egal was die Oberfläche schickt
pub const MAX_SIDE: u32 = 4000;

#[derive(Clone, Debug, Deserialize)]
pub struct Sheet {
    pub width: u32,
    pub height: u32,
    pub bg: [u8; 3],
    /// Farbe der Linien, auf 45 % über dem Grund
    #[serde(default)]
    pub ink: [u8; 3],
    /// Bildpunkte je Bildschirmpunkt: Strich 1 und Striche 4/4 wachsen mit
    #[serde(default = "one")]
    pub scale: f64,
    /// Strecken [x1, y1, x2, y2] in Bildpunkten, unter den Bildern
    #[serde(default)]
    pub lines: Vec<[f64; 4]>,
    pub items: Vec<Piece>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Piece {
    /// Originaldatei (nur Bilder), sonst die Vorschau
    pub path: Option<PathBuf>,
    pub thumb: Option<PathBuf>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 1 deckend, 0.4 zurückgenommen (Vergleich)
    #[serde(default = "one")]
    pub alpha: f64,
}

fn one() -> f64 {
    1.0
}

fn open(path: &Path, need: u32) -> Option<DynamicImage> {
    let img = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    // Große Originale erst grob verkleinern, das spart beim Zuschneiden
    Some(if img.width().max(img.height()) > need * 2 { img.thumbnail(need * 2, need * 2) } else { img })
}

/// Setzt das Bild. Fehlende Dateien bleiben einfach leer.
pub fn compose(sheet: &Sheet) -> RgbImage {
    let k = (MAX_SIDE as f64 / sheet.width.max(sheet.height).max(1) as f64).min(1.0);
    let (w, h) = (((sheet.width as f64) * k).round().max(1.0) as u32, ((sheet.height as f64) * k).round().max(1.0) as u32);
    let mut out = RgbImage::from_pixel(w, h, Rgb(sheet.bg));
    dashes(&mut out, sheet, k);
    for p in &sheet.items {
        let (pw, ph) = ((p.w * k).round() as u32, (p.h * k).round() as u32);
        if pw == 0 || ph == 0 {
            continue;
        }
        let src = p.path.as_deref().and_then(|f| open(f, pw.max(ph))).or_else(|| p.thumb.as_deref().and_then(|f| open(f, pw.max(ph))));
        let Some(src) = src else { continue };
        let tile = src.resize_to_fill(pw, ph, FilterType::Triangle).to_rgba8();
        let a = p.alpha.clamp(0.0, 1.0);
        let (ox, oy) = ((p.x * k).round() as i64, (p.y * k).round() as i64);
        for (tx, ty, px) in tile.enumerate_pixels() {
            let (x, y) = (ox + tx as i64, oy + ty as i64);
            if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
                continue;
            }
            let m = a * px[3] as f64 / 255.0;
            let d = out.get_pixel_mut(x as u32, y as u32);
            for c in 0..3 {
                d[c] = (px[c] as f64 * m + d[c] as f64 * (1.0 - m)).round() as u8;
            }
        }
    }
    out
}

/// Gestrichelte Linien: erst als Maske, damit Überlappungen nicht doppelt decken
fn dashes(out: &mut RgbImage, sheet: &Sheet, k: f64) {
    if sheet.lines.is_empty() {
        return;
    }
    let (w, h) = (out.width() as i64, out.height() as i64);
    let s = sheet.scale.max(0.1) * k;
    let half = (s / 2.0).max(0.5);
    let dash = 4.0 * s;
    let mut mask = vec![false; (w * h) as usize];
    for l in &sheet.lines {
        let [x1, y1, x2, y2] = l.map(|v| v * k);
        let len = ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt();
        let steps = (len * 2.0).ceil() as usize;
        for i in 0..=steps {
            let d = if steps == 0 { 0.0 } else { len * i as f64 / steps as f64 };
            if (d / dash) as u64 % 2 == 1 {
                continue;
            }
            let t = if len > 0.0 { d / len } else { 0.0 };
            let (cx, cy) = (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
            for y in (cy - half).floor() as i64..(cy + half).ceil() as i64 {
                for x in (cx - half).floor() as i64..(cx + half).ceil() as i64 {
                    if x >= 0 && y >= 0 && x < w && y < h {
                        mask[(y * w + x) as usize] = true;
                    }
                }
            }
        }
    }
    for (i, on) in mask.iter().enumerate() {
        if *on {
            let d = out.get_pixel_mut((i as i64 % w) as u32, (i as i64 / w) as u32);
            for c in 0..3 {
                d[c] = (sheet.ink[c] as f64 * 0.45 + d[c] as f64 * 0.55).round() as u8;
            }
        }
    }
}

pub fn write_png(sheet: &Sheet, dest: &Path) -> Result<(), String> {
    let img = compose(sheet);
    img.save_with_format(dest, image::ImageFormat::Png).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_places_and_caps() {
        let dir = std::env::temp_dir().join(format!("atlas-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let red = dir.join("red.png");
        RgbImage::from_pixel(40, 20, Rgb([255, 0, 0])).save(&red).unwrap();
        let sheet = Sheet {
            width: 100,
            height: 50,
            bg: [10, 10, 10],
            ink: [0, 0, 0],
            scale: 1.0,
            lines: vec![],
            items: vec![
                Piece { path: Some(red.clone()), thumb: None, x: 10.0, y: 10.0, w: 20.0, h: 20.0, alpha: 1.0 },
                Piece { path: None, thumb: Some(dir.join("fehlt.png")), x: 60.0, y: 10.0, w: 20.0, h: 20.0, alpha: 1.0 },
                Piece { path: Some(red), thumb: None, x: 90.0, y: 40.0, w: 20.0, h: 20.0, alpha: 0.4 },
            ],
        };
        let img = compose(&sheet);
        assert_eq!((img.width(), img.height()), (100, 50));
        assert_eq!(img.get_pixel(15, 15), &Rgb([255, 0, 0]));
        assert_eq!(img.get_pixel(65, 15), &Rgb([10, 10, 10]));
        assert_eq!(img.get_pixel(5, 5), &Rgb([10, 10, 10]));
        let half = img.get_pixel(95, 45);
        assert!(half[0] > 100 && half[0] < 120, "{half:?}");
        let big = Sheet { width: 8000, height: 2000, bg: [0, 0, 0], ink: [0, 0, 0], scale: 1.0, lines: vec![], items: vec![] };
        let img = compose(&big);
        assert_eq!((img.width(), img.height()), (4000, 1000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lines_dashed_under_images() {
        let dir = std::env::temp_dir().join(format!("atlas-lines-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let red = dir.join("red.png");
        RgbImage::from_pixel(10, 10, Rgb([255, 0, 0])).save(&red).unwrap();
        let sheet = Sheet {
            width: 100,
            height: 20,
            bg: [0, 0, 0],
            ink: [200, 200, 200],
            scale: 1.0,
            lines: vec![[0.0, 10.0, 100.0, 10.0]],
            items: vec![Piece { path: Some(red), thumb: None, x: 80.0, y: 5.0, w: 10.0, h: 10.0, alpha: 1.0 }],
        };
        let img = compose(&sheet);
        // Strich, Lücke, Strich: 0–4 an, 4–8 aus
        assert_eq!(img.get_pixel(2, 10), &Rgb([90, 90, 90]));
        assert_eq!(img.get_pixel(6, 10), &Rgb([0, 0, 0]));
        assert_eq!(img.get_pixel(10, 10), &Rgb([90, 90, 90]));
        // Abseits der Linie bleibt der Grund, unter dem Bild deckt das Bild
        assert_eq!(img.get_pixel(2, 3), &Rgb([0, 0, 0]));
        assert_eq!(img.get_pixel(82, 10), &Rgb([255, 0, 0]));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
