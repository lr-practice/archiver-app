//! Kontaktbogen als PDF: ausgewählte Objekte im Raster auf A4 quer, mit
//! Dateiname und Quelle darunter. Schreibt das PDF selbst (Helvetica als
//! Standardschrift, Bilder als JPEG), damit keine weitere Bibliothek nötig ist.

use std::fmt::Write as _;
use std::path::PathBuf;

use serde::Deserialize;

const A4_LONG: f64 = 842.0;
const A4_SHORT: f64 = 595.0;
const MARGIN: f64 = 40.0;
const GAP: f64 = 20.0;
const CAPTION: f64 = 28.0;
const SMALL: f64 = 7.5;
const GREY: &str = "0.55 g";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetItem {
    /// Vorschaubild (720 px), reicht für das Raster mit drei Spalten
    pub thumb: Option<PathBuf>,
    /// Originaldatei, für große Raster (ein oder zwei Objekte pro Seite)
    pub file: Option<PathBuf>,
    pub name: String,
    pub source: Option<String>,
    /// Zitat-Karte: Text statt Bild
    pub quote: Option<String>,
    /// Format für den Platzhalter, z. B. "SVG"
    pub label: String,
}

/// Raster je Seite, Ausrichtung und Bildunterschriften, wie im PDF-Ersteller gewählt.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub cols: usize,
    pub rows: usize,
    #[serde(default)]
    pub portrait: bool,
    #[serde(default = "yes")]
    pub captions: bool,
}

fn yes() -> bool {
    true
}

impl Layout {
    /// Ohne Wahl: ein Objekt groß, zwei nebeneinander, sonst 3 × 2.
    pub fn auto(count: usize) -> Self {
        let (cols, rows) = match count {
            1 => (1, 1),
            2 => (2, 1),
            _ => (3, 2),
        };
        Layout { cols, rows, portrait: false, captions: true }
    }
}

struct Picture {
    w: u32,
    h: u32,
    jpeg: Vec<u8>,
}

/// Lädt ein Bild, verkleinert es auf höchstens `max` px und legt Transparenz
/// auf Weiß. Gibt None zurück, wenn die Datei kein lesbares Bild ist.
fn picture(path: &std::path::Path, max: u32) -> Option<Picture> {
    let img = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let img = if img.width() > max || img.height() > max { img.thumbnail(max, max) } else { img };
    let rgba = img.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        rgb.put_pixel(x, y, image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 86).encode_image(&rgb).ok()?;
    Some(Picture { w: rgb.width(), h: rgb.height(), jpeg })
}

/// Zeichen in WinAnsi (Standardkodierung der Helvetica), Unbekanntes als "?".
fn win_ansi(c: char) -> u8 {
    match c as u32 {
        0x20..=0x7e | 0xa0..=0xff => c as u32 as u8,
        _ => match c {
            '€' => 0x80,
            '‚' => 0x82,
            '„' => 0x84,
            '…' => 0x85,
            '‘' => 0x91,
            '’' => 0x92,
            '“' => 0x93,
            '”' => 0x94,
            '•' => 0x95,
            '–' => 0x96,
            '—' => 0x97,
            '\t' | '\n' | '\r' => b' ',
            _ => b'?',
        },
    }
}

/// Breite eines Zeichens in Helvetica (1/1000 em).
fn glyph_width(b: u8) -> f64 {
    const W: [u16; 95] = [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556,
        556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667,
        556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556,
        556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722,
        500, 500, 500, 334, 260, 334, 584,
    ];
    match b {
        0x20..=0x7e => W[(b - 0x20) as usize] as f64,
        0x85 => 1000.0,
        0x96 => 556.0,
        0x97 => 1000.0,
        _ => 556.0,
    }
}

fn text_width(bytes: &[u8], size: f64) -> f64 {
    bytes.iter().map(|&b| glyph_width(b)).sum::<f64>() * size / 1000.0
}

/// Kürzt auf die verfügbare Breite und hängt "…" an.
fn fit(text: &str, size: f64, width: f64) -> Vec<u8> {
    let mut bytes: Vec<u8> = text.chars().map(win_ansi).collect();
    if text_width(&bytes, size) <= width {
        return bytes;
    }
    let ell = glyph_width(0x85) * size / 1000.0;
    while !bytes.is_empty() && text_width(&bytes, size) + ell > width {
        bytes.pop();
    }
    while bytes.last() == Some(&b' ') {
        bytes.pop();
    }
    bytes.push(0x85);
    bytes
}

/// Bricht Text in Zeilen um, höchstens `lines` Zeilen, die letzte mit "…".
fn wrap(text: &str, size: f64, width: f64, lines: usize) -> Vec<Vec<u8>> {
    let mut out: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
        let bytes: Vec<u8> = candidate.chars().map(win_ansi).collect();
        if text_width(&bytes, size) <= width || line.is_empty() {
            line = candidate;
        } else {
            out.push(std::mem::replace(&mut line, word.to_string()));
        }
    }
    if !line.is_empty() {
        out.push(line);
    }
    let cut = out.len() > lines;
    out.truncate(lines);
    let n = out.len();
    out.into_iter()
        .enumerate()
        .map(|(i, l)| if cut && i + 1 == n { fit(&(l + " …"), size, width) } else { fit(&l, size, width) })
        .collect()
}

fn pdf_string(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![b'('];
    for &b in bytes {
        if matches!(b, b'(' | b')' | b'\\') {
            out.push(b'\\');
        }
        out.push(b);
    }
    out.push(b')');
    out
}

fn text_op(content: &mut Vec<u8>, font: &str, size: f64, x: f64, y: f64, bytes: &[u8]) {
    content.extend_from_slice(format!("BT /{font} {size} Tf {x:.2} {y:.2} Td ").as_bytes());
    content.extend_from_slice(&pdf_string(bytes));
    content.extend_from_slice(b" Tj ET\n");
}

/// Baut den Kontaktbogen. `title` steht oben links, `meta` oben rechts.
pub fn contact_sheet(title: &str, meta: &str, items: &[SheetItem], layout: Layout) -> Vec<u8> {
    let cols = layout.cols.clamp(1, 6);
    let rows = layout.rows.clamp(1, 6);
    let (page_w, page_h) = if layout.portrait { (A4_SHORT, A4_LONG) } else { (A4_LONG, A4_SHORT) };
    let caption = if layout.captions { CAPTION } else { 0.0 };
    let per_page = cols * rows;
    let pages = items.len().div_ceil(per_page).max(1);
    // Große Felder bekommen das Original statt des Vorschaubilds
    let large = per_page <= 2;

    let mut objects: Vec<Vec<u8>> = Vec::new(); // Index i = Objekt i + 1
    // 1 Katalog, 2 Seitenbaum, 3 Helvetica, 4 Helvetica-Bold; Rest folgt
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objects.push(Vec::new());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_vec());

    let top = page_h - MARGIN - 30.0;
    let bottom = MARGIN + 18.0;
    let cell_w = (page_w - 2.0 * MARGIN - (cols as f64 - 1.0) * GAP) / cols as f64;
    let cell_h = (top - bottom - (rows as f64 - 1.0) * GAP) / rows as f64;
    let box_h = cell_h - caption;

    let mut page_ids = Vec::new();
    for p in 0..pages {
        let mut content = Vec::new();
        let mut xobjects = String::new();
        // Kopf: Titel links, Angaben rechts; Fuß: Archiver und Seitenzahl
        text_op(&mut content, "F2", 9.0, MARGIN, page_h - MARGIN - 9.0, &fit(title, 9.0, page_w / 2.0));
        let meta_bytes = fit(meta, 9.0, page_w / 2.0 - MARGIN);
        content.extend_from_slice(format!("{GREY}\n").as_bytes());
        text_op(&mut content, "F1", 9.0, page_w - MARGIN - text_width(&meta_bytes, 9.0), page_h - MARGIN - 9.0, &meta_bytes);
        text_op(&mut content, "F1", SMALL, MARGIN, MARGIN - 4.0, b"Archiver");
        let num: Vec<u8> = format!("{} / {}", p + 1, pages).into_bytes();
        text_op(&mut content, "F1", SMALL, page_w - MARGIN - text_width(&num, SMALL), MARGIN - 4.0, &num);
        content.extend_from_slice(b"0 g\n");

        for (slot, item) in items.iter().skip(p * per_page).take(per_page).enumerate() {
            let col = slot % cols;
            let row = slot / cols;
            let x = MARGIN + col as f64 * (cell_w + GAP);
            let cell_top = top - row as f64 * (cell_h + GAP);
            let box_bottom = cell_top - box_h;

            let pic = if item.quote.is_some() {
                None
            } else {
                let hires = if large { item.file.as_deref().and_then(|f| picture(f, 2400)) } else { None };
                hires.or_else(|| item.thumb.as_deref().and_then(|t| picture(t, 1200))).or_else(|| {
                    if large { None } else { item.file.as_deref().and_then(|f| picture(f, 1200)) }
                })
            };

            if let Some(pic) = pic {
                // Einpassen, unten an der Bildunterschrift ausgerichtet
                let scale = (cell_w / pic.w as f64).min(box_h / pic.h as f64);
                let (w, h) = (pic.w as f64 * scale, pic.h as f64 * scale);
                let id = objects.len() + 1;
                let mut obj = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
                    pic.w,
                    pic.h,
                    pic.jpeg.len()
                )
                .into_bytes();
                obj.extend_from_slice(&pic.jpeg);
                obj.extend_from_slice(b"\nendstream");
                objects.push(obj);
                let _ = write!(xobjects, "/Im{id} {id} 0 R ");
                content.extend_from_slice(format!("q {w:.2} 0 0 {h:.2} {x:.2} {box_bottom:.2} cm /Im{id} Do Q\n").as_bytes());
            } else if let Some(quote) = &item.quote {
                // Zitat: Text oben im Feld, Anführungszeichen hängend
                let size = if large { 16.0 } else { 11.0 };
                let lead = size * 1.3;
                let lines = ((box_h - 8.0) / lead).floor().max(1.0) as usize;
                let mut y = cell_top - size;
                for line in wrap(&format!("„{}“", quote.trim()), size, cell_w, lines) {
                    text_op(&mut content, "F1", size, x, y, &line);
                    y -= lead;
                }
            } else {
                // Kein Bild lesbar: helle Fläche mit dem Format
                content.extend_from_slice(format!("0.93 g {x:.2} {box_bottom:.2} {cell_w:.2} {box_h:.2} re f 0 g\n").as_bytes());
                let label = fit(&item.label, 9.0, cell_w);
                content.extend_from_slice(format!("{GREY}\n").as_bytes());
                text_op(&mut content, "F1", 9.0, x + (cell_w - text_width(&label, 9.0)) / 2.0, box_bottom + box_h / 2.0 - 3.0, &label);
                content.extend_from_slice(b"0 g\n");
            }

            // Bildunterschrift: Name schwarz, Quelle grau
            if !layout.captions {
                continue;
            }
            let name_y = box_bottom - 11.0;
            text_op(&mut content, "F1", SMALL, x, name_y, &fit(&item.name, SMALL, cell_w));
            if let Some(source) = item.source.as_deref().filter(|s| !s.is_empty()) {
                content.extend_from_slice(format!("{GREY}\n").as_bytes());
                text_op(&mut content, "F1", SMALL, x, name_y - 10.0, &fit(source, SMALL, cell_w));
                content.extend_from_slice(b"0 g\n");
            }
        }

        let mut stream = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
        stream.extend_from_slice(&content);
        stream.extend_from_slice(b"\nendstream");
        objects.push(stream);
        let content_id = objects.len();
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_w} {page_h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << {xobjects}>> >> /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
        page_ids.push(objects.len());
    }

    let kids: Vec<String> = page_ids.iter().map(|id| format!("{id} 0 R")).collect();
    objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), page_ids.len()).into_bytes();

    let mut out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::new();
    for (i, obj) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(obj);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for o in offsets {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_and_fit() {
        assert_eq!((Layout::auto(1).cols, Layout::auto(1).rows), (1, 1));
        assert_eq!((Layout::auto(2).cols, Layout::auto(2).rows), (2, 1));
        assert_eq!((Layout::auto(7).cols, Layout::auto(7).rows), (3, 2));
        let short = fit("Bild.jpg", 7.5, 200.0);
        assert_eq!(short, b"Bild.jpg");
        let long = fit(&"x".repeat(200), 7.5, 50.0);
        assert_eq!(*long.last().unwrap(), 0x85);
        assert!(text_width(&long, 7.5) <= 50.0);
        assert_eq!(win_ansi('ä'), 0xe4);
        assert_eq!(win_ansi('漢'), b'?');
    }

    #[test]
    fn sheet_has_pages_and_images() {
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("a.png");
        image::RgbaImage::from_pixel(40, 20, image::Rgba([200, 0, 0, 128])).save(&img).unwrap();
        let mut items = vec![
            SheetItem { thumb: Some(img.clone()), name: "a.png".into(), source: Some("example.com".into()), ..Default::default() },
            SheetItem { quote: Some("Form follows function (immer).".into()), name: "Zitat".into(), ..Default::default() },
            SheetItem { file: Some(dir.path().join("fehlt.svg")), name: "fehlt.svg".into(), label: "SVG".into(), ..Default::default() },
        ];
        for i in 0..5 {
            items.push(SheetItem { thumb: Some(img.clone()), name: format!("b{i}.png"), ..Default::default() });
        }
        let pdf = contact_sheet("Kunde (A)", "8 Objekte · 10.10.2026", &items, Layout::auto(items.len()));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.starts_with("%PDF-1.4"));
        assert!(text.ends_with("%%EOF\n"));
        assert!(text.contains("/Count 2"));
        assert_eq!(text.matches("/Subtype /Image").count(), 6);
        assert!(text.contains("(Kunde \\(A\\))"));
        // xref-Offsets zeigen auf die Objekte (in Bytes, nicht im Text gerechnet)
        let find = |needle: &[u8]| pdf.windows(needle.len()).rposition(|w| w == needle).unwrap();
        let tail = String::from_utf8(pdf[find(b"startxref\n") + 10..].to_vec()).unwrap();
        let start: usize = tail.lines().next().unwrap().parse().unwrap();
        assert!(pdf[start..].starts_with(b"xref"));
        let table = String::from_utf8(pdf[start..].to_vec()).unwrap();
        let first: usize = table.lines().nth(3).unwrap()[..10].parse().unwrap();
        assert!(pdf[first..].starts_with(b"1 0 obj"));
        std::fs::write(dir.path().join("out.pdf"), &pdf).unwrap();
    }

    #[test]
    fn one_item_uses_original() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.png");
        image::RgbImage::from_pixel(3000, 1000, image::Rgb([0, 0, 255])).save(&big).unwrap();
        let pdf = contact_sheet("Einzeln", "", &[SheetItem { file: Some(big), name: "big.png".into(), ..Default::default() }], Layout::auto(1));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Width 2400 /Height 800"));
        assert!(text.contains("/Count 1"));
    }

    #[test]
    fn portrait_grid_without_captions() {
        let items: Vec<SheetItem> = (0..13).map(|i| SheetItem { name: format!("x{i}"), label: "SVG".into(), ..Default::default() }).collect();
        let layout = Layout { cols: 3, rows: 4, portrait: true, captions: false };
        let pdf = contact_sheet("Hoch", "", &items, layout);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/MediaBox [0 0 595 842]"));
        assert!(text.contains("/Count 2"));
        assert!(!text.contains("(x0)"));
    }
}
