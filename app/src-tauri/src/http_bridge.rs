// http_bridge.rs
// Brücke zur Safari-Extension über HTTP auf 127.0.0.1 (Safari-Extension, in Arbeit).
//
// Safari kennt kein Native Messaging zu einem fremden Programm: Nachrichten
// erreichen nur die App-Erweiterung in Archiver.app (SafariWebExtensionHandler),
// und die läuft in einer Sandbox ohne Zugriff auf die Bibliothek. Deshalb
// öffnet die laufende App einen kleinen HTTP-Server nur auf 127.0.0.1 und
// beantwortet dort dieselben Befehle wie der stdin-Host (bridge::dispatch).
//
// Anfragen:
//   POST /bridge  Content-Type: application/json         {"cmd": …, …}
//   POST /bridge  Content-Type: application/octet-stream  "save_data":
//       X-Archiver-Meta-Length: N, im Körper erst N Bytes JSON (die Angaben
//       wie bei "save"), danach die Datei selbst. Die Datei landet in einem
//       eigenen Zwischenordner und geht von dort wie bei Chrome in die Zone.
//
// Schutz: nur 127.0.0.1, Host muss 127.0.0.1/localhost mit unserem Port sein
// (gegen DNS-Rebinding), Origin muss eine Safari-Extension sein, und jede
// Anfrage trägt "X-Archiver: 1". Webseiten können diesen Kopf nur mit einer
// CORS-Vorabfrage setzen, und die beantworten wir nur für Safari-Extensions.
// Der pfadbasierte Befehl "save" (Downloads/Archiver-Transfer) ist hier gesperrt.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

/// Feste Ports, der erste freie gilt. Die Extension probiert dieselbe Liste.
pub const PORTS: [u16; 3] = [47613, 47614, 47615];
const ORIGIN_PREFIX: &str = "safari-web-extension://";
/// Größte Datei, die Safari übergeben darf (Videos inklusive)
const MAX_BODY: u64 = 200 * 1024 * 1024;
const MAX_JSON: u64 = 8 * 1024 * 1024;
const MAX_META: u64 = 1024 * 1024;
const MAX_HEAD: u64 = 16 * 1024;
const MAX_CONNECTIONS: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(60);

/// Server im Hintergrund starten (nur in der laufenden App, nie im Host-Modus).
pub fn start() {
    std::thread::spawn(|| {
        for port in PORTS {
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => return serve(listener, port),
                Err(e) => crate::log::warn("http-bridge", format!("Port {port}: {e}")),
            }
        }
        crate::log::error("http-bridge", "Kein Port frei, Safari-Extension ohne App");
    });
}

fn serve(listener: TcpListener, port: u16) {
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if ACTIVE.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
            let _ = respond(&mut &stream, 503, None, &json!({ "ok": false, "error": "busy" }));
            continue;
        }
        ACTIVE.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            let _ = connection(stream, port);
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn connection(stream: TcpStream, port: u16) -> std::io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let mut writer = stream.try_clone()?;
    handle_connection(&stream, &mut writer, port, &|msg, data| crate::bridge::dispatch(msg, data))
}

// ---- Anfrage lesen ----

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Eine Zeile des Kopfes, gemessen am verbleibenden Budget.
fn next_line(reader: &mut impl BufRead, budget: &mut u64) -> Result<String, String> {
    let mut line = String::new();
    let n = reader.by_ref().take(*budget).read_line(&mut line).map_err(|e| e.to_string())?;
    if n == 0 || !line.ends_with('\n') {
        return Err("Kopf unvollständig oder zu groß".into());
    }
    *budget -= n as u64;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

/// Kopf bis zur Leerzeile, höchstens MAX_HEAD Bytes. Namen klein geschrieben.
fn read_head(reader: &mut impl BufRead) -> Result<Request, String> {
    let mut budget = MAX_HEAD;
    let first = next_line(reader, &mut budget)?;
    let mut parts = first.split(' ');
    let (Some(method), Some(path), Some(version)) = (parts.next(), parts.next(), parts.next()) else {
        return Err("Anfragezeile unlesbar".into());
    };
    if !version.starts_with("HTTP/1.") {
        return Err("Nur HTTP/1.x".into());
    }
    let mut headers = Vec::new();
    loop {
        let line = next_line(reader, &mut budget)?;
        if line.is_empty() {
            break;
        }
        let (k, v) = line.split_once(':').ok_or("Kopfzeile unlesbar")?;
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    Ok(Request { method: method.to_string(), path: path.to_string(), headers })
}

/// Nur Safari-Extensions (safari-web-extension://<UUID>), keine Webseiten.
fn allowed_origin(origin: Option<&str>) -> Option<&str> {
    let o = origin?;
    let rest = o.strip_prefix(ORIGIN_PREFIX)?;
    let ok = !rest.is_empty() && rest.trim_end_matches('/').chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    ok.then_some(o)
}

/// Host-Kopf muss auf uns zeigen (gegen DNS-Rebinding).
fn host_ok(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
}

// ---- Antworten ----

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

fn respond(out: &mut impl Write, code: u16, origin: Option<&str>, body: &Value) -> std::io::Result<()> {
    let bytes = if code == 204 { Vec::new() } else { serde_json::to_vec(body).unwrap_or_default() };
    let mut head = format!("HTTP/1.1 {code} {}\r\nConnection: close\r\nCache-Control: no-store\r\nVary: Origin\r\n", reason(code));
    if code != 204 {
        head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", bytes.len()));
    }
    if let Some(o) = origin {
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {o}\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\n\
             Access-Control-Allow-Headers: Content-Type, X-Archiver, X-Archiver-Meta-Length\r\nAccess-Control-Max-Age: 600\r\n"
        ));
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())?;
    out.write_all(&bytes)?;
    out.flush()
}

fn fail(out: &mut impl Write, code: u16, origin: Option<&str>, error: &str) -> std::io::Result<()> {
    respond(out, code, origin, &json!({ "ok": false, "error": error }))
}

type Dispatch<'a> = &'a dyn Fn(&Value, Option<&Path>) -> Value;

/// Eine Verbindung, eine Anfrage, eine Antwort.
fn handle_connection(input: impl Read, out: &mut impl Write, port: u16, dispatch: Dispatch) -> std::io::Result<()> {
    let mut reader = BufReader::new(input);
    let req = match read_head(&mut reader) {
        Ok(r) => r,
        Err(e) => return fail(out, 400, None, &e),
    };
    if !host_ok(req.header("host"), port) {
        return fail(out, 403, None, "host");
    }
    let Some(origin) = allowed_origin(req.header("origin")) else {
        return fail(out, 403, None, "origin");
    };
    let origin = Some(origin);
    if req.path != "/bridge" {
        return fail(out, 404, origin, "path");
    }
    match req.method.as_str() {
        "OPTIONS" => return respond(out, 204, origin, &Value::Null),
        "POST" => {}
        _ => return fail(out, 405, origin, "method"),
    }
    if req.header("x-archiver") != Some("1") {
        return fail(out, 403, origin, "x-archiver");
    }
    if req.header("transfer-encoding").is_some() {
        return fail(out, 411, origin, "chunked");
    }
    let Some(len) = req.header("content-length").and_then(|l| l.parse::<u64>().ok()) else {
        return fail(out, 411, origin, "content-length");
    };
    if len > MAX_BODY {
        return fail(out, 413, origin, "too-large");
    }
    let kind = req.header("content-type").unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match kind.as_str() {
        "application/json" => {
            if len > MAX_JSON {
                return fail(out, 413, origin, "too-large");
            }
            let mut body = Vec::with_capacity(len as usize);
            reader.by_ref().take(len).read_to_end(&mut body)?;
            if body.len() as u64 != len {
                return fail(out, 400, origin, "body");
            }
            let msg: Value = match serde_json::from_slice(&body) {
                Ok(v @ Value::Object(_)) => v,
                _ => return fail(out, 400, origin, "bad-message"),
            };
            // Pfade aus Downloads nimmt nur der Chrome-Host; Dateien kommen hier als Bytes
            if matches!(msg.get("cmd").and_then(|c| c.as_str()), Some("save" | "save_data")) {
                return fail(out, 400, origin, "save-via-http");
            }
            respond(out, 200, origin, &dispatch(&msg, None))
        }
        "application/octet-stream" => {
            let meta_len = req.header("x-archiver-meta-length").and_then(|l| l.parse::<u64>().ok());
            let Some(meta_len) = meta_len.filter(|m| *m <= MAX_META && *m <= len) else {
                return fail(out, 400, origin, "meta-length");
            };
            let mut meta = Vec::with_capacity(meta_len as usize);
            reader.by_ref().take(meta_len).read_to_end(&mut meta)?;
            let mut msg: Value = match serde_json::from_slice(&meta) {
                Ok(v @ Value::Object(_)) if meta.len() as u64 == meta_len => v,
                _ => return fail(out, 400, origin, "bad-meta"),
            };
            msg["cmd"] = json!("save_data");
            let upload = match Upload::receive(&mut reader, len - meta_len) {
                Ok(u) => u,
                Err(e) => return fail(out, 400, origin, &e),
            };
            let reply = dispatch(&msg, Some(&upload.file));
            drop(upload);
            respond(out, 200, origin, &reply)
        }
        _ => fail(out, 415, origin, "content-type"),
    }
}

/// Datei der Safari-Extension in einem eigenen, frischen Zwischenordner.
/// Der Ordner verschwindet mit dem Wert, auch wenn die Übernahme scheitert.
struct Upload {
    dir: PathBuf,
    file: PathBuf,
}

impl Upload {
    fn receive(reader: &mut impl Read, len: u64) -> Result<Upload, String> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("archiver-safari-{}-{nanos}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        // Ab hier räumt Drop auf
        let upload = Upload { file: dir.join("image"), dir };
        let mut f = std::fs::File::create(&upload.file).map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut reader.by_ref().take(len), &mut f).map_err(|e| e.to_string())?;
        if copied != len {
            return Err("Datei unvollständig".into());
        }
        f.sync_all().map_err(|e| e.to_string())?;
        if len == 0 {
            return Err("Datei leer".into());
        }
        Ok(upload)
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 47613;
    const EXT: &str = "safari-web-extension://3F2504E0-4F89-11D3-9A0C-0305E82C3301";

    fn request(method: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut r = format!("{method} /bridge HTTP/1.1\r\n").into_bytes();
        for (k, v) in headers {
            r.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
        }
        r.extend_from_slice(b"\r\n");
        r.extend_from_slice(body);
        r
    }

    fn json_post(origin: &str, body: &str) -> Vec<u8> {
        let len = body.len().to_string();
        request(
            "POST",
            &[("Host", "127.0.0.1:47613"), ("Origin", origin), ("X-Archiver", "1"), ("Content-Type", "application/json"), ("Content-Length", &len)],
            body.as_bytes(),
        )
    }

    /// Antwort als (Status, Kopf, JSON-Körper)
    fn run(raw: &[u8], dispatch: Dispatch) -> (u16, String, Value) {
        let mut out = Vec::new();
        handle_connection(raw, &mut out, PORT, dispatch).unwrap();
        let text = String::from_utf8(out).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let code = head[9..12].parse().unwrap();
        (code, head.to_string(), serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn echo(msg: &Value, data: Option<&Path>) -> Value {
        json!({ "ok": true, "cmd": msg["cmd"], "data": data.is_some() })
    }

    #[test]
    fn real_socket_roundtrip() {
        // echter Server auf einem freien Port: Kopf, Körper und Antwort über TCP
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || serve(listener, port));
        let ask = |raw: String| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(raw.as_bytes()).unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        };
        let body = r#"{"cmd":"gibt-es-nicht","id":7}"#;
        let out = ask(format!(
            "POST /bridge HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {EXT}\r\nX-Archiver: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        let json: Value = serde_json::from_str(out.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!((json["ok"].as_bool(), json["id"].as_i64()), (Some(false), Some(7)));
        let out = ask(format!("POST /bridge HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\nContent-Length: 0\r\n\r\n"));
        assert!(out.starts_with("HTTP/1.1 403"), "{out}");
    }

    #[test]
    fn origin_and_host_checks() {
        assert!(allowed_origin(Some(EXT)).is_some());
        assert!(allowed_origin(Some("safari-web-extension://ABC-123/")).is_some());
        for bad in ["https://evil.example", "chrome-extension://abc", "safari-web-extension://", "safari-web-extension://a b", "null"] {
            assert!(allowed_origin(Some(bad)).is_none(), "{bad}");
        }
        assert!(allowed_origin(None).is_none());
        assert!(host_ok(Some("127.0.0.1:47613"), PORT));
        assert!(host_ok(Some("localhost:47613"), PORT));
        assert!(!host_ok(Some("evil.example:47613"), PORT), "DNS-Rebinding");
        assert!(!host_ok(Some("127.0.0.1:47614"), PORT));
        assert!(!host_ok(None, PORT));
    }

    #[test]
    fn parses_head_case_insensitive() {
        let raw = b"POST /bridge HTTP/1.1\r\nHOST: 127.0.0.1:47613\r\nx-ArChIvEr:  1 \r\n\r\nrest";
        let mut r = BufReader::new(&raw[..]);
        let req = read_head(&mut r).unwrap();
        assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", "/bridge"));
        assert_eq!(req.header("x-archiver"), Some("1"));
        let mut rest = String::new();
        r.read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "rest");
        assert!(read_head(&mut BufReader::new(&b"GARBAGE\r\n\r\n"[..])).is_err());
        assert!(read_head(&mut BufReader::new(&b"POST /bridge HTTP/1.1\r\nHost: x"[..])).is_err(), "kein Ende");
        let huge = format!("POST /bridge HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(20_000));
        assert!(read_head(&mut BufReader::new(huge.as_bytes())).is_err(), "Kopf zu groß");
    }

    #[test]
    fn rejects_web_pages_and_answers_extensions() {
        let (code, head, _) = run(&json_post("https://evil.example", r#"{"cmd":"hello"}"#), &echo);
        assert_eq!(code, 403);
        assert!(!head.contains("Access-Control-Allow-Origin"));
        // ohne Origin (z. B. curl) ebenso
        let raw = request("POST", &[("Host", "127.0.0.1:47613"), ("X-Archiver", "1"), ("Content-Type", "application/json"), ("Content-Length", "2")], b"{}");
        assert_eq!(run(&raw, &echo).0, 403);
        // falscher Host
        let raw = request("POST", &[("Host", "evil.example"), ("Origin", EXT), ("X-Archiver", "1"), ("Content-Length", "2")], b"{}");
        assert_eq!(run(&raw, &echo).0, 403);
        // ohne X-Archiver (einfache Anfrage ohne Vorabfrage)
        let raw = request("POST", &[("Host", "127.0.0.1:47613"), ("Origin", EXT), ("Content-Type", "application/json"), ("Content-Length", "2")], b"{}");
        assert_eq!(run(&raw, &echo).0, 403);
        // Vorabfrage nur für Extensions
        let pre = |o: &str| request("OPTIONS", &[("Host", "127.0.0.1:47613"), ("Origin", o), ("Access-Control-Request-Headers", "x-archiver")], b"");
        let mut out = Vec::new();
        handle_connection(&pre(EXT)[..], &mut out, PORT, &echo).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("HTTP/1.1 204"));
        assert!(text.contains(&format!("Access-Control-Allow-Origin: {EXT}")));
        assert!(text.contains("X-Archiver"));
        assert_eq!(run(&pre("https://evil.example"), &echo).0, 403);
        // Erlaubt: JSON-Befehl geht an dispatch
        let (code, head, body) = run(&json_post(EXT, r#"{"cmd":"zones","id":3}"#), &echo);
        assert_eq!(code, 200);
        assert!(head.contains(&format!("Access-Control-Allow-Origin: {EXT}")));
        assert_eq!(body["cmd"], "zones");
        assert_eq!(body["data"], false);
    }

    #[test]
    fn limits_and_blocked_commands() {
        // pfadbasiertes "save" nur über den Chrome-Host
        let (code, _, body) = run(&json_post(EXT, r#"{"cmd":"save","file":"/etc/passwd"}"#), &echo);
        assert_eq!((code, body["error"].as_str()), (400, Some("save-via-http")));
        assert_eq!(run(&json_post(EXT, r#"{"cmd":"save_data"}"#), &echo).0, 400);
        assert_eq!(run(&json_post(EXT, "[1,2]"), &echo).0, 400);
        let too_big = (MAX_BODY + 1).to_string();
        let raw = request("POST", &[("Host", "127.0.0.1:47613"), ("Origin", EXT), ("X-Archiver", "1"), ("Content-Type", "application/octet-stream"), ("Content-Length", &too_big)], b"");
        assert_eq!(run(&raw, &echo).0, 413);
        let raw = request("POST", &[("Host", "127.0.0.1:47613"), ("Origin", EXT), ("X-Archiver", "1"), ("Content-Type", "application/json")], b"{}");
        assert_eq!(run(&raw, &echo).0, 411);
        let raw = request("POST", &[("Host", "127.0.0.1:47613"), ("Origin", EXT), ("X-Archiver", "1"), ("Content-Type", "text/plain"), ("Content-Length", "2")], b"{}");
        assert_eq!(run(&raw, &echo).0, 415);
        // abgeschnittener Körper
        let raw = request("POST", &[("Host", "127.0.0.1:47613"), ("Origin", EXT), ("X-Archiver", "1"), ("Content-Type", "application/json"), ("Content-Length", "50")], b"{}");
        assert_eq!(run(&raw, &echo).0, 400);
    }

    fn upload_request(meta: &Value, file: &[u8]) -> Vec<u8> {
        let meta = serde_json::to_vec(meta).unwrap();
        let mut body = meta.clone();
        body.extend_from_slice(file);
        let (len, mlen) = (body.len().to_string(), meta.len().to_string());
        request(
            "POST",
            &[
                ("Host", "127.0.0.1:47613"),
                ("Origin", EXT),
                ("X-Archiver", "1"),
                ("Content-Type", "application/octet-stream"),
                ("Content-Length", &len),
                ("X-Archiver-Meta-Length", &mlen),
            ],
            &body,
        )
    }

    #[test]
    fn save_data_lands_in_zone_and_cleans_up() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Bib");
        std::fs::create_dir_all(root.join("Typo")).unwrap();
        let lib = crate::library::Library::open(&root).unwrap();
        let png = tmp.path().join("p.png");
        image::RgbImage::from_pixel(3, 2, image::Rgb([200, 30, 30])).save(&png).unwrap();
        let bytes = std::fs::read(&png).unwrap();

        let seen = std::sync::Mutex::new(None::<PathBuf>);
        let save = |msg: &Value, data: Option<&Path>| -> Value {
            assert_eq!(msg["cmd"], "save_data", "cmd kommt von der Brücke, nicht aus den Angaben");
            let file = data.unwrap();
            assert_eq!(std::fs::read(file).unwrap(), bytes);
            *seen.lock().unwrap() = Some(file.parent().unwrap().to_path_buf());
            match crate::bridge::save(&lib, msg, file, None) {
                Ok(mut v) => {
                    v["ok"] = json!(true);
                    v
                }
                Err(e) => json!({ "ok": false, "error": e }),
            }
        };
        let meta = json!({ "cmd": "list", "name": "Rot ü.png", "zone": "Typo", "pageUrl": "https://example.com/a", "pageTitle": "Beispiel ä", "imageUrl": "https://example.com/r.png" });
        let (code, _, body) = run(&upload_request(&meta, &bytes), &save);
        assert_eq!(code, 200);
        assert_eq!(body["ok"], true, "{body}");
        assert_eq!(body["path"], "Typo/Rot ü.png");
        assert_eq!(body["duplicate"], false);
        assert!(root.join("Typo/Rot ü.png").is_file());
        let dir = seen.lock().unwrap().clone().unwrap();
        assert!(!dir.exists(), "Zwischenordner weg");
        // gleiches Bild noch einmal: Duplikat, Zwischenordner trotzdem weg
        let (_, _, body) = run(&upload_request(&meta, &bytes), &save);
        assert_eq!(body["duplicate"], true);
        assert!(!seen.lock().unwrap().as_ref().unwrap().exists());
        // Bibliothek kennt die Quelle
        let items = lib.items_under(Some("Typo")).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].page_url.as_deref(), Some("https://example.com/a"));
    }

    #[test]
    fn save_data_rejects_bad_framing() {
        let never = |_: &Value, _: Option<&Path>| -> Value { panic!("darf nicht ankommen") };
        // Angaben länger als der Körper
        let raw = request(
            "POST",
            &[("Host", "127.0.0.1:47613"), ("Origin", EXT), ("X-Archiver", "1"), ("Content-Type", "application/octet-stream"), ("Content-Length", "4"), ("X-Archiver-Meta-Length", "10")],
            b"{}ab",
        );
        assert_eq!(run(&raw, &never).0, 400);
        // keine Datei hinter den Angaben
        assert_eq!(run(&upload_request(&json!({}), b""), &never).0, 400);
        // Datei kürzer als angekündigt
        let mut raw = upload_request(&json!({}), b"0123456789");
        raw.truncate(raw.len() - 4);
        assert_eq!(run(&raw, &never).0, 400);
    }
}
