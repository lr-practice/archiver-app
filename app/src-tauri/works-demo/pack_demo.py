# Packt „Works Demo“ für works.rs (include_bytes): je Datei eine Kopfzeile
# "<Pfad>\t<Tage alt>\t<Bytes>\n", danach die Bytes.
import os, sys, time
src, out = sys.argv[1], sys.argv[2]
now = time.time()
buf = bytearray(b"ARCHIVER-WORKS-DEMO 1\n")
for dp, dn, fn in sorted(os.walk(src)):
    dn.sort()
    for f in sorted(fn):
        p = os.path.join(dp, f); rel = os.path.relpath(p, src)
        data = open(p, "rb").read()
        days = max(0, round((now - os.path.getmtime(p)) / 86400))
        buf += f"{rel}\t{days}\t{len(data)}\n".encode(); buf += data
open(out, "wb").write(buf); print(len(buf))
