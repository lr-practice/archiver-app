//! Atlas als Bild (App 0.42.0): die ganze Anordnung als PNG. Die Lage rechnet
//! cloud.js aus, hier wird nur gesetzt: Grund, dann jedes Bild randlos auf
//! sein Feld zugeschnitten, in der Reihenfolge der Ebenen.

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
        let big = Sheet { width: 8000, height: 2000, bg: [0, 0, 0], items: vec![] };
        let img = compose(&big);
        assert_eq!((img.width(), img.height()), (4000, 1000));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
