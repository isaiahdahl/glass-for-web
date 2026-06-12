// app.js — Aave-style SVG-filter glass path.
//
// The displacement-map baker is still the reverse-engineered Aave algorithm;
// the visible left panel now uses the live-DOM SVG filter architecture:
//   feImage(map) → feDisplacementMap(SourceGraphic) → channel recombine
// plus a specular/color-pickup extension layered from the map's blue channel.
import { generateDisplacementMap } from "./glass.js";

const MAP_SIZE = 512;
const THEME_KEY = "glass-web-theme";
const FILTER_BASE_ID = "glassSvgFilter";

// EXACT Aave DisplacementMapPlayground sliders (component `S` in their bundle
// 25ef42f3c325a091.js). Order, ranges, steps and defaults all mirror theirs.
// Color pickup / frost / specular sliders were ours and are removed for the
// exact-parity phase; they can be layered back on later.
const SLIDERS = [
  { key: "width", label: "Width", min: 20, max: 120, step: 1, dp: 0 },
  { key: "height", label: "Height", min: 20, max: 80, step: 1, dp: 0 },
  { key: "borderRadius", label: "BorderRadius", min: 0, max: 64, step: 1, dp: 0 },
  { key: "scale", label: "Scale", min: 0, max: 0.2, step: 0.001, dp: 3 },
  { key: "depth", label: "Depth", min: 5, max: 60, step: 1, dp: 0 },
  { key: "curvature", label: "Curvature", min: 0, max: 80, step: 1, dp: 0 },
  { key: "splay", label: "Splay", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "chroma", label: "Chroma", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "blur", label: "Blur", min: 0, max: 30, step: 0.5, dp: 1 },
  { key: "edgeHighlight", label: "Edge Highlight", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "rimPickup", label: "Rim Pickup", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "elementShadow", label: "Element Shadow", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "pickupDistance", label: "Pickup Distance", min: 0, max: 80, step: 1, dp: 0 },
  { key: "specularAngle", label: "Specular Angle", min: 0, max: 180, step: 1, dp: 0 },
];

const state = {
  width: 70,
  height: 60,
  borderRadius: 28,
  scale: 0.1,
  depth: 10,
  curvature: 40,
  splay: 1,
  chroma: 0.2,
  blur: 8,
  edgeHighlight: 0.5,
  rimPickup: 0.35,
  elementShadow: 0.35,
  pickupDistance: 22,
  specularAngle: 90,
  posX: 0.5,
  posY: 0.5,
};

let darkMode = false;
let mapUrl = "";
let maskUrl = "";
let stageRect = { w: 0, h: 0 };

const ua = navigator.userAgent;
const isSafariLike = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox|Android/i.test(ua);

const stageEl = document.getElementById("stage");
const sceneEl = document.getElementById("scene");
const lensLayerEl = document.getElementById("lensLayer");
const lensShadowEl = document.getElementById("lensShadow");
const lensOutlineEl = document.getElementById("lensOutline");
const rimCanvasEl = document.getElementById("rimCanvas");
const rimPickupCanvasEl = document.getElementById("rimPickupCanvas");
const lensContentEl = document.getElementById("lensContent");
const mapStageEl = document.getElementById("mapStage");
const mapImg = document.getElementById("mapBlob");
const controlsEl = document.getElementById("controls");

const filterEl = document.getElementById(FILTER_BASE_ID);
const feMap = document.getElementById("feMap");
const feRoundMask = document.getElementById("feRoundMask");
const feSourceBlur = document.getElementById("feSourceBlur");
const feFinalBlur = document.getElementById("feFinalBlur");
const feDispR = document.getElementById("feDispR");
const feDispG = document.getElementById("feDispG");
const feDispB = document.getElementById("feDispB");

const mapCanvas = document.createElement("canvas");
const maskCanvas = document.createElement("canvas");
const sceneSampleCanvas = document.createElement("canvas");
const sceneSampleCtx = sceneSampleCanvas.getContext("2d", { willReadFrequently: true });
let sceneSampleData = null;
let sceneSampleW = 0;
let sceneSampleH = 0;
let sceneSampleTheme = null;

const sceneImages = {
  light: {
    base: loadSceneImage("./assets/demo-bg.png"),
    color: loadSceneImage("./assets/color-bg-light.png"),
  },
  dark: {
    base: loadSceneImage("./assets/demo-bg-dark.png"),
    color: loadSceneImage("./assets/color-bg-dark.png"),
  },
};

function loadSceneImage(src) {
  const img = new Image();
  img.onload = () => {
    updateSceneSample(true);
    drawRimLayer(2 * state.width, 2 * state.height);
  };
  img.src = src;
  return img;
}

function setHref(el, href) {
  el.setAttribute("href", href);
  el.setAttributeNS("http://www.w3.org/1999/xlink", "href", href);
}

let filterApplied = false;
let filterVersion = 0;
function commitFilterUpdate() {
  // Source-derived Aave path: mutate the active filter primitives, then give
  // Safari a fresh id immediately. No cloning/double-buffering and no rAF
  // delay; their bundle directly versions the active filter element.
  if (isSafariLike) {
    filterVersion += 1;
    const id = `${FILTER_BASE_ID}-${filterVersion}`;
    filterEl.id = id;
    const url = `url(#${id})`;
    sceneEl.style.filter = url;
    sceneEl.style.webkitFilter = url;
    filterApplied = true;
    return;
  }
  if (filterApplied) return;
  const url = `url(#${FILTER_BASE_ID})`;
  sceneEl.style.filter = url;
  sceneEl.style.webkitFilter = url;
  filterApplied = true;
}

// ── live DOM scene ───────────────────────────────────────────────────────
function buildScene(container) {
  // Keep the filtered scene's DOM geometry identical to the exact-parity base.
  // Color blobs/chips are painted as CSS background image layers instead; DOM
  // children can change WebKit's SVG filter source bounding box and offset the
  // displacement map from the visible lens.
  container.replaceChildren();
}

function roundedRectSdf(px, py, hw, hh, r) {
  const x = Math.abs(px);
  const y = Math.abs(py);
  const mx = x - hw + r;
  const my = y - hh + r;
  const ox = Math.max(mx, 0);
  const oy = Math.max(my, 0);
  return (
    (ox || oy ? Math.sqrt(ox * ox + oy * oy) : 0) +
    Math.min(Math.max(mx, my), 0) -
    r
  );
}

function roundedRectNormal(px, py, hw, hh, r) {
  const sx = px < 0 ? -1 : 1;
  const sy = py < 0 ? -1 : 1;
  const ax = Math.abs(px);
  const ay = Math.abs(py);
  const mx = ax - hw + r;
  const my = ay - hh + r;
  const ox = Math.max(mx, 0);
  const oy = Math.max(my, 0);
  if (ox || oy) {
    const len = Math.max(0.0001, Math.sqrt(ox * ox + oy * oy));
    return { x: sx * ox / len, y: sy * oy / len };
  }
  if (mx > my) return { x: sx, y: 0 };
  return { x: 0, y: sy };
}

function generateRoundMask(canvas) {
  const size = MAP_SIZE;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const hw = state.width;
  const hh = state.height;
  const r = Math.min(state.borderRadius, Math.min(hw, hh));
  const pxW = (2 * hw) / size;
  const pxH = (2 * hh) / size;
  const aa = 1.5 * Math.max(pxW, pxH);
  for (let row = 0; row < size; row++) {
    const y = Math.abs((row + 0.5) * pxH - hh);
    const my = y - hh + r;
    for (let col = 0; col < size; col++) {
      const x = (col + 0.5) * pxW - hw;
      const sdf = roundedRectSdf(x, y, hw, hh, r);
      const cov = Math.max(0, Math.min(1, 0.5 - sdf / aa));
      const v = Math.max(0, Math.min(255, (cov * 255 + 0.5) | 0));
      const i = (row * size + col) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ── displacement map regeneration ────────────────────────────────────────
function regenMap() {
  generateDisplacementMap(mapCanvas, {
    canvasSize: MAP_SIZE,
    lensHalfWidth: state.width,
    lensHalfHeight: state.height,
    borderRadius: state.borderRadius,
    depth: state.depth,
    sdfBoundary: true,
    edgeFalloff: true,
    specularRotation: state.specularAngle,
    // Specular/bevel is rendered from a separate paired rim map below. Keep the
    // displacement map focused on refraction only.
    glowStrength: 0,
    glowSpread: 1,
    glowExponent: 1.5,
    edgeStrength: 0,
    edgeWidth: 1.1,
    edgeExponent: 1.5,
    domeDepth: state.curvature,
    splayAmount: state.splay,
  });

  generateRoundMask(maskCanvas);

  mapUrl = mapCanvas.toDataURL("image/png");
  maskUrl = maskCanvas.toDataURL("image/png");
  mapImg.src = mapUrl;
  applyDeferredHref(feMap, mapUrl, "map");
  applyDeferredHref(feRoundMask, maskUrl, "mask");
}

// Aave's flicker fix (reverse-engineered): the synchronous filter-id bump that
// forces Safari to re-render must run against the PREVIOUS, already-decoded
// feImage. If we set the new map href and bump the id in the same frame, Safari
// rebuilds the filter against a not-yet-decoded image -> a flicker frame with
// no/!wrong refraction. So on Safari we defer the href swap to a separate
// macrotask (coalesced), decoupled from the id bump. The new map then decodes
// in place one frame later, which is imperceptible during a drag.
const deferredHrefs = {
  map: { hasHref: false, pendingUrl: null, timer: 0 },
  mask: { hasHref: false, pendingUrl: null, timer: 0 },
};
function applyDeferredHref(el, url, key) {
  const slot = deferredHrefs[key];
  if (!isSafariLike || !slot.hasHref) {
    // First image (or Chromium, which re-renders attribute changes natively):
    // set synchronously so there's never an undisplaced/unmasked first frame.
    setHref(el, url);
    slot.hasHref = true;
    return;
  }
  slot.pendingUrl = url;
  if (!slot.timer) {
    slot.timer = setTimeout(() => {
      slot.timer = 0;
      if (slot.pendingUrl == null) return;
      setHref(el, slot.pendingUrl);
      slot.pendingUrl = null;
    }, 0);
  }
}

function drawCover(ctx, img, w, h) {
  if (!img?.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function updateSceneSample(force = false) {
  const w = Math.max(1, Math.round(stageRect.w));
  const h = Math.max(1, Math.round(stageRect.h));
  const theme = darkMode ? "dark" : "light";
  if (!force && sceneSampleData && sceneSampleW === w && sceneSampleH === h && sceneSampleTheme === theme) {
    return;
  }
  if (!sceneSampleCtx) return;
  sceneSampleW = w;
  sceneSampleH = h;
  sceneSampleTheme = theme;
  sceneSampleCanvas.width = w;
  sceneSampleCanvas.height = h;
  sceneSampleCtx.clearRect(0, 0, w, h);
  // CSS paints the first background-image layer on top. Our CSS order is
  // color-image, scene-image, so draw base first then colour layer.
  drawCover(sceneSampleCtx, sceneImages[theme].base, w, h);
  drawCover(sceneSampleCtx, sceneImages[theme].color, w, h);
  try {
    sceneSampleData = sceneSampleCtx.getImageData(0, 0, w, h).data;
  } catch (_) {
    sceneSampleData = null;
  }
}

function sampleSceneColor(x, y) {
  if (!sceneSampleData || sceneSampleW <= 0 || sceneSampleH <= 0) {
    return darkMode ? [28, 24, 44] : [245, 242, 255];
  }
  const ix = Math.max(0, Math.min(sceneSampleW - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(sceneSampleH - 1, Math.round(y)));
  const i = (iy * sceneSampleW + ix) * 4;
  return [sceneSampleData[i], sceneSampleData[i + 1], sceneSampleData[i + 2]];
}

function saturatePickupColor([r, g, b]) {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = darkMode ? 2.35 : 2.7;
  const lift = darkMode ? 1.42 : 1.55;
  r = lum + (r - lum) * sat;
  g = lum + (g - lum) * sat;
  b = lum + (b - lum) * sat;
  return [
    Math.max(0, Math.min(255, r * lift)),
    Math.max(0, Math.min(255, g * lift)),
    Math.max(0, Math.min(255, b * lift)),
  ];
}

function sampleRimPickup(stageX, stageY, nx, ny) {
  const pickup = Math.max(0, Math.min(1, state.rimPickup));
  if (pickup <= 0) return [255, 255, 255];
  const d = state.pickupDistance;
  const tx = -ny;
  const ty = nx;
  // Bright blurred environmental sample. We average a small patch outside the
  // rim (several distances along the normal, several offsets along the tangent)
  // so a nearby coloured element still influences the rim even if it is ~10px
  // away instead of exactly under the sample point.
  const distances = [Math.max(0, d - 8), d, d + 10, d + 22];
  const offsets = [-18, -9, 0, 9, 18];
  let r = 0, g = 0, b = 0, weightSum = 0;
  let best = [255, 255, 255];
  let bestScore = -1;
  for (const dist of distances) {
    const dw = dist === d ? 1.4 : 1;
    for (const off of offsets) {
      const ow = off === 0 ? 1.25 : off === -9 || off === 9 ? 1 : 0.65;
      const weight = dw * ow;
      const c = sampleSceneColor(stageX + nx * dist + tx * off, stageY + ny * dist + ty * off);
      r += c[0] * weight; g += c[1] * weight; b += c[2] * weight;
      weightSum += weight;

      // Reflections tend to catch the brightest/saturated nearby object, not a
      // flat average of object + pale background. Bias toward the most colourful
      // sample in the patch, which is what makes the cyan capsule influence the
      // rim even when surrounded by light background.
      const hi = Math.max(c[0], c[1], c[2]);
      const lo = Math.min(c[0], c[1], c[2]);
      const chroma = hi - lo;
      const score = chroma * 1.8 + hi * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  r /= weightSum; g /= weightSum; b /= weightSum;
  const bias = darkMode ? 0.55 : 0.78;
  return [
    r * (1 - bias) + best[0] * bias,
    g * (1 - bias) + best[1] * bias,
    b * (1 - bias) + best[2] * bias,
  ];
}

// ── SVG filter parameter updates ─────────────────────────────────────────
function drawRimLayer(fullW, fullH) {
  updateSceneSample();
  const strength = Math.max(0, Math.min(1, state.edgeHighlight));
  const pickup = Math.max(0, Math.min(1, state.rimPickup));
  const pad = Math.max(6, Math.ceil(state.pickupDistance * 0.08));
  const cssW = Math.ceil(fullW + 2 * pad);
  const cssH = Math.ceil(fullH + 2 * pad);
  for (const canvas of [rimCanvasEl, rimPickupCanvasEl]) {
    canvas.style.left = `${-pad}px`;
    canvas.style.top = `${-pad}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  for (const canvas of [rimCanvasEl, rimPickupCanvasEl]) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  const ctx = rimCanvasEl.getContext("2d");
  const pickupCtx = rimPickupCanvasEl.getContext("2d");
  if (!ctx || !pickupCtx) return;
  ctx.clearRect(0, 0, w, h);
  pickupCtx.clearRect(0, 0, w, h);
  if (strength <= 0) return;

  const img = ctx.createImageData(w, h);
  const data = img.data;
  const pickupImg = pickupCtx.createImageData(w, h);
  const pickupData = pickupImg.data;
  const hw = fullW / 2;
  const hh = fullH / 2;
  const r = Math.min(state.borderRadius, Math.min(hw, hh));
  const angle = (state.specularAngle * Math.PI) / 180;
  const lx = -Math.cos(angle);
  const ly = -Math.sin(angle);
  const px = -ly;
  const py = lx;

  // Outside dark bevel, inside white glint. Both are deliberately very narrow
  // and live in this top canvas layer, so changing the spectacle never mutates
  // SVG filter feImages and should not reintroduce Safari filter flicker.
  const darkCenter = 0.45; // positive SDF = outside the glass body
  const darkWidth = darkMode ? 1.0 : 0.82;
  const whiteCenter = -0.22; // negative SDF = just inside the body
  const whiteWidth = 0.55;
  const whiteBoost = darkMode ? 0.95 : 2.65;
  const darkBoost = darkMode ? 0.28 : 0.22;

  const cx = state.posX * Math.max(1, stageRect.w);
  const cy = state.posY * Math.max(1, stageRect.h);

  for (let row = 0; row < h; row++) {
    const y = (row + 0.5) / dpr - pad - hh;
    for (let col = 0; col < w; col++) {
      const x = (col + 0.5) / dpr - pad - hw;
      const sdf = roundedRectSdf(x, y, hw, hh, r);
      if (sdf < -2 || sdf > 2.4) continue;
      const n = roundedRectNormal(x, y, hw, hh, r);
      const alongLight = Math.abs(n.x * lx + n.y * ly);
      const alongPerp = Math.abs(n.x * px + n.y * py);
      const whiteBand = Math.max(0, 1 - Math.abs(sdf - whiteCenter) / whiteWidth);
      const darkBand = Math.max(0, 1 - Math.abs(sdf - darkCenter) / darkWidth);
      const whiteA = Math.min(1, strength * whiteBoost * whiteBand * Math.pow(alongLight, 1.18));
      const darkLobe = Math.pow(alongPerp, darkMode ? 1.15 : 2.75);
      const darkPeak = darkMode ? 1 : 1 + 1.6 * Math.pow(alongPerp, 8);
      const darkA = Math.min(1, strength * darkBoost * darkPeak * darkBand * darkLobe);
      if (whiteA <= 0 && darkA <= 0) continue;

      // Base bevel stays neutral and sharp.
      const whiteRgb = [255, 255, 255];
      const darkRgb = darkMode ? [12, 11, 18] : [54, 50, 76];

      // Composite dark first, then white, into a single source-over neutral rim.
      const aDark = darkA;
      const aWhite = whiteA * (1 - aDark);
      const a = aDark + aWhite;
      if (a <= 0) continue;
      const i = (row * w + col) * 4;
      data[i] = Math.max(0, Math.min(255, ((darkRgb[0] * aDark + whiteRgb[0] * aWhite) / a + 0.5) | 0));
      data[i + 1] = Math.max(0, Math.min(255, ((darkRgb[1] * aDark + whiteRgb[1] * aWhite) / a + 0.5) | 0));
      data[i + 2] = Math.max(0, Math.min(255, ((darkRgb[2] * aDark + whiteRgb[2] * aWhite) / a + 0.5) | 0));
      data[i + 3] = Math.max(0, Math.min(255, (a * 255 + 0.5) | 0));

      // Separate luminous colour-pickup layer above the neutral bevel. This is
      // intentionally brighter and more saturated, then CSS-screened over the
      // glass so nearby cyan/orange/green blooms read like environmental pickup.
      if (pickup > 0) {
        const sample = saturatePickupColor(sampleRimPickup(cx + x, cy + y, n.x, n.y));
        // Colour pickup is its own luminous INNER layer. Do not paint it over
        // the outer dark bevel; otherwise max pickup washes out the shadow edge
        // that gives the glass thickness.
        const innerPickupCenter = -0.55;
        const innerPickupWidth = 1.15;
        const innerPickupBand = Math.max(0, 1 - Math.abs(sdf - innerPickupCenter) / innerPickupWidth);
        const pickupBand = innerPickupBand * Math.max(0.25, Math.pow(alongLight, 0.75));
        const pickupA = Math.min(1, strength * pickup * (darkMode ? 0.85 : 0.78) * pickupBand);
        if (pickupA > 0) {
          pickupData[i] = Math.max(0, Math.min(255, (sample[0] + 0.5) | 0));
          pickupData[i + 1] = Math.max(0, Math.min(255, (sample[1] + 0.5) | 0));
          pickupData[i + 2] = Math.max(0, Math.min(255, (sample[2] + 0.5) | 0));
          pickupData[i + 3] = Math.max(0, Math.min(255, (pickupA * 255 + 0.5) | 0));
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  pickupCtx.putImageData(pickupImg, 0, 0);
}

function updateFilterPrimitives(fullW, fullH) {
  // Safari is much more reliable when the filter region is the lens bbox and
  // the displacement map fills that bbox. The underlying source is aligned by
  // translating the DOM content inside the moving lens layer.
  // Filter is on the full-stage scene. feImage covers the lens sub-region in
  // the stage's objectBoundingBox fractions; the map's neutral grey fills
  // the rest (zero displacement outside the lens).
  const sw = Math.max(1, stageRect.w), sh = Math.max(1, stageRect.h);
  const x = state.posX * sw - fullW / 2;
  const y = state.posY * sh - fullH / 2;
  const mapX = String(x / sw);
  const mapY = String(y / sh);
  const mapW = String(fullW / sw);
  const mapH = String(fullH / sh);
  feMap.setAttribute("x", mapX);
  feMap.setAttribute("y", mapY);
  feMap.setAttribute("width", mapW);
  feMap.setAttribute("height", mapH);
  feRoundMask.setAttribute("x", mapX);
  feRoundMask.setAttribute("y", mapY);
  feRoundMask.setAttribute("width", mapW);
  feRoundMask.setAttribute("height", mapH);

  // Clip the lens-producing primitives to the lens rect (Aave's `data-lens`
  // subregion). This is what makes the hole-and-fill work: the displacement
  // output (lensResult) is only written inside the lens rect, so it's
  // transparent elsewhere and `lensResult over holedSG` lets the sharp scene
  // show through outside the lens. The subregion clips the OUTPUT only —
  // displacement can still SAMPLE neighbouring content for edge refraction.
  const lensRegion = (el) => {
    if (!el) return;
    el.setAttribute("x", String(x / sw));
    el.setAttribute("y", String(y / sh));
    el.setAttribute("width", String(fullW / sw));
    el.setAttribute("height", String(fullH / sh));
  };
  lensRegion(feDispR);
  lensRegion(feDispG);
  lensRegion(feDispB);
  lensRegion(feFinalBlur);

  // Displacement scale in the stage's objectBoundingBox units — exactly
  // matching Aave, whose filter also spans the full stage. scale=0.1 then
  // yields ~0.1*stageWidth px of displacement, giving the strong edge
  // refraction at the lens rim.
  const scale = state.scale;
  feDispR.setAttribute("scale", String(scale * (1 + 0.2 * state.chroma)));
  feDispG.setAttribute("scale", String(scale * (1 + 0.1 * state.chroma)));
  feDispB.setAttribute("scale", String(scale));

  // Blur stdDeviations are in the stage objectBoundingBox now (filter spans
  // the stage), so divide pixel amounts by the stage dimensions.
  feSourceBlur.setAttribute(
    "stdDeviation",
    `${state.blur / sw} ${state.blur / sh}`,
  );
  // Safari-only final-output blur. Aave's own WebKit render is slightly soft
  // (their compositor applies less sub-pixel AA, and the production build has
  // the same characteristic), so this final smoothing actually IMPROVES
  // parity with Aave's live render, not just internal Chrome/WebKit parity.
  // Removing it regresses the Aave diff (0.55% -> 0.94%).
  // Safari-only final-output blur, tuned to Aave's live WebKit render. Their
  // refracted interior is slightly softer than a raw feDisplacementMap on
  // WebKit; a sweep against their page minimised the diff at ~0.75px.
  // No artificial final blur. An earlier Safari-only smoothing pass was tuned
  // against a broken (non-refracting) reference and made the refracted dots
  // softer/larger than Aave's on real Safari. With the correct architecture
  // the raw displacement output already matches Aave's dot sharpness, so we
  // keep it crisp (the pixelmatch metric mildly prefers blur only because it
  // hides sub-pixel AA noise, not because it's more faithful).
  const finalBlurPx = 0;
  if (feFinalBlur) {
    feFinalBlur.setAttribute(
      "stdDeviation",
      `${finalBlurPx / sw} ${finalBlurPx / sh}`,
    );
  }

}

function render() {
  const fullW = 2 * state.width;
  const fullH = 2 * state.height;
  const x = state.posX * stageRect.w - fullW / 2;
  const y = state.posY * stageRect.h - fullH / 2;

  // The visible lens outline sits at the lens rect (x,y, fullW x fullH).
  lensShadowEl.style.width = `${fullW}px`;
  lensShadowEl.style.height = `${fullH}px`;
  lensShadowEl.style.borderRadius = `${state.borderRadius}px`;
  lensShadowEl.style.transform = `translate(${x}px, ${y}px)`;
  lensOutlineEl.style.width = `${fullW}px`;
  lensOutlineEl.style.height = `${fullH}px`;
  lensOutlineEl.style.borderRadius = `${state.borderRadius}px`;
  lensOutlineEl.style.transform = `translate(${x}px, ${y}px)`;
  const shadow = Math.max(0, Math.min(1, state.elementShadow));
  if (shadow > 0) {
    const opacity = darkMode ? 0.34 * shadow : 0.42 * shadow;
    const blur = (darkMode ? 20 : 26) * shadow;
    const spread = (darkMode ? -4 : -2) * shadow;
    const yOff = (darkMode ? 9 : 10) * shadow;
    lensShadowEl.style.boxShadow = `0 ${yOff.toFixed(1)}px ${blur.toFixed(1)}px ${spread.toFixed(1)}px rgba(0,0,0,${opacity.toFixed(3)})`;
  } else {
    lensShadowEl.style.boxShadow = "none";
  }
  lensOutlineEl.style.filter = "none";
  // Blank slate shell: no CSS border/sheen/streak. The edge spectacle is a
  // separate top canvas layer: dark outside the body, white just inside it.
  drawRimLayer(fullW, fullH);

  // The separate lens layer is unused; Aave's playground applies the SVG
  // filter to the full content scene and clips the output with lens-region
  // primitives inside the filter graph.
  lensLayerEl.style.display = "none";
  lensLayerEl.style.filter = "";
  lensLayerEl.style.webkitFilter = "";
  lensLayerEl.style.clipPath = "";
  lensLayerEl.style.webkitClipPath = "";

  updateFilterPrimitives(fullW, fullH);
  commitFilterUpdate();

  const mr = mapStageEl.getBoundingClientRect();
  mapImg.style.width = `${fullW}px`;
  mapImg.style.height = `${fullH}px`;
  mapImg.style.left = `${state.posX * mr.width - fullW / 2}px`;
  mapImg.style.top = `${state.posY * mr.height - fullH / 2}px`;
}

function updateGlass({ map = false } = {}) {
  // Per-frame, lockstep: regenerate the map (deferred href on Safari) AND
  // update geometry every frame so the glass tracks the box exactly.
  if (map) regenMap();
  render();
}

function resize() {
  const r = stageEl.getBoundingClientRect();
  stageRect = { w: r.width, h: r.height };
  updateGlass();
}

// ── controls UI ──────────────────────────────────────────────────────────
function fmt(s, v) {
  return v.toFixed(s.dp);
}

function paintTrack(input, s) {
  const pct = ((state[s.key] - s.min) / (s.max - s.min)) * 100;
  input.style.background = `linear-gradient(to right, var(--primary) 0 ${pct}%, var(--track) ${pct}% 100%)`;
}

function buildControls() {
  for (const s of SLIDERS) {
    const row = document.createElement("div");
    row.className = "ctl";
    const label = document.createElement("label");
    label.textContent = s.label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = s.min;
    input.max = s.max;
    input.step = s.step;
    input.value = state[s.key];
    const val = document.createElement("div");
    val.className = "val";
    val.textContent = fmt(s, state[s.key]);
    paintTrack(input, s);
    input.addEventListener("input", () => {
      state[s.key] = parseFloat(input.value);
      val.textContent = fmt(s, state[s.key]);
      paintTrack(input, s);
      if (
        s.key === "edgeHighlight" ||
        s.key === "rimPickup" ||
        s.key === "elementShadow" ||
        s.key === "pickupDistance" ||
        s.key === "specularAngle"
      ) {
        // Top spectacle layer only. Do not touch the SVG filter/id/hrefs — this
        // avoids bringing Safari filter flicker back while tuning the rim.
        drawRimLayer(2 * state.width, 2 * state.height);
        return;
      }
      const mapKeys = [
        "width",
        "height",
        "borderRadius",
        "depth",
        "curvature",
        "splay",
      ];
      updateGlass({ map: mapKeys.includes(s.key) });
    });
    row.append(label, input, val);
    controlsEl.append(row);
  }
}

// ── drag interaction (both panels move the lens) ─────────────────────────
let dragging = false;
let off = { x: 0, y: 0 };
function attachDrag(el) {
  el.addEventListener("pointerdown", (e) => {
    const t = el.getBoundingClientRect();
    const rx = (e.clientX - t.left) / t.width;
    const ry = (e.clientY - t.top) / t.height;
    dragging = true;
    off = { x: rx - state.posX, y: ry - state.posY };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const t = el.getBoundingClientRect();
    const rx = (e.clientX - t.left) / t.width;
    const ry = (e.clientY - t.top) / t.height;
    state.posX = Math.max(0, Math.min(1, rx - off.x));
    state.posY = Math.max(0, Math.min(1, ry - off.y));
    updateGlass();
  });
  const up = () => {
    dragging = false;
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

// ── theme ────────────────────────────────────────────────────────────────
function applyTheme(theme, redraw = true) {
  darkMode = theme === "dark";
  document.documentElement.classList.toggle("dark", darkMode);
  document.body.classList.toggle("dark", darkMode);
  const label = document.querySelector("[data-theme-label]");
  if (label) label.textContent = darkMode ? "Light" : "Dark";
  updateSceneSample(true);
  if (redraw) {
    updateGlass();
  }
}

function setupTheme() {
  const toggle = document.getElementById("themeToggle");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch (_) {}
  darkMode = (stored || (prefersDark.matches ? "dark" : "light")) === "dark";
  document.documentElement.classList.toggle("dark", darkMode);
  document.body.classList.toggle("dark", darkMode);
  const label = document.querySelector("[data-theme-label]");
  if (label) label.textContent = darkMode ? "Light" : "Dark";
  toggle.addEventListener("click", () => {
    const next = document.body.classList.contains("dark") ? "light" : "dark";
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_) {}
    applyTheme(next);
  });
  prefersDark.addEventListener("change", (e) => {
    try {
      if (localStorage.getItem(THEME_KEY)) return;
    } catch (_) {}
    applyTheme(e.matches ? "dark" : "light");
  });
}

// ── boot ─────────────────────────────────────────────────────────────────
function syncControlWidgets() {
  controlsEl.querySelectorAll(".ctl").forEach((row, i) => {
    const s = SLIDERS[i];
    const input = row.querySelector("input");
    const val = row.querySelector(".val");
    input.value = state[s.key];
    val.textContent = fmt(s, state[s.key]);
    paintTrack(input, s);
  });
}

function boot() {
  buildScene(sceneEl);
  buildScene(lensContentEl);
  buildControls();
  attachDrag(stageEl);
  attachDrag(mapStageEl);
  setupTheme();
  regenMap();
  resize();
  new ResizeObserver(resize).observe(stageEl);
  window.addEventListener("resize", resize);

  window.__glass = {
    set(partial) {
      Object.assign(state, partial);
      syncControlWidgets();
      regenMap();
      render();
    },
    setTheme(theme) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (_) {}
      applyTheme(theme);
    },
    state,
  };
  window.__ready = true;
}

boot();
