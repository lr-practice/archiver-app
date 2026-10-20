// Prüft, dass die Extension Bedienelemente der Seite nicht zum Ziehen kapert (3.29.5):
// Lautstärkeregler über einem Video, kleine Knöpfe, Links über einem Bild.
//   node tests/extension-drag.mjs
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ext = path.join(root, "extension");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const html = `<!doctype html><meta charset=utf-8><title>Test</title><body style="margin:0">
<div style="position:relative;width:800px;height:450px;background:url(data:image/png;base64,${png}) center/cover">
  <a id=lnk href="#geklickt" style="position:absolute;inset:0"><span id=lspan style="position:absolute;inset:0"></span></a>
</div>
<div style="position:relative;width:640px;height:360px">
  <video poster="data:image/png;base64,${png}" style="width:640px;height:360px"></video>
  <div id=track role=slider style="position:absolute;right:20px;top:60px;width:40px;height:180px">
    <div id=knob style="position:absolute;left:4px;top:80px;width:32px;height:32px"></div>
  </div>
  <div id=small style="position:absolute;left:20px;top:20px;width:30px;height:30px"></div>
</div>
<script>window.hits = { track: 0, lnk: 0 };
track.addEventListener("pointerdown", () => hits.track++);
lnk.addEventListener("pointerdown", () => hits.lnk++);</script></body>`;
const server = http.createServer((_, res) => res.end(html)).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "archiver-ext-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

async function press(page, sel) {
  const b = await page.locator(sel).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  const draggable = await page.evaluate((s) => document.querySelector(s).getAttribute("draggable"), sel);
  await page.mouse.up();
  return draggable;
}

try {
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent("serviceworker", { timeout: 10000 });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(800);

  await check("Lautstärkeregler über dem Video bleibt ein Regler", async () => {
    assert.equal(await press(page, "#knob"), null);
    assert.equal(await page.evaluate(() => hits.track), 1);
  });

  await check("kleiner Knopf über dem Video wird nicht ziehbar", async () => {
    assert.equal(await press(page, "#small"), null);
  });

  await check("Link über einem Bild bekommt Druck und Klick", async () => {
    await page.click("#lspan");
    assert.equal(await page.evaluate(() => hits.lnk), 1);
    assert.equal(await page.evaluate(() => location.hash), "#geklickt");
  });
} finally {
  await ctx.close();
  server.close();
}
if (failed) process.exit(1);
