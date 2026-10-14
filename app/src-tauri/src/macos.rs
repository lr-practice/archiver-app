//! Mac-spezifisches über AppKit: Bildanalyse und Bilder in die Zwischenablage.

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

// ---- Zwischenablage ----

/// Bilddateien als Bilder in die Zwischenablage (TIFF/PNG je nach Ziel-App).
pub fn copy_images(paths: &[String]) -> bool {
    unsafe {
        let images: *mut AnyObject = msg_send![class!(NSMutableArray), array];
        let mut count = 0;
        for path in paths {
            let path = NSString::from_str(path);
            let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
            let image: *mut AnyObject = msg_send![image, initWithContentsOfFile: &*path];
            if image.is_null() {
                continue;
            }
            let _: () = msg_send![images, addObject: image];
            let _: () = msg_send![image, release];
            count += 1;
        }
        if count == 0 {
            return false;
        }
        let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![board, clearContents];
        msg_send![board, writeObjects: images]
    }
}

/// Textkarte: Text und Bild als ein Eintrag. Texteditoren nehmen den Text,
/// Figma, Photoshop & Co. das Bild.
pub fn copy_text_image(path: &str, text: &str) -> bool {
    unsafe {
        let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![board, clearContents];
        let ns_text = NSString::from_str(text);
        let ty_text = NSString::from_str("public.utf8-plain-text");
        let ok: bool = msg_send![board, setString: &*ns_text, forType: &*ty_text];
        let ns_path = NSString::from_str(path);
        let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
        let image: *mut AnyObject = msg_send![image, initWithContentsOfFile: &*ns_path];
        if !image.is_null() {
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            if !tiff.is_null() {
                let ty_tiff = NSString::from_str("public.tiff");
                let _: bool = msg_send![board, setData: tiff, forType: &*ty_tiff];
            }
            let _: () = msg_send![image, release];
        }
        ok
    }
}

/// Startton: spielt eine Audiodatei über NSSound (AppKit, Hauptthread).
/// Lautstärke 0–1. Der Klang bleibt bis zum Ende am Leben (wird nicht freigegeben).
pub fn play_sound(path: &str, volume: f32) -> bool {
    unsafe {
        let ns_path = NSString::from_str(path);
        let sound: *mut AnyObject = msg_send![class!(NSSound), alloc];
        let sound: *mut AnyObject = msg_send![sound, initWithContentsOfFile: &*ns_path, byReference: true];
        if sound.is_null() {
            return false;
        }
        let _: () = msg_send![sound, setVolume: volume.clamp(0.0, 1.0)];
        msg_send![sound, play]
    }
}

// ---- Bildinhalt und Text (Apple Vision, läuft lokal) ----

#[link(name = "Vision", kind = "framework")]
extern "C" {}

unsafe fn rust_string(ns: *mut AnyObject) -> String {
    if ns.is_null() {
        return String::new();
    }
    let ptr: *const std::ffi::c_char = msg_send![ns, UTF8String];
    if ptr.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
}

/// Erkennt, was auf einem Bild ist (englische Begriffe von Vision) und welcher
/// Text darin steht. Leere Ergebnisse, wenn Vision nichts liefert.
pub fn analyze_image(path: &std::path::Path) -> (Vec<String>, String) {
    objc2::rc::autoreleasepool(|_| unsafe {
        let path = NSString::from_str(&path.to_string_lossy());
        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*path];
        if url.is_null() {
            return (Vec::new(), String::new());
        }
        let options: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
        let handler: *mut AnyObject = msg_send![class!(VNImageRequestHandler), alloc];
        let handler: *mut AnyObject = msg_send![handler, initWithURL: url, options: options];

        let classify: *mut AnyObject = msg_send![class!(VNClassifyImageRequest), alloc];
        let classify: *mut AnyObject = msg_send![classify, init];
        let ocr: *mut AnyObject = msg_send![class!(VNRecognizeTextRequest), alloc];
        let ocr: *mut AnyObject = msg_send![ocr, init];
        // VNRequestTextRecognitionLevelAccurate
        let _: () = msg_send![ocr, setRecognitionLevel: 0isize];
        let _: () = msg_send![ocr, setUsesLanguageCorrection: true];
        let langs: *mut AnyObject = msg_send![class!(NSMutableArray), array];
        for l in ["de-DE", "en-US"] {
            let s = NSString::from_str(l);
            let _: () = msg_send![langs, addObject: &*s];
        }
        let _: () = msg_send![ocr, setRecognitionLanguages: langs];

        let requests: *mut AnyObject = msg_send![class!(NSMutableArray), array];
        let _: () = msg_send![requests, addObject: classify];
        let _: () = msg_send![requests, addObject: ocr];
        let ok: bool = msg_send![handler, performRequests: requests, error: std::ptr::null_mut::<*mut AnyObject>()];

        let mut labels = Vec::new();
        let mut text = Vec::new();
        if ok {
            let results: *mut AnyObject = msg_send![classify, results];
            if !results.is_null() {
                let n: usize = msg_send![results, count];
                for i in 0..n {
                    let obs: *mut AnyObject = msg_send![results, objectAtIndex: i];
                    let confidence: f32 = msg_send![obs, confidence];
                    if confidence >= 0.3 {
                        let id: *mut AnyObject = msg_send![obs, identifier];
                        labels.push((rust_string(id), confidence));
                    }
                }
            }
            let results: *mut AnyObject = msg_send![ocr, results];
            if !results.is_null() {
                let n: usize = msg_send![results, count];
                for i in 0..n {
                    let obs: *mut AnyObject = msg_send![results, objectAtIndex: i];
                    let top: *mut AnyObject = msg_send![obs, topCandidates: 1usize];
                    let count: usize = if top.is_null() { 0 } else { msg_send![top, count] };
                    if count > 0 {
                        let cand: *mut AnyObject = msg_send![top, objectAtIndex: 0usize];
                        let s: *mut AnyObject = msg_send![cand, string];
                        text.push(rust_string(s));
                    }
                }
            }
        }
        let _: () = msg_send![handler, release];
        let _: () = msg_send![classify, release];
        let _: () = msg_send![ocr, release];

        labels.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        // Mit Sicherheit („poster:0.92“), damit die Suche unsichere Motive auslassen kann (0.31.1)
        let labels = labels.into_iter().take(16).map(|(l, c)| format!("{}:{c:.2}", l.replace('_', " "))).collect();
        (labels, text.join(" "))
    })
}

// ---- PDF und Video: Seitenzahl, Dauer, Maße ----

#[link(name = "PDFKit", kind = "framework")]
extern "C" {}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

unsafe impl objc2::Encode for CMTime {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "?",
        &[objc2::Encoding::LongLong, objc2::Encoding::Int, objc2::Encoding::UInt, objc2::Encoding::LongLong],
    );
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGAffineTransform {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    tx: f64,
    ty: f64,
}

unsafe impl objc2::Encode for CGAffineTransform {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGAffineTransform", &[objc2::Encoding::Double, objc2::Encoding::Double, objc2::Encoding::Double, objc2::Encoding::Double, objc2::Encoding::Double, objc2::Encoding::Double]);
}


/// Seitenzahl und Seitengröße (Punkte) eines PDFs bzw. Dauer und Bildgröße
/// eines Videos. Fehlt etwas, bleibt das Feld leer.
pub fn media_info(path: &std::path::Path) -> crate::library::MediaInfo {
    let mut info = crate::library::MediaInfo::default();
    objc2::rc::autoreleasepool(|_| unsafe {
        let p = NSString::from_str(&path.to_string_lossy());
        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*p];
        if url.is_null() {
            return;
        }
        if crate::library::is_pdf(path) {
            let doc: *mut AnyObject = msg_send![class!(PDFDocument), alloc];
            let doc: *mut AnyObject = msg_send![doc, initWithURL: url];
            if doc.is_null() {
                return;
            }
            let pages: usize = msg_send![doc, pageCount];
            info.pages = Some(pages as i64);
            if pages > 0 {
                let page: *mut AnyObject = msg_send![doc, pageAtIndex: 0usize];
                if !page.is_null() {
                    // kPDFDisplayBoxCropBox = 1; Drehung der Seite beachten
                    let rect: objc2_foundation::NSRect = msg_send![page, boundsForBox: 1isize];
                    let rotation: isize = msg_send![page, rotation];
                    let (w, h) = (rect.size.width.round() as i64, rect.size.height.round() as i64);
                    let (w, h) = if rotation % 180 != 0 { (h, w) } else { (w, h) };
                    if w > 0 && h > 0 {
                        info.width = Some(w);
                        info.height = Some(h);
                    }
                }
            }
            let _: () = msg_send![doc, release];
        } else if crate::library::is_audio(path) {
            audio_info(url, &mut info);
        } else if crate::library::is_video(path) {
            let asset: *mut AnyObject = msg_send![class!(AVURLAsset), URLAssetWithURL: url, options: std::ptr::null_mut::<AnyObject>()];
            if asset.is_null() {
                return;
            }
            let t: CMTime = msg_send![asset, duration];
            // kCMTimeFlags_Valid = 1
            if t.flags & 1 == 1 && t.timescale > 0 {
                info.duration = Some(t.value as f64 / t.timescale as f64);
            }
            let kind = NSString::from_str("vide"); // AVMediaTypeVideo
            let tracks: *mut AnyObject = msg_send![asset, tracksWithMediaType: &*kind];
            let n: usize = if tracks.is_null() { 0 } else { msg_send![tracks, count] };
            if n > 0 {
                let track: *mut AnyObject = msg_send![tracks, objectAtIndex: 0usize];
                let size: objc2_foundation::NSSize = msg_send![track, naturalSize];
                let tf: CGAffineTransform = msg_send![track, preferredTransform];
                let (w, h) = (size.width.abs().round() as i64, size.height.abs().round() as i64);
                // um 90° gedreht (Hochkant-Video vom Telefon)
                let (w, h) = if tf.b.abs() > 0.5 && tf.a.abs() < 0.5 { (h, w) } else { (w, h) };
                if w > 0 && h > 0 {
                    info.width = Some(w);
                    info.height = Some(h);
                }
            }
        }
    });
    info
}

/// Dauer, Titel/Künstler/Album und Format (Abtastrate, Bittiefe, Kanäle) einer Audiodatei.
unsafe fn audio_info(url: *mut AnyObject, info: &mut crate::library::MediaInfo) {
    let asset: *mut AnyObject = msg_send![class!(AVURLAsset), URLAssetWithURL: url, options: std::ptr::null_mut::<AnyObject>()];
    if !asset.is_null() {
        let t: CMTime = msg_send![asset, duration];
        if t.flags & 1 == 1 && t.timescale > 0 {
            info.duration = Some(t.value as f64 / t.timescale as f64);
        }
        let meta: *mut AnyObject = msg_send![asset, commonMetadata];
        let n: usize = if meta.is_null() { 0 } else { msg_send![meta, count] };
        for i in 0..n {
            let item: *mut AnyObject = msg_send![meta, objectAtIndex: i];
            let key = rust_string(msg_send![item, commonKey]);
            let slot = match key.as_str() {
                "title" => &mut info.title,
                "artist" => &mut info.artist,
                "albumName" => &mut info.album,
                _ => continue,
            };
            let value = rust_string(msg_send![item, stringValue]).trim().to_string();
            if slot.is_none() && !value.is_empty() {
                *slot = Some(value);
            }
        }
    }
    // Format über AVAudioFile; AudioStreamBasicDescription: mSampleRate (f64) @0,
    // mFormatID @8, mChannelsPerFrame @28, mBitsPerChannel @32 (u32)
    let file: *mut AnyObject = msg_send![class!(AVAudioFile), alloc];
    let file: *mut AnyObject = msg_send![file, initForReading: url, error: std::ptr::null_mut::<*mut AnyObject>()];
    if file.is_null() {
        return;
    }
    let format: *mut AnyObject = msg_send![file, fileFormat];
    if !format.is_null() {
        let asbd: *const u8 = msg_send![format, streamDescription];
        if !asbd.is_null() {
            let rate = std::ptr::read_unaligned(asbd as *const f64);
            let channels = std::ptr::read_unaligned(asbd.add(28) as *const u32);
            let bits = std::ptr::read_unaligned(asbd.add(32) as *const u32);
            if rate > 0.0 {
                info.sample_rate = Some(rate.round() as i64);
            }
            if channels > 0 {
                info.channels = Some(channels as i64);
            }
            // komprimierte Formate (mp3, aac) haben keine feste Bittiefe
            if bits > 0 {
                info.bit_depth = Some(bits as i64);
            }
        }
    }
    let _: () = msg_send![file, release];
}

/// Eingebettetes Cover (JPEG/PNG-Daten) einer Audiodatei, falls vorhanden.
pub fn audio_artwork(path: &std::path::Path) -> Option<Vec<u8>> {
    objc2::rc::autoreleasepool(|_| unsafe {
        let p = NSString::from_str(&path.to_string_lossy());
        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*p];
        if url.is_null() {
            return None;
        }
        let asset: *mut AnyObject = msg_send![class!(AVURLAsset), URLAssetWithURL: url, options: std::ptr::null_mut::<AnyObject>()];
        if asset.is_null() {
            return None;
        }
        let meta: *mut AnyObject = msg_send![asset, commonMetadata];
        let n: usize = if meta.is_null() { 0 } else { msg_send![meta, count] };
        for i in 0..n {
            let item: *mut AnyObject = msg_send![meta, objectAtIndex: i];
            if rust_string(msg_send![item, commonKey]) != "artwork" {
                continue;
            }
            let data: *mut AnyObject = msg_send![item, dataValue];
            if data.is_null() {
                continue;
            }
            let len: usize = msg_send![data, length];
            let bytes: *const u8 = msg_send![data, bytes];
            if len > 0 && !bytes.is_null() {
                return Some(std::slice::from_raw_parts(bytes, len).to_vec());
            }
        }
        None
    })
}

// ---- Schwebende Fenster am ganzen Mac (system.rs) ----
// Palette und Zonenleiste werden zu NSPanel ohne Aktivierung: Sie erscheinen
// über jedem Programm, auch im Vollbild, ohne dass Archiver nach vorne kommt.

use objc2::runtime::{AnyClass, Bool, ClassBuilder, Sel};
use objc2::sel;
use objc2_foundation::{NSPoint, NSRect, NSSize};

extern "C-unwind" fn panel_yes(_this: &AnyObject, _cmd: Sel) -> Bool {
    Bool::YES
}

extern "C-unwind" fn panel_no(_this: &AnyObject, _cmd: Sel) -> Bool {
    Bool::NO
}

/// NSPanel-Unterklasse, die ohne Titelleiste Tastatureingaben annimmt.
fn panel_class() -> &'static AnyClass {
    static CLASS: std::sync::OnceLock<&'static AnyClass> = std::sync::OnceLock::new();
    CLASS.get_or_init(|| {
        if let Some(cls) = AnyClass::get(c"ArchiverPanel") {
            return cls;
        }
        let mut builder = ClassBuilder::new(c"ArchiverPanel", class!(NSPanel)).expect("ArchiverPanel");
        unsafe {
            builder.add_method(sel!(canBecomeKeyWindow), panel_yes as extern "C-unwind" fn(_, _) -> _);
            builder.add_method(sel!(canBecomeMainWindow), panel_no as extern "C-unwind" fn(_, _) -> _);
        }
        builder.register()
    })
}

/// Macht aus einem Tauri-Fenster ein schwebendes Panel auf `level`
/// (3 = schwebend, 25 = Statusebene).
pub unsafe fn make_panel(window: *mut AnyObject, level: isize) {
    if window.is_null() {
        return;
    }
    objc2::ffi::object_setClass(window, panel_class());
    // NSWindowStyleMaskNonactivatingPanel
    let mask: usize = msg_send![window, styleMask];
    let _: () = msg_send![window, setStyleMask: mask | (1 << 7)];
    let _: () = msg_send![window, setLevel: level];
    // auf allen Spaces (1), neben Vollbild-Programmen (1 << 8), nicht im ⌘`-Wechsel (1 << 6)
    let _: () = msg_send![window, setCollectionBehavior: (1usize) | (1 << 8) | (1 << 6)];
    let _: () = msg_send![window, setFloatingPanel: true];
    let _: () = msg_send![window, setHidesOnDeactivate: false];
    // Die Maske nachträglich gesetzt aktiviert das Programm sonst trotzdem (0.28)
    let sel = sel!(_setPreventsActivation:);
    let responds: bool = msg_send![window, respondsToSelector: sel];
    if responds {
        let _: () = msg_send![window, _setPreventsActivation: true];
    }
}

pub unsafe fn panel_visible(window: *mut AnyObject) -> bool {
    !window.is_null() && msg_send![window, isVisible]
}

/// Einblenden ohne Archiver zu aktivieren; `key`: nimmt Tastatureingaben an.
pub unsafe fn panel_show(window: *mut AnyObject, key: bool) {
    if window.is_null() {
        return;
    }
    let _: () = msg_send![window, setAlphaValue: 1.0f64];
    let _: () = msg_send![window, setIgnoresMouseEvents: false];
    if key {
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![window, makeKeyAndOrderFront: none];
        // Tastatur direkt ins Suchfeld: die Webansicht wird Ersthelfer
        let content: *mut AnyObject = msg_send![window, contentView];
        let web = find_webview(content);
        if !web.is_null() {
            let _: bool = msg_send![window, makeFirstResponder: web];
        }
    } else {
        let _: () = msg_send![window, orderFrontRegardless];
    }
}

/// Sucht die WKWebView unter einer Ansicht (Tiefensuche).
unsafe fn find_webview(view: *mut AnyObject) -> *mut AnyObject {
    if view.is_null() {
        return view;
    }
    let is_web: bool = msg_send![view, isKindOfClass: class!(WKWebView)];
    if is_web {
        return view;
    }
    let subs: *mut AnyObject = msg_send![view, subviews];
    let n: usize = if subs.is_null() { 0 } else { msg_send![subs, count] };
    for i in 0..n {
        let sub: *mut AnyObject = msg_send![subs, objectAtIndex: i];
        let found = find_webview(sub);
        if !found.is_null() {
            return found;
        }
    }
    std::ptr::null_mut()
}

/// Hinter alle Fenster legen, ohne Archiver zu aktivieren
pub unsafe fn order_back(window: *mut AnyObject) {
    if !window.is_null() {
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![window, orderBack: none];
    }
}

pub unsafe fn panel_hide(window: *mut AnyObject) {
    if !window.is_null() {
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![window, orderOut: none];
    }
}

/// Beim Herausziehen: fast unsichtbar und durchklickbar.
pub unsafe fn panel_ghost(window: *mut AnyObject, on: bool) {
    if window.is_null() {
        return;
    }
    let _: () = msg_send![window, setAlphaValue: if on { 0.06f64 } else { 1.0f64 }];
    let _: () = msg_send![window, setIgnoresMouseEvents: on];
}

/// Sichtbarer Bereich (ohne Menüleiste und Dock) des Bildschirms mit dem Zeiger.
unsafe fn mouse_screen_frame() -> Option<NSRect> {
    let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
    let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
    if screens.is_null() {
        return None;
    }
    let n: usize = msg_send![screens, count];
    let mut fallback = None;
    for i in 0..n {
        let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
        let frame: NSRect = msg_send![screen, frame];
        let visible: NSRect = msg_send![screen, visibleFrame];
        if fallback.is_none() {
            fallback = Some(visible);
        }
        let inside = mouse.x >= frame.origin.x
            && mouse.x <= frame.origin.x + frame.size.width
            && mouse.y >= frame.origin.y
            && mouse.y <= frame.origin.y + frame.size.height;
        if inside {
            return Some(visible);
        }
    }
    fallback
}

/// Palette mittig, etwas über der Mitte, auf dem Bildschirm mit dem Zeiger.
pub unsafe fn panel_center_on_mouse_screen(window: *mut AnyObject) {
    let Some(vf) = mouse_screen_frame() else { return };
    let frame: NSRect = msg_send![window, frame];
    let x = vf.origin.x + ((vf.size.width - frame.size.width) / 2.0).round();
    // Oberkante bei etwa einem Sechstel der Höhe von oben, wie Spotlight
    let top = vf.origin.y + vf.size.height - (vf.size.height / 6.0).round();
    let y = (top - frame.size.height).max(vf.origin.y);
    let rect = NSRect::new(NSPoint::new(x, y), frame.size);
    let _: () = msg_send![window, setFrame: rect, display: false];
}

/// Zonenleiste: volle Breite unten auf dem Bildschirm mit dem Zeiger.
pub unsafe fn panel_bottom_of_mouse_screen(window: *mut AnyObject, height: f64) {
    let Some(vf) = mouse_screen_frame() else { return };
    let rect = NSRect::new(vf.origin, NSSize::new(vf.size.width, height.min(vf.size.height)));
    let _: () = msg_send![window, setFrame: rect, display: true];
}

/// Linke Maustaste gedrückt? Und der Zähler der Drag-Zwischenablage.
pub fn drag_probe() -> (bool, isize) {
    objc2::rc::autoreleasepool(|_| unsafe {
        let buttons: usize = msg_send![class!(NSEvent), pressedMouseButtons];
        let name = NSString::from_str("Apple CFPasteboard drag");
        let board: *mut AnyObject = msg_send![class!(NSPasteboard), pasteboardWithName: &*name];
        let count: isize = if board.is_null() { 0 } else { msg_send![board, changeCount] };
        (buttons & 1 == 1, count)
    })
}

/// Werden gerade Dateien gezogen (nicht nur Text oder ein Link)?
pub fn drag_has_files() -> bool {
    objc2::rc::autoreleasepool(|_| unsafe {
        let name = NSString::from_str("Apple CFPasteboard drag");
        let board: *mut AnyObject = msg_send![class!(NSPasteboard), pasteboardWithName: &*name];
        if board.is_null() {
            return false;
        }
        let types: *mut AnyObject = msg_send![board, types];
        if types.is_null() {
            return false;
        }
        let file = NSString::from_str("public.file-url");
        msg_send![types, containsObject: &*file]
    })
}

/// Ist Archiver gerade das aktive Programm?
pub fn app_active() -> bool {
    unsafe {
        let me: *mut AnyObject = msg_send![class!(NSRunningApplication), currentApplication];
        !me.is_null() && msg_send![me, isActive]
    }
}

/// Programm, das gerade vorne ist (nicht Archiver selbst), gehalten bis
/// `activate_app` es wieder nach vorne holt. 0 = keins.
pub fn frontmost_other_app() -> usize {
    unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut AnyObject = msg_send![ws, frontmostApplication];
        let me: *mut AnyObject = msg_send![class!(NSRunningApplication), currentApplication];
        if app.is_null() {
            return 0;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        let my_pid: i32 = if me.is_null() { -1 } else { msg_send![me, processIdentifier] };
        if pid == my_pid {
            return 0;
        }
        let _: *mut AnyObject = msg_send![app, retain];
        app as usize
    }
}

/// Holt ein mit `frontmost_other_app` gemerktes Programm nach vorne und gibt es frei.
pub fn activate_app(app: usize) {
    if app == 0 {
        return;
    }
    unsafe {
        let app = app as *mut AnyObject;
        let _: bool = msg_send![app, activateWithOptions: 0usize];
        let _: () = msg_send![app, release];
    }
}

/// Gibt ein gemerktes Programm frei, ohne es zu aktivieren.
pub fn release_app(app: usize) {
    if app != 0 {
        unsafe {
            let _: () = msg_send![app as *mut AnyObject, release];
        }
    }
}

// ---- Start über „Öffnen mit“ ----

/// Wurde Archiver gestartet, um Dateien zu öffnen (Finder-Doppelklick,
/// „Öffnen mit“)? Beim Start liegt dann das Apple Event 'odoc' an statt 'oapp'.
/// Nur während des Starts (RunEvent::Ready) aussagekräftig.
pub fn launched_with_documents() -> bool {
    unsafe {
        let mgr: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        if mgr.is_null() {
            return false;
        }
        let event: *mut AnyObject = msg_send![mgr, currentAppleEvent];
        if event.is_null() {
            return false;
        }
        let id: u32 = msg_send![event, eventID];
        id == u32::from_be_bytes(*b"odoc")
    }
}

/// Schiebt ein Fenster hinter alle anderen seiner Ebene, ohne es zu schließen
/// (Hauptfenster, wenn nur der Betrachter nach vorne soll).
pub unsafe fn send_to_back(window: *mut AnyObject) {
    if !window.is_null() {
        // NSWindowBelow = -1, relativeTo 0: unter alle Fenster
        let _: () = msg_send![window, orderWindow: -1isize, relativeTo: 0isize];
    }
}

/// Bundle-ID eines mit `frontmost_other_app` gemerkten Programms.
pub fn app_bundle_id(app: usize) -> Option<String> {
    if app == 0 {
        return None;
    }
    unsafe {
        let id: *mut AnyObject = msg_send![app as *mut AnyObject, bundleIdentifier];
        let s = rust_string(id);
        (!s.is_empty()).then_some(s)
    }
}
