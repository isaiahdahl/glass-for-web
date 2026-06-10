// .auto/tools/measure.mjs  (EXACT-PARITY phase)
//
// Compares OUR demo's WebKit render against AAVE's live WebKit render of the
// same DisplacementMapPlayground at the shared default lens state. Both use
// the same background image and the same default params, so the lens region
// is directly comparable. We crop a centered square around the lens in each,
// normalize to a common size, and diff with pixelmatch.
//
// Also keeps an internal Chromium-vs-WebKit guard so we don't fix Safari by
// breaking Chrome.
//
// Emits METRIC lines + saves PNGs to .auto/shots/.

import { chromium, webkit } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SHOTS = join(ROOT, ".auto", "shots");

const OUR_URL = process.env.GLASS_URL || "http://127.0.0.1:8132/index.html";
const AAVE_URL = process.env.AAVE_URL || "https://aave.com/design/building-glass-for-the-web";
const SKIP_AAVE = process.env.SKIP_AAVE === "1";

// We crop a FIXED device-pixel box centered on the lens in both renders.
// The lens is 140x120 CSS px in both our demo and Aave's at default params,
// and both are captured at deviceScaleFactor 2, so a fixed device-px crop
// makes the lens the same absolute size in each -> directly comparable.
// (Previously cropping "stage-height square" mismatched because the stages
// are different physical sizes.)
const CROP = 360;          // output diff size
const CROP_SRC_DEVICE = 360; // device px (=180 CSS px) cropped around center

if (existsSync(SHOTS)) {
  // keep aave_ref captures across runs to avoid refetching when offline; only
  // clear our transient diffs
  for (const f of ["our_webkit.png", "our_chromium.png", "diff_aave_webkit.png"]) {
    try { rmSync(join(SHOTS, f)); } catch {}
  }
} else {
  mkdirSync(SHOTS, { recursive: true });
}

// ---- helpers -------------------------------------------------------------
function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Crop a FIXED device-px square centered on the image, then resize to CROP.
// `side` arg is ignored now (kept for call-site compatibility) — we always
// use CROP_SRC_DEVICE so the lens is the same absolute size in both renders.
async function centeredLensCrop(pngBuffer, _sideIgnored) {
  const img = sharp(pngBuffer);
  const meta = await img.metadata();
  const s = Math.min(CROP_SRC_DEVICE, meta.width, meta.height);
  const left = Math.floor((meta.width - s) / 2);
  const top = Math.floor((meta.height - s) / 2);
  const out = await img
    .extract({ left, top, width: s, height: s })
    .resize(CROP, CROP, { fit: "fill" })
    .png()
    .toBuffer();
  return PNG.sync.read(out);
}

function diffPct(a, b) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const diff = new PNG({ width: w, height: h });
  const mism = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.12 });
  return { pct: (mism / (w * h)) * 100, diff, w, h };
}

// ---- capture our demo ----------------------------------------------------
async function captureOur(browserType, name, theme) {
  const b = await browserType.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  const t0 = Date.now();
  await page.goto(OUR_URL, { waitUntil: "load", timeout: 15000 });
  await page.waitForFunction("window.__ready === true", null, { timeout: 10000 });
  await page.evaluate((th) => { window.__glass.setTheme(th); window.__glass.set({ posX: 0.5, posY: 0.5 }); }, theme);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const readyMs = Date.now() - t0;
  const stage = await page.$("#stage");
  const box = await stage.boundingBox();
  const buf = await stage.screenshot({ type: "png" });
  await b.close();
  // side = full stage height in device px (deviceScaleFactor 2)
  const sideDevice = Math.round(box.height * 2);
  return { buf, sideDevice, readyMs, errors };
}

// ---- capture Aave's live playground -------------------------------------
async function captureAave(theme) {
  const b = await webkit.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(AAVE_URL, { waitUntil: "load", timeout: 30000 });
  // Match theme: Aave toggles a `.dark` class via a theme button. Default is
  // light. For dark we click the theme toggle in their sidebar.
  if (theme === "dark") {
    try {
      await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label*="dark" i], button[title*="dark" i]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(400);
    } catch {}
  }
  // Find the playground LEFT stage (refracted result), not the map panel.
  const handle = await page.evaluateHandle(() => {
    const cap = [...document.querySelectorAll("figcaption")]
      .find((f) => /On the left is the refracted result/i.test(f.textContent));
    const fig = cap.closest("figure");
    // playground: figure > div.playground > [stage(left), mapStage(right)]
    const pg = [...fig.querySelectorAll("div")].find(
      (d) => d.querySelector("[data-aave-glass-container]") && d.getBoundingClientRect().width > 300,
    );
    // pg is the playground row; its first element child is the left stage.
    const left = pg.firstElementChild;
    return left && left.getBoundingClientRect().width > 200 ? left : pg;
  });
  const el = handle.asElement();
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1600); // let the map bake + filter settle
  const box = await el.boundingBox();
  const buf = await el.screenshot({ type: "png" });
  await b.close();
  const sideDevice = Math.round(box.height * 2);
  return { buf, sideDevice };
}

async function main() {
  const allErrors = [];

  // LIGHT THEME ONLY — the clean exact-match signal. Aave's dark toggle
  // behaves differently and adds noise; we match light parity first.
  const ourWkLight = await captureOur(webkit, "our-webkit-light", "light");
  const ourCrLight = await captureOur(chromium, "our-chromium-light", "light");
  allErrors.push(...ourWkLight.errors, ...ourCrLight.errors);

  writeFileSync(join(SHOTS, "our_webkit.png"), ourWkLight.buf);
  writeFileSync(join(SHOTS, "our_chromium.png"), ourCrLight.buf);

  // Internal guard: our chromium vs our webkit (light).
  const ourWkCrop = await centeredLensCrop(ourWkLight.buf, ourWkLight.sideDevice);
  const ourCrCrop = await centeredLensCrop(ourCrLight.buf, ourCrLight.sideDevice);
  const internal = diffPct(ourCrCrop, ourWkCrop);
  console.log(`METRIC chromium_vs_webkit=${internal.pct.toFixed(4)}`);

  // Aave comparison (light only).
  let aaveDiffLight = NaN, aaveAvail = 0;
  if (!SKIP_AAVE) {
    try {
      const aaveLight = await captureAave("light");
      writeFileSync(join(SHOTS, "aave_webkit.png"), aaveLight.buf);
      const aaveCrop = await centeredLensCrop(aaveLight.buf, aaveLight.sideDevice);
      writeFileSync(join(SHOTS, "aave_webkit_crop.png"), PNG.sync.write(aaveCrop));
      writeFileSync(join(SHOTS, "our_webkit_crop.png"), PNG.sync.write(ourWkCrop));
      const d = diffPct(aaveCrop, ourWkCrop);
      aaveDiffLight = d.pct;
      writeFileSync(join(SHOTS, "diff_aave_webkit.png"), PNG.sync.write(d.diff));
      aaveAvail = 1;
      console.error(`[aave light] our-webkit vs aave-webkit = ${aaveDiffLight.toFixed(3)}%`);
    } catch (e) {
      console.error(`[aave light] failed: ${e.message}`);
    }
  }

  console.log(`METRIC aave_webkit_diff_pct=${isFinite(aaveDiffLight) ? aaveDiffLight.toFixed(4) : "NaN"}`);
  console.log(`METRIC aave_reference_available=${aaveAvail}`);
  console.log(`METRIC our_webkit_ready_ms=${ourWkLight.readyMs}`);

  if (allErrors.length) {
    console.error("--- runtime errors ---");
    for (const e of allErrors) console.error(e);
  }
  process.exit(0);
}

main().catch((e) => { console.error("measure failed:", e); process.exit(2); });
