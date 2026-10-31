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
const NOTE_LINES: usize = 2;
const NOTE_LEAD: f64 = 9.5;

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
    /// Notiz zum Objekt, steht unter der Quelle (Layout.notes)
    #[serde(default)]
    pub note: Option<String>,
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
    /// Plakat: Bilder randlos im Raster, angeschnitten, Beschriftung im Bild
    #[serde(default)]
    pub poster: bool,
    /// Notizen unter der Bildunterschrift (nur Kontaktbogen)
    #[serde(default)]
    pub notes: bool,
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
        Layout { cols, rows, portrait: false, captions: true, poster: false, notes: false }
    }
}

struct Picture {
    w: u32,
    h: u32,
    jpeg: Vec<u8>,
    /// Helligkeit 0–1 in einem 32 × 32-Raster (Zeile 0 oben), für lesbare Beschriftung
    luma: Vec<f64>,
}

const LUMA_GRID: usize = 32;

impl Picture {
    /// Mittlere Helligkeit im Ausschnitt (Anteile 0–1, y von oben).
    fn luma_in(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
        let n = LUMA_GRID as f64;
        let (cx0, cx1) = ((x0 * n).floor().max(0.0) as usize, ((x1 * n).ceil() as usize).clamp(1, LUMA_GRID));
        let (cy0, cy1) = ((y0 * n).floor().max(0.0) as usize, ((y1 * n).ceil() as usize).clamp(1, LUMA_GRID));
        let (mut sum, mut count) = (0.0, 0.0);
        for y in cy0..cy1.max(cy0 + 1).min(LUMA_GRID) {
            for x in cx0..cx1.max(cx0 + 1).min(LUMA_GRID) {
                sum += self.luma[y * LUMA_GRID + x];
                count += 1.0;
            }
        }
        if count > 0.0 { sum / count } else { 1.0 }
    }
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
    let small = image::imageops::resize(&rgb, LUMA_GRID as u32, LUMA_GRID as u32, image::imageops::FilterType::Triangle);
    let luma = small
        .pixels()
        .map(|p| (0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64) / 255.0)
        .collect();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 86).encode_image(&rgb).ok()?;
    Some(Picture { w: rgb.width(), h: rgb.height(), jpeg, luma })
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
    if layout.poster {
        return poster_sheet(title, meta, items, layout);
    }
    let cols = layout.cols.clamp(1, 6);
    let rows = layout.rows.clamp(1, 6);
    let (page_w, page_h) = if layout.portrait { (A4_SHORT, A4_LONG) } else { (A4_LONG, A4_SHORT) };
    let caption = match (layout.captions, layout.notes) {
        (false, _) => 0.0,
        (true, false) => CAPTION,
        (true, true) => CAPTION + NOTE_LINES as f64 * NOTE_LEAD,
    };
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
        text_op(&mut content, "F1", SMALL, MARGIN, MARGIN - 4.0, b"Archery");
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
            if let Some(note) = item.note.as_deref().filter(|n| layout.notes && !n.trim().is_empty()) {
                let mut y = name_y - 10.0 - NOTE_LEAD - 2.0;
                content.extend_from_slice(b"0.3 g\n");
                for line in wrap(note, SMALL, cell_w, NOTE_LINES) {
                    text_op(&mut content, "F1", SMALL, x, y, &line);
                    y -= NOTE_LEAD;
                }
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

    finish(objects, &page_ids)
}

/// Seitenbaum eintragen und Objekte mit xref-Tabelle zu einer Datei fügen.
fn finish(mut objects: Vec<Vec<u8>>, page_ids: &[usize]) -> Vec<u8> {
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

fn image_object(objects: &mut Vec<Vec<u8>>, xobjects: &mut String, pic: &Picture) -> usize {
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
    id
}

/// Courier: jedes Zeichen 600/1000 em breit.
fn mono_width(bytes: &[u8], size: f64) -> f64 {
    bytes.len() as f64 * 0.6 * size
}

fn fit_mono(text: &str, size: f64, width: f64) -> Vec<u8> {
    let mut bytes: Vec<u8> = text.chars().map(win_ansi).collect();
    if mono_width(&bytes, size) <= width {
        return bytes;
    }
    while !bytes.is_empty() && mono_width(&bytes, size) + 0.6 * size > width {
        bytes.pop();
    }
    while bytes.last() == Some(&b' ') {
        bytes.pop();
    }
    bytes.push(0x85);
    bytes
}

/// Plakat wie eine Shop-Seite: Bilder randlos im Raster, auf das Feld
/// angeschnitten, Name und Quelle klein in Schreibmaschinenschrift unten
/// links im Bild (schwarz oder weiß, je nach Helligkeit darunter). Oben ein
/// schmaler Streifen mit Titel und Angaben.
fn poster_sheet(title: &str, meta: &str, items: &[SheetItem], layout: Layout) -> Vec<u8> {
    const HEAD: f64 = 22.0;
    const PAD: f64 = 7.0;
    const CAP: f64 = 5.6;
    let cols = layout.cols.clamp(1, 6);
    let rows = layout.rows.clamp(1, 6);
    let (page_w, page_h) = if layout.portrait { (A4_SHORT, A4_LONG) } else { (A4_LONG, A4_SHORT) };
    let per_page = cols * rows;
    let pages = items.len().div_ceil(per_page).max(1);
    let large = per_page <= 2;

    let mut objects: Vec<Vec<u8>> = Vec::new();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objects.push(Vec::new());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>".to_vec());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec());

    let grid_top = page_h - HEAD;
    let cell_w = page_w / cols as f64;
    let cell_h = grid_top / rows as f64;

    let mut page_ids = Vec::new();
    for p in 0..pages {
        let mut content = Vec::new();
        let mut xobjects = String::new();
        let head_y = page_h - HEAD / 2.0 - CAP * 0.35;
        let title_b = fit_mono(&title.to_uppercase(), CAP, page_w / 2.0 - PAD);
        text_op(&mut content, "F1", CAP, PAD, head_y, &title_b);
        let right = format!("{}  {} / {}", meta, p + 1, pages).to_uppercase();
        let right_b = fit_mono(&right, CAP, page_w / 2.0 - PAD);
        text_op(&mut content, "F1", CAP, page_w - PAD - mono_width(&right_b, CAP), head_y, &right_b);

        for (slot, item) in items.iter().skip(p * per_page).take(per_page).enumerate() {
            let x = (slot % cols) as f64 * cell_w;
            let y = grid_top - ((slot / cols) as f64 + 1.0) * cell_h;
            let pic = if item.quote.is_some() {
                None
            } else {
                let hires = if large { item.file.as_deref().and_then(|f| picture(f, 2400)) } else { None };
                hires.or_else(|| item.thumb.as_deref().and_then(|t| picture(t, 1200))).or_else(|| {
                    if large { None } else { item.file.as_deref().and_then(|f| picture(f, 1200)) }
                })
            };
            // Hell (Text schwarz) oder dunkel (Text weiß) unter der Beschriftung
            let mut dark = false;
            if let Some(pic) = &pic {
                // Anschneiden: Feld ganz füllen, mittig
                let scale = (cell_w / pic.w as f64).max(cell_h / pic.h as f64);
                let (w, h) = (pic.w as f64 * scale, pic.h as f64 * scale);
                let (ix, iy) = (x + (cell_w - w) / 2.0, y + (cell_h - h) / 2.0);
                let id = image_object(&mut objects, &mut xobjects, pic);
                content.extend_from_slice(
                    format!("q {x:.2} {y:.2} {cell_w:.2} {cell_h:.2} re W n {w:.2} 0 0 {h:.2} {ix:.2} {iy:.2} cm /Im{id} Do Q\n")
                        .as_bytes(),
                );
                // Genau die Fläche unter der Beschriftung, in Bildanteilen (y von oben)
                let text_w = item.name.chars().count().max(item.source.as_deref().map_or(0, |s| s.chars().count())) as f64 * 0.6 * CAP;
                let fx0 = (x + PAD - ix) / w;
                let fx1 = (x + PAD + text_w.min(cell_w - 2.0 * PAD) - ix) / w;
                let fy0 = 1.0 - (y + PAD + CAP * 2.6 - iy) / h;
                let fy1 = 1.0 - (y + PAD - 2.0 - iy) / h;
                dark = pic.luma_in(fx0.clamp(0.0, 1.0), fy0.clamp(0.0, 1.0), fx1.clamp(0.0, 1.0), fy1.clamp(0.0, 1.0)) < 0.5;
            } else if let Some(quote) = &item.quote {
                let size = if large { 16.0 } else { 9.0 };
                let lead = size * 1.3;
                let lines = ((cell_h - 2.0 * PAD - 24.0) / lead).floor().max(1.0) as usize;
                let mut ty = y + cell_h - PAD - size;
                for line in wrap(&format!("„{}“", quote.trim()), size, cell_w - 2.0 * PAD, lines) {
                    text_op(&mut content, "F2", size, x + PAD, ty, &line);
                    ty -= lead;
                }
            } else {
                content.extend_from_slice(format!("0.93 g {x:.2} {y:.2} {cell_w:.2} {cell_h:.2} re f 0 g\n").as_bytes());
                let label = fit_mono(&item.label, CAP, cell_w);
                content.extend_from_slice(format!("{GREY}\n").as_bytes());
                text_op(&mut content, "F1", CAP, x + (cell_w - mono_width(&label, CAP)) / 2.0, y + cell_h / 2.0, &label);
                content.extend_from_slice(b"0 g\n");
            }
            if !layout.captions {
                continue;
            }
            content.extend_from_slice(if dark { b"1 g\n" } else { b"0 g\n" });
            let name = item.name.rsplit_once('.').filter(|(stem, ext)| !stem.is_empty() && ext.len() <= 5).map_or(item.name.as_str(), |(stem, _)| stem);
            let source = item.source.as_deref().filter(|s| !s.is_empty());
            let base = y + PAD;
            let name_y = if source.is_some() { base + CAP * 1.35 } else { base };
            text_op(&mut content, "F1", CAP, x + PAD, name_y, &fit_mono(&name.to_uppercase(), CAP, cell_w - 2.0 * PAD));
            if let Some(source) = source {
                text_op(&mut content, "F1", CAP, x + PAD, base, &fit_mono(&source.to_uppercase(), CAP, cell_w - 2.0 * PAD));
            }
            content.extend_from_slice(b"0 g\n");
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
    finish(objects, &page_ids)
}

/// Moodboard: ein Objekt frei auf der Fläche, Lage und Größe als Anteile
/// (0–1) der Fläche zwischen Kopf und Fuß. Spätere Objekte liegen oben.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    #[serde(flatten)]
    pub item: SheetItem,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    #[serde(default)]
    pub portrait: bool,
    /// Notizen klein unter dem Bild
    #[serde(default)]
    pub notes: bool,
    /// Hintergrund: weiß oder schwarz
    #[serde(default)]
    pub dark: bool,
    pub items: Vec<BoardItem>,
}

/// Fläche des Moodboards auf der Seite: (x, y unten, Breite, Höhe).
pub fn board_area(portrait: bool) -> (f64, f64, f64, f64) {
    let (page_w, page_h) = if portrait { (A4_SHORT, A4_LONG) } else { (A4_LONG, A4_SHORT) };
    let top = page_h - MARGIN - 30.0;
    let bottom = MARGIN + 18.0;
    (MARGIN, bottom, page_w - 2.0 * MARGIN, top - bottom)
}

/// Eine Seite, Bilder frei gesetzt wie im Moodboard-Layouter.
pub fn moodboard(title: &str, meta: &str, board: &Board) -> Vec<u8> {
    let (page_w, page_h) = if board.portrait { (A4_SHORT, A4_LONG) } else { (A4_LONG, A4_SHORT) };
    let (ax, ay, aw, ah) = board_area(board.portrait);
    let (ink, dim) = if board.dark { ("1 g", "0.6 g") } else { ("0 g", GREY) };

    let mut objects: Vec<Vec<u8>> = Vec::new();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objects.push(Vec::new());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_vec());

    let mut content = Vec::new();
    let mut xobjects = String::new();
    if board.dark {
        content.extend_from_slice(format!("0.07 g 0 0 {page_w} {page_h} re f\n").as_bytes());
    }
    content.extend_from_slice(format!("{ink}\n").as_bytes());
    text_op(&mut content, "F2", 9.0, MARGIN, page_h - MARGIN - 9.0, &fit(title, 9.0, page_w / 2.0));
    let meta_bytes = fit(meta, 9.0, page_w / 2.0 - MARGIN);
    content.extend_from_slice(format!("{dim}\n").as_bytes());
    text_op(&mut content, "F1", 9.0, page_w - MARGIN - text_width(&meta_bytes, 9.0), page_h - MARGIN - 9.0, &meta_bytes);
    text_op(&mut content, "F1", SMALL, MARGIN, MARGIN - 4.0, b"Archery");

    for b in &board.items {
        let w = (b.w.clamp(0.01, 1.0)) * aw;
        let h = (b.h.clamp(0.01, 1.0)) * ah;
        let x = ax + b.x.clamp(-0.5, 1.0) * aw;
        let top = ay + ah - b.y.clamp(-0.5, 1.0) * ah;
        let bottom = top - h;
        let item = &b.item;
        // Große Felder bekommen das Original
        let max = if w.max(h) > 300.0 { 2400 } else { 1200 };
        let pic = if item.quote.is_some() {
            None
        } else {
            item.file
                .as_deref()
                .filter(|_| max > 1200)
                .and_then(|f| picture(f, max))
                .or_else(|| item.thumb.as_deref().and_then(|t| picture(t, 1200)))
                .or_else(|| item.file.as_deref().and_then(|f| picture(f, 1200)))
        };
        if let Some(pic) = pic {
            let id = image_object(&mut objects, &mut xobjects, &pic);
            // Bild füllt das Feld; Lage und Seitenverhältnis kommen aus dem Layouter
            content.extend_from_slice(format!("q {w:.2} 0 0 {h:.2} {x:.2} {bottom:.2} cm /Im{id} Do Q\n").as_bytes());
        } else if let Some(quote) = &item.quote {
            let size = (h / 10.0).clamp(7.0, 18.0);
            let lead = size * 1.3;
            let lines = (h / lead).floor().max(1.0) as usize;
            let mut y = top - size;
            content.extend_from_slice(format!("{ink}\n").as_bytes());
            for line in wrap(&format!("„{}“", quote.trim()), size, w, lines) {
                text_op(&mut content, "F1", size, x, y, &line);
                y -= lead;
            }
        } else {
            content.extend_from_slice(format!("0.93 g {x:.2} {bottom:.2} {w:.2} {h:.2} re f\n").as_bytes());
        }
        if let Some(note) = item.note.as_deref().filter(|n| board.notes && !n.trim().is_empty()) {
            content.extend_from_slice(format!("{dim}\n").as_bytes());
            let mut y = bottom - SMALL - 3.0;
            for line in wrap(note, SMALL, w.max(60.0), 3) {
                text_op(&mut content, "F1", SMALL, x, y, &line);
                y -= NOTE_LEAD;
            }
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
    let page = objects.len();
    finish(objects, &[page])
}

/// Plakat, Anordnung Index und Paar: ein Feld mit Lage in Punkten (y von oben),
/// gesetzt von app.js flowPages.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowItem {
    #[serde(flatten)]
    pub item: SheetItem,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    #[serde(default)]
    pub portrait: bool,
    #[serde(default = "yes")]
    pub captions: bool,
    /// Kopfzeile: Titel, Anzahl, Datum (die Seitenzahl kommt dazu)
    pub head: Vec<String>,
    /// Beschreibung, nur auf der ersten Seite
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub year: String,
    pub pages: Vec<Vec<FlowItem>>,
}

/// Index und Paar wie die Vorlagen: oben vier Spalten (Titel, Anzahl, Datum,
/// Seite), darunter Nummer, Titel, Beschreibung und Jahr. Bilder ungeschnitten
/// an der Stelle, die der PDF-Ersteller zeigt; Name und Quelle darunter.
pub fn flow_sheet(flow: &Flow) -> Vec<u8> {
    const M: f64 = 14.0;
    const SIZE: f64 = 6.4;
    const LEAD: f64 = 8.3;
    let (page_w, page_h) = if flow.portrait { (A4_SHORT, A4_LONG) } else { (A4_LONG, A4_SHORT) };
    let pages = flow.pages.len().max(1);
    let col = (page_w - 2.0 * M) / 4.0;

    let mut objects: Vec<Vec<u8>> = Vec::new();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objects.push(Vec::new());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec());

    let mut page_ids = Vec::new();
    for p in 0..pages {
        let mut content = b"0 g\n".to_vec();
        let mut xobjects = String::new();
        // Kopfzeile
        let head_y = page_h - 10.0 - SIZE;
        let page_no = format!("{} / {}", p + 1, pages);
        for (i, text) in flow.head.iter().take(3).enumerate() {
            text_op(&mut content, "F1", SIZE, M + i as f64 * col, head_y, &fit(text, SIZE, col - 8.0));
        }
        let page_b = fit(&page_no, SIZE, col);
        text_op(&mut content, "F1", SIZE, page_w - M - text_width(&page_b, SIZE), head_y, &page_b);
        // Zeile darunter: [01] Titel Beschreibung … Jahr (Spalten wie app.css .pdf-finfo)
        let info_y = page_h - 34.0 - SIZE;
        let fr = (page_w - 2.0 * M - 28.0 - 40.0) / 4.0;
        text_op(&mut content, "F1", SIZE, M, info_y, &fit(&format!("[{:02}]", p + 1), SIZE, 28.0));
        if let Some(title) = flow.head.first() {
            text_op(&mut content, "F1", SIZE, M + 28.0, info_y, &fit(title, SIZE, fr - 8.0));
        }
        if p == 0 && !flow.desc.trim().is_empty() {
            let mut y = info_y;
            for line in wrap(flow.desc.trim(), SIZE, (2.0 * fr).min(230.0), 2) {
                text_op(&mut content, "F1", SIZE, M + 28.0 + fr, y, &line);
                y -= LEAD;
            }
        }
        let year_b = fit(&flow.year, SIZE, 40.0);
        text_op(&mut content, "F1", SIZE, page_w - M - text_width(&year_b, SIZE), info_y, &year_b);

        for f in flow.pages.get(p).map(|v| v.as_slice()).unwrap_or(&[]) {
            let (x, w, h) = (f.x, f.w.max(1.0), f.h.max(1.0));
            let bottom = page_h - f.y - h;
            let item = &f.item;
            let max = if w.max(h) > 300.0 { 2400 } else { 1200 };
            let pic = if item.quote.is_some() {
                None
            } else {
                item.file
                    .as_deref()
                    .filter(|_| max > 1200)
                    .and_then(|file| picture(file, max))
                    .or_else(|| item.thumb.as_deref().and_then(|t| picture(t, 1200)))
                    .or_else(|| item.file.as_deref().and_then(|file| picture(file, 1200)))
            };
            if let Some(pic) = pic {
                let id = image_object(&mut objects, &mut xobjects, &pic);
                content.extend_from_slice(format!("q {w:.2} 0 0 {h:.2} {x:.2} {bottom:.2} cm /Im{id} Do Q\n").as_bytes());
            } else if let Some(quote) = &item.quote {
                let size = (h / 10.0).clamp(7.0, 16.0);
                let lead = size * 1.3;
                let mut y = page_h - f.y - size;
                for line in wrap(&format!("„{}“", quote.trim()), size, w, (h / lead).floor().max(1.0) as usize) {
                    text_op(&mut content, "F1", size, x, y, &line);
                    y -= lead;
                }
            } else {
                content.extend_from_slice(format!("0.93 g {x:.2} {bottom:.2} {w:.2} {h:.2} re f 0 g\n").as_bytes());
            }
            if !flow.captions {
                continue;
            }
            let cap_y = bottom - 3.0 - SIZE;
            let name = item.name.rsplit_once('.').filter(|(stem, ext)| !stem.is_empty() && ext.len() <= 5).map_or(item.name.as_str(), |(stem, _)| stem);
            let source = item.source.as_deref().filter(|s| !s.is_empty()).map(|s| fit(s, SIZE, w * 0.45)).unwrap_or_default();
            let source_w = text_width(&source, SIZE);
            text_op(&mut content, "F1", SIZE, x, cap_y, &fit(name, SIZE, (w - source_w - 6.0).max(12.0)));
            if !source.is_empty() {
                content.extend_from_slice(format!("{GREY}\n").as_bytes());
                text_op(&mut content, "F1", SIZE, x + w - source_w, cap_y, &source);
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
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_w} {page_h}] /Resources << /Font << /F1 3 0 R >> /XObject << {xobjects}>> >> /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
        page_ids.push(objects.len());
    }
    finish(objects, &page_ids)
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
    fn poster_bleeds_and_picks_caption_colour() {
        let dir = tempfile::tempdir().unwrap();
        let dark = dir.path().join("dark.png");
        let light = dir.path().join("light.png");
        image::RgbImage::from_pixel(300, 600, image::Rgb([10, 10, 10])).save(&dark).unwrap();
        image::RgbImage::from_pixel(600, 300, image::Rgb([250, 250, 250])).save(&light).unwrap();
        let items = vec![
            SheetItem { thumb: Some(dark), name: "vase with ears.jpg".into(), source: Some("380,00 €".into()), ..Default::default() },
            SheetItem { thumb: Some(light), name: "stool.png".into(), ..Default::default() },
            SheetItem { quote: Some("Weniger, aber besser.".into()), name: "Zitat".into(), ..Default::default() },
        ];
        let layout = Layout { cols: 4, rows: 4, portrait: true, captions: true, poster: true, notes: false };
        let pdf = contact_sheet("Shop", "3 Objekte", &items, layout);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/BaseFont /Courier"));
        assert!(text.contains("(VASE WITH EARS)"));
        assert!(text.contains("(STOOL)"));
        // Feld 1 dunkel: weiße Schrift, Feld 2 hell: schwarze
        let first = text.find("(VASE WITH EARS)").unwrap();
        assert_eq!(&text[..first].rfind("1 g\n").map(|i| &text[i..i + 3]), &Some("1 g"));
        assert!(text[first..text.find("(STOOL)").unwrap()].contains("0 g\n"));
        // randlos: erstes Feld beginnt bei x = 0, Ausschnitt per Clip
        assert!(text.contains("q 0.00 "));
        assert!(text.contains("re W n"));
        assert_eq!(text.matches("/Subtype /Image").count(), 2);
        assert!(pdf.ends_with(b"%%EOF\n"));
        std::fs::write("/tmp/poster-test.pdf", &pdf).ok();
    }

    #[test]
    fn portrait_grid_without_captions() {
        let items: Vec<SheetItem> = (0..13).map(|i| SheetItem { name: format!("x{i}"), label: "SVG".into(), ..Default::default() }).collect();
        let layout = Layout { cols: 3, rows: 4, portrait: true, captions: false, poster: false, notes: false };
        let pdf = contact_sheet("Hoch", "", &items, layout);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/MediaBox [0 0 595 842]"));
        assert!(text.contains("/Count 2"));
        assert!(!text.contains("(x0)"));
    }

    #[test]
    fn moodboard_places_items_and_notes() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.png");
        image::RgbImage::from_pixel(40, 20, image::Rgb([200, 0, 0])).save(&file).unwrap();
        let item = |note: Option<&str>| SheetItem { file: Some(file.clone()), name: "a.png".into(), note: note.map(String::from), ..Default::default() };
        let board = Board {
            portrait: false,
            notes: true,
            dark: true,
            items: vec![
                BoardItem { item: item(Some("Warum: Kontrast")), x: 0.1, y: 0.1, w: 0.5, h: 0.4 },
                BoardItem { item: SheetItem { quote: Some("Weniger ist mehr".into()), ..Default::default() }, x: 0.6, y: 0.6, w: 0.3, h: 0.2 },
            ],
        };
        let pdf = moodboard("Board", "2 Objekte", &board);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.starts_with("%PDF"));
        assert_eq!(text.matches("/Type /Page ").count(), 1);
        assert!(text.contains("(Warum: Kontrast)"));
        assert!(text.contains("Weniger ist mehr"));
        assert!(text.contains("0.07 g 0 0 842 595 re f"));
        // Bild an der gesetzten Stelle: x = 40 + 0.1 * 762
        assert!(text.contains(" 116.20 "), "x-Position");
    }

    #[test]
    fn flow_has_pages_and_header() {
        let item = |x: f64| FlowItem { item: SheetItem { name: "a.png".into(), label: "PNG".into(), ..Default::default() }, x, y: 58.0, w: 200.0, h: 150.0 };
        let flow = Flow {
            portrait: false,
            captions: true,
            head: vec!["Herbst".into(), "3 Objekte".into(), "15. Oktober 2026".into()],
            desc: "Licht und Verlauf".into(),
            year: "2026".into(),
            pages: vec![vec![item(14.0), item(220.0)], vec![item(14.0)]],
        };
        let pdf = flow_sheet(&flow);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 2"));
        assert!(text.contains("(1 / 2)") && text.contains("(2 / 2)"));
        assert!(text.contains("([01])") && text.contains("(Licht und Verlauf)"));
    }

    #[test]
    fn sheet_with_notes() {
        let item = SheetItem { name: "a".into(), label: "PNG".into(), note: Some("Notiz zum Bild".into()), ..Default::default() };
        let mut layout = Layout::auto(1);
        layout.notes = true;
        let text = String::from_utf8_lossy(&contact_sheet("T", "M", &[item.clone()], layout)).into_owned();
        assert!(text.contains("(Notiz zum Bild)"));
        layout.notes = false;
        let text = String::from_utf8_lossy(&contact_sheet("T", "M", &[item], layout)).into_owned();
        assert!(!text.contains("Notiz zum Bild"));
    }
}
