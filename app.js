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
  { key: "blur", label: "Blur", min: 0, max: 2, step: 0.25, dp: 2 },
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
  blur: 0,
  glow: 0.1,
  edgeHighlight: 0.25,
  specularAngle: 45,
  posX: 0.5,
  posY: 0.5,
};

let darkMode = false;
let filterVersion = 0;
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

function applyFreshFilterId(force = false) {
  // Safari/WebKit caches SVG filter output by filter id. Moving the lens only
  // changes primitive attributes (`feImage x/y`, `clip-path`, offsets), so
  // Safari can keep serving a stale render unless the id changes.
  if (!force && !isSafariLike) return;
  filterVersion += 1;
  const nextId = `${FILTER_BASE_ID}-${filterVersion}`;
  filterEl.id = nextId;
  const url = `url(#${nextId})`;
  lensLayerEl.style.filter = url;
  lensLayerEl.style.webkitFilter = url;
}

// ── live DOM scene ───────────────────────────────────────────────────────
function buildScene(container) {
  // Aave's playground source is just the demo background image (the dashed
  // grid). No color blobs — those were ours for the color-pickup extension,
  // removed for exact parity. The .scene / .lensContent CSS paints the bg.
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
  setHref(feMap, mapUrl);

  // Always refresh when the map data itself changes. Safari additionally gets
  // a fresh id on every render/move below.
  applyFreshFilterId(true);
}

// ── SVG filter parameter updates ─────────────────────────────────────────
function updateFilterPrimitives(fullW, fullH) {
  // Safari is much more reliable when the filter region is the lens bbox and
  // the displacement map fills that bbox. The underlying source is aligned by
  // translating the DOM content inside the moving lens layer.
  feMap.setAttribute("x", "0");
  feMap.setAttribute("y", "0");
  feMap.setAttribute("width", "1");
  feMap.setAttribute("height", "1");

  // Displacement scale (objectBoundingBox units, exactly matching Aave's
  // `scale` variable). A sweep vs Aave's live WebKit render showed our
  // refraction is within ~10% of theirs at the same scale value — inside the
  // render-pipeline noise floor — so we keep the variable 1:1.
  const scale = state.scale;
  feDispR.setAttribute("scale", String(scale * (1 + 0.2 * state.chroma)));
  feDispG.setAttribute("scale", String(scale * (1 + 0.1 * state.chroma)));
  feDispB.setAttribute("scale", String(scale));

  feSourceBlur.setAttribute(
    "stdDeviation",
    `${state.blur / Math.max(1, fullW)} ${state.blur / Math.max(1, fullH)}`,
  );
  // Safari-only final-output blur. Aave's own WebKit render is slightly soft
  // (their compositor applies less sub-pixel AA, and the production build has
  // the same characteristic), so this final smoothing actually IMPROVES
  // parity with Aave's live render, not just internal Chrome/WebKit parity.
  // Removing it regresses the Aave diff (0.55% -> 0.94%).
  // Safari-only final-output blur, tuned to Aave's live WebKit render. Their
  // refracted interior is slightly softer than a raw feDisplacementMap on
  // WebKit; a sweep against their page minimised the diff at ~0.75px.
  const finalBlurPx = isSafariLike ? 0.75 : 0;
  if (feFinalBlur) {
    feFinalBlur.setAttribute(
      "stdDeviation",
      `${finalBlurPx / Math.max(1, fullW)} ${finalBlurPx / Math.max(1, fullH)}`,
    );
  }

}

function render() {
  const fullW = 2 * state.width;
  const fullH = 2 * state.height;
  const x = state.posX * stageRect.w - fullW / 2;
  const y = state.posY * stageRect.h - fullH / 2;

  for (const el of [lensLayerEl, lensOutlineEl]) {
    el.style.width = `${fullW}px`;
    el.style.height = `${fullH}px`;
    el.style.borderRadius = `${state.borderRadius}px`;
    el.style.transform = `translate(${x}px, ${y}px)`;
  }
  // Clip-path no longer needed for the rim (the opaque map fixes that), but
  // we keep a rounded clip so the lens layer can't spill past its own
  // rounded box on either engine. This matches the lens silhouette.
  const clip = `inset(0 round ${state.borderRadius}px)`;
  lensLayerEl.style.clipPath = clip;
  lensLayerEl.style.webkitClipPath = clip;

  // The filtered SourceGraphic is the full scene translated underneath a moving
  // lens-sized viewport. This keeps the lens and rendered glass in the same
  // coordinate system on Safari/iOS.
  lensContentEl.style.width = `${stageRect.w}px`;
  lensContentEl.style.height = `${stageRect.h}px`;
  lensContentEl.style.transform = `translate(${-x}px, ${-y}px)`;

  updateFilterPrimitives(fullW, fullH);
  applyFreshFilterId(false);

  const mr = mapStageEl.getBoundingClientRect();
  mapImg.style.width = `${fullW}px`;
  mapImg.style.height = `${fullH}px`;
  mapImg.style.left = `${state.posX * mr.width - fullW / 2}px`;
  mapImg.style.top = `${state.posY * mr.height - fullH / 2}px`;
}

function resize() {
  const r = stageEl.getBoundingClientRect();
  stageRect = { w: r.width, h: r.height };
  render();
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
      if (mapKeys.includes(s.key)) regenMap();
      render();
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
    render();
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
  if (redraw) render();
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
