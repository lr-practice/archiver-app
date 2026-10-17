// Suche (app/src/search.js): App und Tray finden dasselbe, ganze Wörter und
// deutsche Wortformen zählen, unsichere Motive und Wortfetzen nicht.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../../app/src/search.js", import.meta.url), "utf8");
const win = {};
vm.runInNewContext(src, { window: win });
const S = win.ArchiverSearch;

const item = (o) => ({ filename: "", zone: "Unsorted", labels: "", text: "", colors: "", ...o });
const find = (items, q) => items.filter((i) => S.score(i, S.parse(q)) > 0).map((i) => i.filename);

test("deutsche Wortformen: Kreise, Kreisen und Kreis finden dasselbe Motiv", () => {
  const a = item({ filename: "a.jpg", labels: "circle:0.81" });
  for (const q of ["kreis", "kreise", "kreisen ", "Kreise"]) assert.deepEqual(find([a], q), ["a.jpg"], q);
});

test("unsichere Motive zählen nicht", () => {
  const sure = item({ filename: "sure.jpg", labels: "people:0.74, art:0.52" });
  const weak = item({ filename: "weak.jpg", labels: "art:0.88, people:0.31" });
  assert.deepEqual(find([sure, weak], "menschen "), ["sure.jpg"]);
  assert.deepEqual([...S.motifs(weak, 6)], ["art"]); // Array aus dem vm-Kontext
});

test("ältere Analysen ohne Sicherheit: nur die ersten vier Motive", () => {
  const old = item({ filename: "old.jpg", labels: "poster, art, text, illustration, people, plant" });
  assert.deepEqual(find([old], "plakat "), ["old.jpg"]);
  assert.deepEqual(find([old], "pflanze "), []);
});

test("kein Treffer mitten im Wort: rot findet weder Brot noch Protokoll", () => {
  const items = [item({ filename: "brot.jpg" }), item({ filename: "protokoll.jpg" }), item({ filename: "rot-quadrat.jpg" })];
  assert.deepEqual(find(items, "rot"), ["rot-quadrat.jpg"]);
});

test("Wortanfang nur beim Wort, das gerade getippt wird", () => {
  const r = item({ filename: "rotation.jpg" });
  assert.deepEqual(find([r], "rot"), ["rotation.jpg"], "während des Tippens");
  assert.deepEqual(find([r], "rot "), [], "fertig getippt");
  assert.deepEqual(find([r], "rot blau"), [], "nicht das letzte Wort");
});

test("Wortteile in Namen: Entwurf in Plakatentwurf, Plakate in Plakat-Entwurf", () => {
  const a = item({ filename: "Plakatentwurf_final.jpg" });
  const b = item({ filename: "Plakat-Entwurf.jpg" });
  assert.deepEqual(find([a, b], "entwurf "), ["Plakatentwurf_final.jpg", "Plakat-Entwurf.jpg"]);
  assert.deepEqual(find([a, b], "plakate "), ["Plakatentwurf_final.jpg", "Plakat-Entwurf.jpg"]);
});

test("Dateinamen werden an Großbuchstaben und Ziffern getrennt", () => {
  const a = item({ filename: "KonzertPlakat2024.jpg" });
  assert.deepEqual(find([a], "konzert 2024 "), ["KonzertPlakat2024.jpg"]);
});

test("Text im Bild: ganze Wörter, keine Wortfetzen", () => {
  const a = item({ filename: "a.jpg", text: "Konzept und Raster" });
  assert.deepEqual(find([a], "raster "), ["a.jpg"]);
  assert.deepEqual(find([a], "kon"), [], "drei Buchstaben reichen im Bildtext nicht");
});

test("Umlaute und ß: grün = gruen, weiß = weiss", () => {
  const g = item({ filename: "gruen.jpg" });
  const w = item({ filename: "w.jpg", colors: "white:0.60" });
  const green = item({ filename: "g.jpg", labels: "green:0.70" });
  assert.deepEqual(find([g, green], "grün "), ["gruen.jpg", "g.jpg"]);
  assert.deepEqual(find([w], "weiss "), ["w.jpg"]);
  assert.deepEqual(find([w], "weiß "), ["w.jpg"]);
});

test("Farbe zählt erst ab ihrem Anteil im Bild", () => {
  const red = item({ filename: "a.jpg", colors: "red:0.40 white:0.50" });
  const bit = item({ filename: "b.jpg", colors: "white:0.80 red:0.09" });
  assert.deepEqual(find([red, bit], "rote "), ["a.jpg"]);
});

test("jedes Wort muss passen, Füllwörter nicht", () => {
  const a = item({ filename: "plakat.jpg", labels: "circle:0.7" });
  const b = item({ filename: "plakat-2.jpg" });
  assert.deepEqual(find([a, b], "plakat mit kreis "), ["plakat.jpg"]);
});

test("Rangfolge: Name vor Bildtext, ganze Phrase im Namen vorn", () => {
  const inName = item({ filename: "raster.jpg" });
  const inText = item({ filename: "x.jpg", text: "raster" });
  assert.ok(S.score(inName, S.parse("raster ")) > S.score(inText, S.parse("raster ")));
  const phrase = item({ filename: "typo festival.jpg" });
  const apart = item({ filename: "festival.jpg", zone: "Typo" });
  assert.ok(S.score(phrase, S.parse("typo festival")) > S.score(apart, S.parse("typo festival")));
});

test("Bildtext, Zitat und Notiz sind durchsuchbar", () => {
  const a = item({ filename: "a.jpg", caption: "Plakat für das Stadttheater Basel" });
  const n = item({ filename: "Briefing.md", quote: "Monogramm aus zwei Kreisen" });
  assert.deepEqual(find([a, n], "basel "), ["a.jpg"]);
  assert.deepEqual(find([a, n], "kreise "), ["Briefing.md"]);
});

test("Menschen: frau, mann und mensch finden Personen, kopf und gesicht Gesichter", () => {
  const p = item({ filename: "p.jpg", labels: "people:0.93, face:0.88" });
  const x = item({ filename: "x.jpg", labels: "poster:0.9" });
  for (const q of ["frau ", "frauen ", "mann ", "mensch ", "kopf ", "köpfe ", "gesicht "]) assert.deepEqual(find([p, x], q), ["p.jpg"], q);
});
