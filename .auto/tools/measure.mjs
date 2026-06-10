// .auto/tools/measure.mjs
// Renders the demo in Chromium + WebKit at fixed lens states, screenshots the
// .stage element, and emits METRIC lines for autoresearch.
//
// Output: `METRIC name=value` lines + saves PNGs into .auto/shots/.

import { chromium, webkit } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SHOTS = join(ROOT, ".auto", "shots");

const URL_BASE = process.env.GLASS_URL || "http://127.0.0.1:8132/index.html";
const AAVE_URL = process.env.AAVE_URL || "https://aave.com/design/building-glass-for-the-web";
const SKIP_AAVE = process.env.SKIP_AAVE === "1";
const VIEWPORT = { width: 1100, height: 760 };

// Deterministic scenarios. Each picks a lens position + theme + state
// overrides. We pick high-scale/high-chroma settings to amplify the WebKit
// vs Chromium rendering differences (sharp piercing dashes vs soft refraction).
const SCENARIOS = [
  // Dark over a color blob, slightly stronger refraction — makes piercing
  // dashes inside the lens vs. proper refraction maximally distinguishable.
  { id: "dark_colorblob", theme: "dark", state: { posX: 0.35, posY: 0.45, scale: 0.14, chroma: 0.4 } },
  // Dark center with default refraction settings.
  { id: "dark_center",    theme: "dark", state: { posX: 0.5,  posY: 0.5,  scale: 0.10, chroma: 0.2 } },
  // Light center matches Aave's reference screenshot.
  { id: "light_center",   theme: "light", state: { posX: 0.5,  posY: 0.5,  scale: 0.10, chroma: 0.2 } },
];

// Ensure shots dir exists & is clean each run.
if (existsSync(SHOTS)) rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

async function setup(browserCtx, browserName) {
  const page = await browserCtx.newPage({ viewport: VIEWPORT });
  // Fail fast on JS errors so we notice if we broke the page.
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  const t0 = Date.now();
  await page.goto(URL_BASE, { waitUntil: "load", timeout: 15000 });
  // Wait until our bootstrap sets the global.
  await page.waitForFunction("window.__ready === true", null, { timeout: 10000 });
  const readyMs = Date.now() - t0;
  return { page, errors, readyMs };
}

async function captureScenario(page, browserName, scenario) {
  // Force theme + lens state via the playground's public API.
  await page.evaluate((s) => {
    window.__glass.setTheme(s.theme);
    window.__glass.set(s.state);
  }, scenario);
  // Give the filter pipeline two animation frames to settle.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const stage = await page.$("#stage");
  const t0 = Date.now();
  const buf = await stage.screenshot({ type: "png" });
  const renderMs = Date.now() - t0;
  const file = join(SHOTS, `${browserName}_${scenario.id}.png`);
  writeFileSync(file, buf);

  // Pull the lens bbox in stage-local CSS pixels. We crop diffs to this
  // exact region — small numerical differences inside the lens are the
  // signal we care about, but they get washed out across the full stage.
  const bbox = await page.evaluate(() => {
    const s = window.__glass.state;
    const rect = document.getElementById("stage").getBoundingClientRect();
    const fullW = 2 * s.width, fullH = 2 * s.height;
    const x = s.posX * rect.width - fullW / 2;
    const y = s.posY * rect.height - fullH / 2;
    return { x, y, w: fullW, h: fullH, stageW: rect.width, stageH: rect.height };
  });
  return { buf, file, renderMs, bbox };
}

// Decode PNG → ImageData-like object.
function decode(buf) {
  return PNG.sync.read(buf);
}

// Per-channel mean & stddev of luminance for a center-crop.
function lensContrastStat(png, fraction = 0.4) {
  const { width: w, height: h, data } = png;
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const halfW = Math.floor(w * fraction / 2);
  const halfH = Math.floor(h * fraction / 2);
  const x0 = cx - halfW, y0 = cy - halfH;
  const x1 = cx + halfW, y1 = cy + halfH;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum;
      sum2 += lum * lum;
      n++;
    }
  }
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  const stdev = Math.sqrt(Math.max(0, variance));
  return { mean, stdev, n };
}

function diffPct(pngA, pngB) {
  // Both expected same size since same selector + same viewport.
  const w = Math.min(pngA.width, pngB.width);
  const h = Math.min(pngA.height, pngB.height);
  const diff = new PNG({ width: w, height: h });
  // Crop both to (w,h) by reusing their buffers when they already match.
  let dataA = pngA.data, dataB = pngB.data;
  if (pngA.width !== w || pngA.height !== h) {
    dataA = cropTo(pngA, w, h);
  }
  if (pngB.width !== w || pngB.height !== h) {
    dataB = cropTo(pngB, w, h);
  }
  const mismatched = pixelmatch(dataA, dataB, diff.data, w, h, { threshold: 0.1 });
  const pct = (mismatched / (w * h)) * 100;
  return { pct, diff, w, h };
}

// Crop an arbitrary axis-aligned rectangle, clamped to image bounds.
function cropRect(png, x0, y0, w, h) {
  x0 = Math.max(0, Math.min(png.width - 1, x0));
  y0 = Math.max(0, Math.min(png.height - 1, y0));
  w = Math.max(1, Math.min(png.width - x0, w));
  h = Math.max(1, Math.min(png.height - y0, h));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y + y0) * png.width + (x + x0)) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

function cropTo(png, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * png.width + x) * 4;
      const di = (y * w + x) * 4;
      out[di] = png.data[si];
      out[di + 1] = png.data[si + 1];
      out[di + 2] = png.data[si + 2];
      out[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const errors = [];
  // Launch both browsers in parallel.
  const [chromiumCtx, webkitCtx] = await Promise.all([
    chromium.launch().then((b) => b.newContext()),
    webkit.launch().then((b) => b.newContext()),
  ]);

  const cr = await setup(chromiumCtx, "chromium");
  const wk = await setup(webkitCtx, "webkit");
  errors.push(...cr.errors.map((e) => `chromium ${e}`));
  errors.push(...wk.errors.map((e) => `webkit ${e}`));

  let pixelDiffPcts = [];
  let lensDiffPcts = [];
  let webkitContrasts = [];
  let chromiumContrasts = [];
  let webkitRenderMs = [];
  let chromiumRenderMs = [];

  for (const scenario of SCENARIOS) {
    const c = await captureScenario(cr.page, "chromium", scenario);
    const w = await captureScenario(wk.page, "webkit", scenario);
    chromiumRenderMs.push(c.renderMs);
    webkitRenderMs.push(w.renderMs);

    const pngC = decode(c.buf);
    const pngW = decode(w.buf);
    const cContrast = lensContrastStat(pngC).stdev;
    const wContrast = lensContrastStat(pngW).stdev;
    chromiumContrasts.push(cContrast);
    webkitContrasts.push(wContrast);

    const { pct, diff, w: dw, h: dh } = diffPct(pngC, pngW);
    pixelDiffPcts.push(pct);

    // Lens-region diff: crop to the actual lens bbox (from window.__glass
    // state), with a small padding margin to catch edge-refraction effects.
    // PNG resolution may be devicePixelRatio scaled vs CSS pixels, so we
    // scale the bbox to match.
    const sx = pngC.width / c.bbox.stageW;
    const sy = pngC.height / c.bbox.stageH;
    const pad = 8; // CSS px padding to include the soft outer falloff.
    const lensCropC = cropRect(
      pngC,
      Math.floor((c.bbox.x - pad) * sx),
      Math.floor((c.bbox.y - pad) * sy),
      Math.ceil((c.bbox.w + 2 * pad) * sx),
      Math.ceil((c.bbox.h + 2 * pad) * sy),
    );
    const lensCropW = cropRect(
      pngW,
      Math.floor((w.bbox.x - pad) * sx),
      Math.floor((w.bbox.y - pad) * sy),
      Math.ceil((w.bbox.w + 2 * pad) * sx),
      Math.ceil((w.bbox.h + 2 * pad) * sy),
    );
    const lensDiff = diffPct(lensCropC, lensCropW);
    lensDiffPcts.push(lensDiff.pct);
    // Save lens crops side by side for visual review.
    writeFileSync(join(SHOTS, `lens_chromium_${scenario.id}.png`), PNG.sync.write(lensCropC));
    writeFileSync(join(SHOTS, `lens_webkit_${scenario.id}.png`), PNG.sync.write(lensCropW));

    // Save diff image.
    const diffPng = new PNG({ width: dw, height: dh });
    diffPng.data = diff.data;
    writeFileSync(join(SHOTS, `diff_${scenario.id}.png`), PNG.sync.write(diffPng));

    console.error(`[${scenario.id}] diff=${pct.toFixed(3)}% lensDiff=${lensDiff.pct.toFixed(3)}% chromContrast=${cContrast.toFixed(2)} webkitContrast=${wContrast.toFixed(2)} cms=${c.renderMs} wms=${w.renderMs}`);
    // Also emit per-scenario diagnostics as METRIC lines for the dashboard.
    console.log(`METRIC scn_${scenario.id}_diff=${pct.toFixed(4)}`);
    console.log(`METRIC scn_${scenario.id}_lens_diff=${lensDiff.pct.toFixed(4)}`);
    console.log(`METRIC scn_${scenario.id}_webkit_contrast=${wContrast.toFixed(3)}`);
    console.log(`METRIC scn_${scenario.id}_chromium_contrast=${cContrast.toFixed(3)}`);
  }

  // Aggregate metrics. Primary is the median lens-region diff — that's where
  // the WebKit failure shows up most visibly.
  const medDiff = median(pixelDiffPcts);
  const medLensDiff = median(lensDiffPcts);
  const medWContrast = median(webkitContrasts);
  const medCContrast = median(chromiumContrasts);

  console.log(`METRIC pixel_diff_pct=${medLensDiff.toFixed(4)}`);
  console.log(`METRIC stage_diff_pct=${medDiff.toFixed(4)}`);
  console.log(`METRIC webkit_lens_contrast=${medWContrast.toFixed(3)}`);
  console.log(`METRIC chromium_lens_contrast=${medCContrast.toFixed(3)}`);
  console.log(`METRIC webkit_render_ms=${median(webkitRenderMs)}`);
  console.log(`METRIC chromium_render_ms=${median(chromiumRenderMs)}`);

  // ---- Aave reference: screenshot their site's glass component in both
  // browsers, diff them against each other. This is a sanity check (Aave
  // achieves true parity, so diff should be near zero) and a reference set
  // of PNGs we can stare at while iterating. Network-bound; skip if it
  // fails (e.g. offline) or SKIP_AAVE=1.
  let aaveDiff = NaN, aaveAvail = 0;
  if (!SKIP_AAVE) {
    try {
      const aaveBufs = {};
      for (const [name, page] of [["chromium", cr.page], ["webkit", wk.page]]) {
        await page.goto(AAVE_URL, { waitUntil: "load", timeout: 30000 });
        // Wait until at least one glass container is in the DOM AND its inner
        // filter image has resolved (Aave's filter is async).
        await page.waitForSelector("[data-aave-glass-container]", { timeout: 15000 });
        await page.waitForFunction(
          () => {
            const c = document.querySelector("[data-aave-glass-container]");
            if (!c) return false;
            const img = c.querySelector("feImage");
            const href = img?.getAttribute("href");
            return !!href && href.length > 100; // map data URL present
          },
          null,
          { timeout: 15000 }
        );
        await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
        const el = await page.$("[data-aave-glass-container]");
        const buf = await el.screenshot({ type: "png" });
        writeFileSync(join(SHOTS, `aave_${name}.png`), buf);
        aaveBufs[name] = buf;
      }
      const a = decode(aaveBufs.chromium);
      const b = decode(aaveBufs.webkit);
      const r = diffPct(a, b);
      const diffPng = new PNG({ width: r.w, height: r.h });
      diffPng.data = r.diff.data;
      writeFileSync(join(SHOTS, `aave_diff.png`), PNG.sync.write(diffPng));
      aaveDiff = r.pct;
      aaveAvail = 1;
      console.error(`[aave] cross_browser_diff=${aaveDiff.toFixed(3)}%`);
    } catch (e) {
      console.error(`[aave] capture failed: ${e.message}`);
    }
  }
  console.log(`METRIC aave_cross_browser_diff=${isFinite(aaveDiff) ? aaveDiff.toFixed(4) : "NaN"}`);
  console.log(`METRIC aave_reference_available=${aaveAvail}`);

  if (errors.length) {
    console.error("--- runtime errors ---");
    for (const e of errors) console.error(e);
  }

  await Promise.all([chromiumCtx.close(), webkitCtx.close()]);
  process.exit(0);
}

main().catch((e) => {
  console.error("measure failed:", e);
  process.exit(2);
});
