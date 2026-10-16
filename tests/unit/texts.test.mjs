// Texte: jeder Schlüssel gibt es auf Deutsch und Englisch, in der App und in
// der Extension. Fehlt einer, zeigt die Oberfläche den nackten Schlüssel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

function appMessages() {
  // i18n.js als Skript laden, MESSAGES über ein Mini-Fenster abgreifen
  const src = read("app/src/i18n.js").replace("const MESSAGES =", "global.__MESSAGES = ");
  const win = {
    navigator: { language: "de" },
    localStorage: { getItem: () => null, setItem() {} },
    document: { documentElement: { classList: { toggle() {}, add() {}, remove() {} }, style: { setProperty() {} }, dataset: {} } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
  };
  win.window = win;
  try {
    vm.runInNewContext(src, win);
  } catch {
    // Teile nach MESSAGES greifen auf mehr DOM zu; die Texte sind dann schon da
  }
  assert.ok(win.__MESSAGES, "MESSAGES gefunden");
  return win.__MESSAGES;
}

test("App: Deutsch und Englisch haben dieselben Schlüssel", () => {
  const { de, en } = appMessages();
  const missingDe = Object.keys(en).filter((k) => !(k in de));
  const missingEn = Object.keys(de).filter((k) => !(k in en));
  assert.deepEqual(missingDe, [], "fehlt auf Deutsch");
  assert.deepEqual(missingEn, [], "fehlt auf Englisch");
});

test("Extension: _locales de und en haben dieselben Schlüssel", () => {
  const de = JSON.parse(read("extension/_locales/de/messages.json"));
  const en = JSON.parse(read("extension/_locales/en/messages.json"));
  assert.deepEqual(Object.keys(en).filter((k) => !(k in de)), []);
  assert.deepEqual(Object.keys(de).filter((k) => !(k in en)), []);
});

test("Extension: jeder t(\"…\")-Schlüssel steht in den Texten", () => {
  const en = JSON.parse(read("extension/_locales/en/messages.json"));
  const used = new Set();
  for (const f of ["background.js", "content.js", "ui.js", "popup.js", "dashboard.js", "shared.js"]) {
    for (const m of read("extension/" + f).matchAll(/\bt\("([A-Za-z0-9_]+)"\s*[,)]/g)) used.add(m[1]);
  }
  assert.deepEqual([...used].filter((k) => !(k in en)), []);
});

test("App: jeder t(\"…\")-Schlüssel steht in den Texten", () => {
  const { en } = appMessages();
  const used = new Set();
  for (const f of ["app.js", "dropbar.js", "palette.js", "viewer.js", "manual.js", "media.js", "reveal.js", "works.js"]) {
    for (const m of read("app/src/" + f).matchAll(/\bt\("([A-Za-z0-9_]+)"\s*[,)]/g)) used.add(m[1]);
  }
  assert.deepEqual([...used].filter((k) => !(k in en)), []);
});
