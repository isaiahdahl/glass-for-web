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
  { key: "glow", label: "Glow", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "edgeHighlight", label: "Edge Highlight", min: 0, max: 1, step: 0.01, dp: 2 },
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
  glow: 0.1,
  edgeHighlight: 0.25,
  specularAngle: 45,
  posX: 0.5,
  posY: 0.5,
};

let darkMode = false;
let mapUrl = "";
let stageRect = { w: 0, h: 0 };

const ua = navigator.userAgent;
const isSafariLike = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox|Android/i.test(ua);

const stageEl = document.getElementById("stage");
const sceneEl = document.getElementById("scene");
const lensLayerEl = document.getElementById("lensLayer");
const lensOutlineEl = document.getElementById("lensOutline");
const lensContentEl = document.getElementById("lensContent");
const mapStageEl = document.getElementById("mapStage");
const mapImg = document.getElementById("mapBlob");
const controlsEl = document.getElementById("controls");

const filterEl = document.getElementById(FILTER_BASE_ID);
const feMap = document.getElementById("feMap");
const feSourceBlur = document.getElementById("feSourceBlur");
const feFinalBlur = document.getElementById("feFinalBlur");
const feDispR = document.getElementById("feDispR");
const feDispG = document.getElementById("feDispG");
const feDispB = document.getElementById("feDispB");

const mapCanvas = document.createElement("canvas");

function setHref(el, href) {
  el.setAttribute("href", href);
  el.setAttributeNS("http://www.w3.org/1999/xlink", "href", href);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
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
    glowStrength: state.glow,
    glowSpread: 1,
    glowExponent: 1.5,
    edgeStrength: state.edgeHighlight,
    edgeWidth: 3,
    edgeExponent: 1.5,
    domeDepth: state.curvature,
    splayAmount: state.splay,
  });

  mapUrl = mapCanvas.toDataURL("image/png");
  mapImg.src = mapUrl;
  applyMapHref(mapUrl);
}

// Aave's flicker fix (reverse-engineered): the synchronous filter-id bump that
// forces Safari to re-render must run against the PREVIOUS, already-decoded
// feImage. If we set the new map href and bump the id in the same frame, Safari
// rebuilds the filter against a not-yet-decoded image -> a flicker frame with
// no/!wrong refraction. So on Safari we defer the href swap to a separate
// macrotask (coalesced), decoupled from the id bump. The new map then decodes
// in place one frame later, which is imperceptible during a drag.
let feMapHasHref = false;
let pendingMapUrl = null;
let pendingMapTimer = 0;
function applyPendingMap() {
  pendingMapTimer = 0;
  if (pendingMapUrl == null) return;
  setHref(feMap, pendingMapUrl);
  pendingMapUrl = null;
}
function applyMapHref(url) {
  if (!isSafariLike || !feMapHasHref) {
    // First map (or Chromium, which re-renders attribute changes natively):
    // set synchronously so there's never an undisplaced first frame.
    setHref(feMap, url);
    feMapHasHref = true;
    return;
  }
  pendingMapUrl = url;
  if (!pendingMapTimer) pendingMapTimer = setTimeout(applyPendingMap, 0);
}

// ── SVG filter parameter updates ─────────────────────────────────────────
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
  feMap.setAttribute("x", String(x / sw));
  feMap.setAttribute("y", String(y / sh));
  feMap.setAttribute("width", String(fullW / sw));
  feMap.setAttribute("height", String(fullH / sh));

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
  lensOutlineEl.style.width = `${fullW}px`;
  lensOutlineEl.style.height = `${fullH}px`;
  lensOutlineEl.style.borderRadius = `${state.borderRadius}px`;
  lensOutlineEl.style.transform = `translate(${x}px, ${y}px)`;
  // The displacement map's blue/specular channel is not part of the parity
  // SVG composite, so make the highlight visibly controlled on the separate
  // outline shell instead. This does not affect filter geometry/refraction.
  lensOutlineEl.style.setProperty("--spec-angle", `${state.specularAngle}deg`);
  lensOutlineEl.style.setProperty(
    "--spec-opacity",
    clamp01(state.edgeHighlight * 0.55).toFixed(3),
  );
  lensOutlineEl.style.setProperty(
    "--glow-opacity",
    clamp01(state.glow * 1.0).toFixed(3),
  );

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
      const mapKeys = [
        "width",
        "height",
        "borderRadius",
        "depth",
        "curvature",
        "splay",
        "glow",
        "edgeHighlight",
        "specularAngle",
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
