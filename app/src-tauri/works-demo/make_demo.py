# Zwei Demo-Kunden für Works (erfunden). Aufruf: python3 make_demo.py <Zielordner>
import os, random, shutil, sys, time
from PIL import Image, ImageDraw, ImageFont
R = sys.argv[1]
shutil.rmtree(R, ignore_errors=True)
F = "/usr/share/fonts/opentype/inter/"
def font(w, s): return ImageFont.truetype(F + {"black":"Inter-Black.otf","bold":"Inter-Bold.otf"}.get(w,"Inter-Regular.otf"), s)
def mk(p): os.makedirs(os.path.dirname(p), exist_ok=True)
T0 = time.time()
def stamp(p, days):
    t = T0 - days*86400; os.utime(p, (t, t))

def save(im, p, days):
    mk(p)
    if p.endswith(".pdf"): im.convert("RGB").save(p, "PDF", resolution=72)
    elif p.endswith(".jpg"): im.convert("RGB").save(p, quality=86)
    else: im.save(p)
    stamp(p, days)

def poster(p, v, days, bg, fg, acc, title, sub, size=(840,1188)):
    W, H = size
    im = Image.new("RGB", (W, H), bg); d = ImageDraw.Draw(im)
    k = W/840
    if v >= 1: d.ellipse((120*k, 140*k, 720*k, 740*k), fill=acc)
    if v >= 2: d.rectangle((0, 800*k, W, 836*k), fill=fg)
    if v >= 3: d.ellipse((540*k, 70*k, 780*k, 310*k), fill=fg)
    d.text((60*k, 880*k), title, font=font("black", int((86 if v < 3 else 98)*k)), fill=fg)
    d.text((60*k, 1010*k), sub, font=font("reg", int(28*k)), fill=fg)
    if v >= 2: d.text((60*k, 1056*k), "Eintritt frei am ersten Mittwoch", font=font("reg", int(24*k)), fill=fg)
    save(im, p, days)

def wide(p, v, days, bg, fg, acc, title):
    W, H = 1440, 900
    im = Image.new("RGB", (W, H), bg); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W, 72), fill=fg)
    d.text((40, 20), "Linde", font=font("bold", 30), fill=bg)
    for i, m in enumerate(["Karte", "Röstung", "Besuch"]): d.text((900 + i*170, 24), m, font=font("reg", 24), fill=bg)
    d.text((80, 200), title, font=font("black", 110 if v > 1 else 90), fill=fg)
    d.text((80, 360), "Kaffee aus eigener Röstung, seit 1987.", font=font("reg", 34), fill=fg)
    d.rectangle((80, 460, 380, 530), fill=acc); d.text((110, 476), "Zur Karte", font=font("bold", 30), fill=bg)
    if v >= 2: d.ellipse((900, 260, 1340, 700), fill=acc)
    if v >= 3: d.rectangle((900, 720, 1340, 760), fill=fg)
    save(im, p, days)

def ref(p, days, seed, pal):
    random.seed(seed)
    W, H = random.choice([(900,1200),(1200,900),(1000,1000),(800,1100)])
    im = Image.new("RGB", (W,H), pal[0]); d = ImageDraw.Draw(im)
    for _ in range(random.randint(3,7)):
        x, y = random.randint(0,W), random.randint(0,H); r = random.randint(60, 380); c = random.choice(pal[1:])
        if random.random() < .5: d.ellipse((x-r,y-r,x+r,y+r), fill=c)
        else: d.rectangle((x-r,y-r//3,x+r,y+r//3), fill=c)
    save(im, p, days)

def doc(p, days, lines):
    im = Image.new("RGB", (595, 842), "white"); d = ImageDraw.Draw(im)
    y = 70
    for i, l in enumerate(lines):
        d.text((60, y), l, font=font("bold" if i == 0 else "reg", 22 if i == 0 else 13), fill="#1d1d1b"); y += 40 if i == 0 else 22
    save(im, p, days)

def text(p, days, s):
    mk(p); open(p, "w", encoding="utf-8").write(s); stamp(p, days)

def logo(p, txt, col):
    im = Image.new("RGBA", (800, 400), (0,0,0,0)); d = ImageDraw.Draw(im)
    d.text((40, 110), txt, font=font("black", 150), fill=col); save(im, p, 120)

def eml(p, days, frm, subj, date, body):
    text(p, days, f"From: {frm}\r\nTo: studio@example.org\r\nSubject: {subj}\r\nDate: {date}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n")

def phases(P, names=("00 Post","01 Brief","02 Recherche","03 Layout","04 Reinzeichnung","05 Übergabe")):
    for n in names: os.makedirs(f"{P}/{n}", exist_ok=True)

# ---- Kunde 1: Kunstverein Nordhafen (erfunden) ----
K = f"{R}/Kunstverein Nordhafen"
P = f"{K}/2026-021 Plakat Herbstausstellung"
phases(P)
text(f"{P}/01 Brief/brief.md", 24, """---
termin: 2026-10-30
status: laufend
nächster schritt: V3 mit Korrektur an Frau Brandt schicken
ansprechpartner: Mara Brandt, Kommunikation
---

# Plakat Herbstausstellung

Kunde: Kunstverein Nordhafen

## Aufgabe

Plakat und Ableitungen für die Ausstellung **„Form und Licht“**. Ein Motiv, das in der Stadt aus 20 Metern funktioniert.

## Formate

- A1 Plakat, 4/0 farbig
- Citylight 1185 × 1750 mm
- Instagram 1080 × 1350

## Notizen

Logo immer unten rechts, Mindestgröße 30 mm.
""")
doc(f"{P}/01 Brief/Ausschreibung Plakat.pdf", 25, ["Ausschreibung", "Kunstverein Nordhafen · Herbstausstellung 2026", "", "Gesucht: Plakat A1, Citylight, Social Media.", "Abgabe Entwurf: 9.10.2026", "Druck: 2.11.2026"])
pal = ["#ece6d9","#1d1d1b","#d9482b","#2d5aeb"]
for i in range(9): ref(f"{P}/02 Recherche/Referenz_{i+1:02d}.jpg", 20 - i, i, pal)
sub = "Kunstverein Nordhafen · 7.11.2026–1.2.2027"
poster(f"{P}/03 Layout/Plakat_A1_V1.pdf", 1, 14, "#efe9dc", "#1d1d1b", "#d9482b", "Form und Licht", sub)
poster(f"{P}/03 Layout/Plakat_A1_V2.pdf", 2, 8, "#efe9dc", "#1d1d1b", "#d9482b", "Form und Licht", sub)
poster(f"{P}/03 Layout/Plakat_A1_V3_KORR.pdf", 3, 2, "#efe9dc", "#1d1d1b", "#2d5aeb", "Form und Licht", sub)
poster(f"{P}/03 Layout/Citylight_V1.pdf", 1, 6, "#0f2a44", "#f2efe6", "#e8b23a", "Form und Licht", sub)
poster(f"{P}/03 Layout/Citylight_V2.pdf", 2, 3, "#0f2a44", "#f2efe6", "#e8b23a", "Form und Licht", sub)
eml(f"{P}/00 Post/2026-09-08 Anfrage Plakat.eml", 38, '"Mara Brandt" <brandt@kunstverein-nordhafen.example>', "Anfrage Plakat Herbstausstellung", "Tue, 08 Sep 2026 09:12:00 +0200", "Hallo,\r\n\r\nwir suchen für die Herbstausstellung ein Plakat. Die Ausschreibung hängt an.\r\n\r\nViele Grüße\r\nMara Brandt")
eml(f"{P}/00 Post/2026-10-14 Korrektur V2.eml", 2, '"Mara Brandt" <brandt@kunstverein-nordhafen.example>', "Re: Plakat V2 – Korrekturen", "Wed, 14 Oct 2026 16:40:00 +0200", "Hallo,\r\n\r\nV2 gefällt uns. Bitte das Blau aus dem Logo nehmen und den Termin größer.\r\n\r\nMara")
doc(f"{P}/00 Post/Angebot_2026-031_4.200,00 EUR.pdf", 36, ["Angebot 2026-031", "Kunstverein Nordhafen · Plakat Herbstausstellung", "", "Konzept und Entwurf          2.400,00 EUR", "Ableitungen (2 Formate)      1.200,00 EUR", "Reinzeichnung                  600,00 EUR", "", "Summe netto                 4.200,00 EUR"])
doc(f"{P}/00 Post/Rechnung_2026-021_1.850,00 EUR.pdf", 34, ["Rechnung 2026-021", "Abschlag 1 · Plakat Herbstausstellung", "", "Betrag netto                1.850,00 EUR", "Zahlbar innerhalb von 14 Tagen"])
logo(f"{K}/_Assets/Logos/KVN_Logo_schwarz.png", "KVN", (20,20,20,255))
logo(f"{K}/_Assets/Logos/KVN_Logo_blau.png", "KVN", (45,90,235,255))
ref(f"{K}/_Assets/Bilder/Haus_Nordhafen.jpg", 120, 99, pal)

P2 = f"{K}/2026-027 Katalog Form und Licht"
phases(P2)
text(f"{P2}/01 Brief/brief.md", 12, "---\ntermin: 2026-12-04\nstatus: laufend\nnächster schritt: Bildauswahl mit der Kuratorin\n---\n\n# Katalog Form und Licht\n\n96 Seiten, 21 × 28 cm, Fadenheftung.\n")
for i in range(5): ref(f"{P2}/02 Recherche/Katalog_{i+1:02d}.jpg", 10 - i, 40 + i, pal)

# ---- Kunde 2: Rösterei Linde (erfunden) ----
S = f"{R}/Rösterei Linde"
P3 = f"{S}/2026-018 Website Relaunch"
phases(P3)
text(f"{P3}/01 Brief/brief.md", 50, """---
termin: 2026-10-20
status: laufend
nächster schritt: Startseite V3 final abstimmen
ansprechpartner: Jonas Linde
---

# Website Relaunch

Neue Website mit Karte, Röstkalender und Besuchszeiten. Mobil zuerst.
""")
pal2 = ["#f3e7d8","#2b2420","#3b7d5a","#c8743a"]
for i in range(6): ref(f"{P3}/02 Recherche/Moodboard_{i+1:02d}.jpg", 40 - i*3, 70 + i, pal2)
wide(f"{P3}/03 Layout/Startseite_V1.pdf", 1, 16, "#f3e7d8", "#2b2420", "#3b7d5a", "Gut geröstet.")
wide(f"{P3}/03 Layout/Startseite_V2.pdf", 2, 9, "#f3e7d8", "#2b2420", "#3b7d5a", "Gut geröstet.")
wide(f"{P3}/03 Layout/Startseite_V3.pdf", 3, 3, "#f3e7d8", "#2b2420", "#c8743a", "Gut geröstet.")
eml(f"{P3}/00 Post/2026-08-27 Relaunch.eml", 50, '"Jonas Linde" <jonas@roesterei-linde.example>', "Neue Website", "Thu, 27 Aug 2026 11:05:00 +0200", "Hi,\r\n\r\nwir wollen die Website neu machen. Hast du im September Zeit?\r\n\r\nJonas")
doc(f"{P3}/00 Post/Angebot_2026-024_6.800,00 EUR.pdf", 48, ["Angebot 2026-024", "Rösterei Linde · Website Relaunch", "", "Konzept, Design, 6 Vorlagen    6.800,00 EUR"])
doc(f"{P3}/00 Post/Rechnung_2026-009_2.400,00 EUR.pdf", 42, ["Rechnung 2026-009", "Abschlag 1 · Website Relaunch", "", "Betrag netto                2.400,00 EUR"])
logo(f"{S}/_Assets/Logos/Linde_Logo.png", "Linde", (43,36,32,255))

P4 = f"{S}/2026-006 Verpackung Espresso"
phases(P4)
text(f"{P4}/01 Brief/brief.md", 160, "---\ntermin: 2026-05-15\nstatus: abgeschlossen\n---\n\n# Verpackung Espresso\n\n250-g-Beutel, drei Sorten.\n")
poster(f"{P4}/04 Reinzeichnung/Beutel_Espresso_RZ.pdf", 3, 150, "#2b2420", "#f3e7d8", "#c8743a", "Espresso", "Rösterei Linde · 250 g", (700, 1000))
poster(f"{P4}/05 Übergabe/Beutel_Espresso_PDFX4.pdf", 3, 148, "#2b2420", "#f3e7d8", "#c8743a", "Espresso", "Rösterei Linde · 250 g", (700, 1000))
print("ok")
