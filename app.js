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

// Slider order is row-major across the 2-col grid, matching the shipped demo.
const SLIDERS = [
  { key: "width", label: "Width", min: 20, max: 120, step: 1, dp: 0 },
  { key: "height", label: "Height", min: 20, max: 80, step: 1, dp: 0 },
  { key: "borderRadius", label: "BorderRadius", min: 0, max: 64, step: 1, dp: 0 },
  { key: "scale", label: "Scale", min: 0, max: 0.2, step: 0.001, dp: 3 },
  { key: "depth", label: "Depth", min: 5, max: 60, step: 1, dp: 0 },
  { key: "curvature", label: "Curvature", min: 0, max: 80, step: 1, dp: 0 },
  { key: "splay", label: "Splay", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "chroma", label: "Chroma", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "blur", label: "Blur", min: 0, max: 12, step: 0.5, dp: 1 },
  { key: "frost", label: "Frost", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "glow", label: "Glow", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "edgeHighlight", label: "Edge Highlight", min: 0, max: 1, step: 0.01, dp: 2 },
  { key: "specularAngle", label: "Specular Angle", min: 0, max: 180, step: 1, dp: 0 },
  // Apple-like colour pickup extension.
  { key: "specular", label: "Specular", min: 0, max: 2, step: 0.02, dp: 2 },
  { key: "colorPickup", label: "Color Pickup", min: 0, max: 1, step: 0.02, dp: 2 },
  { key: "pickupOffset", label: "Pickup Offset", min: 0, max: 140, step: 1, dp: 0 },
  { key: "pickupSoftness", label: "Pickup Softness", min: 0, max: 80, step: 1, dp: 0 },
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
  frost: 0.08,
  glow: 0.35,
  edgeHighlight: 0.45,
  specularAngle: 45,
  specular: 1.35,
  colorPickup: 0.9,
  pickupOffset: 56,
  pickupSoftness: 22,
  posX: 0.5,
  posY: 0.5,
};

let darkMode = false;
let filterVersion = 0;
let mapUrl = "";
let stageRect = { w: 0, h: 0 };

const stageEl = document.getElementById("stage");
const sceneEl = document.getElementById("scene");
const lensLayerEl = document.getElementById("lensLayer");
const lensOutlineEl = document.getElementById("lensOutline");
const colorHighlightEl = document.getElementById("colorHighlight");
const lensContentEl = document.getElementById("lensContent");
const frostVeilEl = document.getElementById("frostVeil");
const mapStageEl = document.getElementById("mapStage");
const mapImg = document.getElementById("mapBlob");
const controlsEl = document.getElementById("controls");

const filterEl = document.getElementById(FILTER_BASE_ID);
const feMap = document.getElementById("feMap");
const feSourceBlur = document.getElementById("feSourceBlur");
const feDispR = document.getElementById("feDispR");
const feDispG = document.getElementById("feDispG");
const feDispB = document.getElementById("feDispB");
const fePickupMap = document.getElementById("fePickupMap");
const fePickupOffset = document.getElementById("fePickupOffset");
const fePickupBlur = document.getElementById("fePickupBlur");
const fePickupMatrix = document.getElementById("fePickupMatrix");
const feWhiteSpecMatrix = document.getElementById("feWhiteSpecMatrix");

const mapCanvas = document.createElement("canvas");
const pickupCanvas = document.createElement("canvas");

function setHref(el, href) {
  el.setAttribute("href", href);
  el.setAttributeNS("http://www.w3.org/1999/xlink", "href", href);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ── live DOM scene ───────────────────────────────────────────────────────
function buildScene(container) {
  // The original playground wraps a DOM node whose visible content is a CSS
  // background image. Keep that structure: the SVG filter bends SourceGraphic,
  // but the source is an image-like DOM surface, not hard colored dash nodes.
  container.replaceChildren();
}

// ── SVG colour-pickup map ────────────────────────────────────────────────
function regenPickupMap() {
  const size = MAP_SIZE;
  pickupCanvas.width = size;
  pickupCanvas.height = size;
  const ctx = pickupCanvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  // A smooth, saturated environment map for the specular pass. This restores
  // the Apple-like colored highlight, but because it is smooth (not hard DOM
  // dash geometry) it does not produce the blocky artifacts from the previous
  // SVG attempt. It is consumed only by SVG feImage/feComposite/feBlend.
  const angle = (state.specularAngle * Math.PI) / 180;
  const cx = size * 0.5;
  const cy = size * 0.5;
  let base;
  if (ctx.createConicGradient) {
    base = ctx.createConicGradient(angle, cx, cy);
    base.addColorStop(0.00, "#9eff65");
    base.addColorStop(0.16, "#00e6a8");
    base.addColorStop(0.32, "#0085ff");
    base.addColorStop(0.50, "#3d00ff");
    base.addColorStop(0.68, "#ff00aa");
    base.addColorStop(0.84, "#ff8a50");
    base.addColorStop(1.00, "#9eff65");
  } else {
    base = ctx.createLinearGradient(0, 0, size, size);
    base.addColorStop(0, "#9eff65");
    base.addColorStop(0.35, "#00b7ff");
    base.addColorStop(0.7, "#ff00aa");
    base.addColorStop(1, "#ff8a50");
  }
  ctx.globalAlpha = darkMode ? 0.95 : 0.72;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const addBlob = (x, y, r, color, alpha) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  };
  ctx.globalCompositeOperation = "lighter";
  addBlob(size * 0.24, size * 0.18, size * 0.58, "#b9ff42", darkMode ? 0.95 : 0.55);
  addBlob(size * 0.80, size * 0.18, size * 0.52, "#00ffaa", darkMode ? 0.80 : 0.45);
  addBlob(size * 0.92, size * 0.76, size * 0.58, "#005dff", darkMode ? 0.95 : 0.55);
  addBlob(size * 0.22, size * 0.80, size * 0.64, "#ff008c", darkMode ? 0.90 : 0.52);
  addBlob(size * 0.12, size * 0.34, size * 0.42, "#ff9d4d", darkMode ? 0.75 : 0.40);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  setHref(fePickupMap, pickupCanvas.toDataURL("image/png"));
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

  // Aave bumps filter IDs as one of the Safari cache-busting workarounds.
  // Do the same whenever the map data itself changes.
  filterVersion += 1;
  const nextId = `${FILTER_BASE_ID}-${filterVersion}`;
  filterEl.id = nextId;
  lensLayerEl.style.filter = `url(#${nextId})`;
  lensLayerEl.style.webkitFilter = `url(#${nextId})`;
}

// ── SVG filter parameter updates ─────────────────────────────────────────
function updateFilterPrimitives(fullW, fullH) {
  const scale = state.scale;
  feDispR.setAttribute("scale", String(scale * (1 + 0.2 * state.chroma)));
  feDispG.setAttribute("scale", String(scale * (1 + 0.1 * state.chroma)));
  feDispB.setAttribute("scale", String(scale));

  // Aave uses objectBoundingBox units for the normal path, so blur stdDeviation
  // is expressed as px / bbox dimension.
  feSourceBlur.setAttribute(
    "stdDeviation",
    `${state.blur / Math.max(1, fullW)} ${state.blur / Math.max(1, fullH)}`,
  );

  const ang = (state.specularAngle * Math.PI) / 180;
  fePickupOffset.setAttribute("dx", String((state.pickupOffset * Math.cos(ang)) / Math.max(1, fullW)));
  fePickupOffset.setAttribute("dy", String((-state.pickupOffset * Math.sin(ang)) / Math.max(1, fullH)));
  fePickupBlur.setAttribute("stdDeviation", String(state.pickupSoftness / Math.max(1, Math.max(fullW, fullH))));

  // Spec mask alpha tops out around 0.5 because the map B channel is encoded as
  // 128..255. These gains intentionally restore a vivid Apple-like colored edge
  // while remaining pure SVG filter compositing.
  const pickupA = Math.max(0, state.specular * state.colorPickup * (darkMode ? 3.1 : 2.45));
  const whiteA = Math.max(0, state.specular * (1 - state.colorPickup) * (darkMode ? 1.0 : 0.7));
  fePickupMatrix.setAttribute(
    "values",
    `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${pickupA} 0`,
  );
  feWhiteSpecMatrix.setAttribute(
    "values",
    `0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${whiteA} 0`,
  );
}

function updateColorHighlight() {
  const opacity = clamp01(state.specular * state.colorPickup * (darkMode ? 0.50 : 0.46));
  const blur = Math.max(3, state.pickupSoftness * 0.22);
  const a = state.specularAngle;
  colorHighlightEl.style.opacity = String(opacity);
  colorHighlightEl.style.mixBlendMode = darkMode ? "screen" : "normal";
  colorHighlightEl.style.filter = `blur(${blur}px) saturate(${darkMode ? 2.25 : 2.15})`;
  colorHighlightEl.style.background = `
    radial-gradient(circle at 22% 14%, rgba(190,255,80,.95), transparent 30%),
    radial-gradient(circle at 78% 16%, rgba(0,255,170,.86), transparent 34%),
    radial-gradient(circle at 90% 78%, rgba(0,82,255,.90), transparent 36%),
    radial-gradient(circle at 18% 82%, rgba(255,0,150,.86), transparent 36%),
    conic-gradient(from ${a - 20}deg, rgba(170,255,80,.75), rgba(0,240,190,.75), rgba(0,90,255,.78), rgba(255,0,160,.72), rgba(255,150,70,.72), rgba(170,255,80,.75))
  `;
  // Keep the color mostly on the glass perimeter/specular band instead of
  // flooding the whole tile. CSS mask is used only for the highlight layer;
  // the underlying refraction remains SVG feDisplacementMap.
  const mask = `radial-gradient(closest-side, transparent 34%, rgba(0,0,0,.30) 52%, rgba(0,0,0,.92) 74%, rgba(0,0,0,.72) 100%)`;
  colorHighlightEl.style.maskImage = mask;
  colorHighlightEl.style.webkitMaskImage = mask;
}

function updateFrostVeil() {
  if (darkMode) {
    const a = clamp01(Math.pow(state.frost, 0.72) * 0.94);
    frostVeilEl.style.background = `rgba(5, 3, 13, ${a})`;
  } else {
    const a = clamp01(Math.pow(state.frost, 1.18) * 0.38);
    frostVeilEl.style.background = `rgba(230, 224, 255, ${a})`;
  }
}

function render() {
  const fullW = 2 * state.width;
  const fullH = 2 * state.height;
  const x = state.posX * stageRect.w - fullW / 2;
  const y = state.posY * stageRect.h - fullH / 2;

  for (const el of [lensLayerEl, colorHighlightEl, lensOutlineEl]) {
    el.style.width = `${fullW}px`;
    el.style.height = `${fullH}px`;
    el.style.borderRadius = `${state.borderRadius}px`;
    el.style.transform = `translate(${x}px, ${y}px)`;
  }

  // The filtered SourceGraphic is a live DOM copy of the whole stage, shifted
  // under a clipped lens bbox. That is the SVG/live-DOM analogue of AaveGlass.
  lensContentEl.style.width = `${stageRect.w}px`;
  lensContentEl.style.height = `${stageRect.h}px`;
  lensContentEl.style.transform = `translate(${-x}px, ${-y}px)`;

  updateFilterPrimitives(fullW, fullH);
  updateFrostVeil();
  updateColorHighlight();

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
      if (s.key === "specularAngle") regenPickupMap();
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
  if (redraw) {
    regenPickupMap();
    render();
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
  regenPickupMap();
  regenMap();
  resize();
  new ResizeObserver(resize).observe(stageEl);
  window.addEventListener("resize", resize);

  window.__glass = {
    set(partial) {
      Object.assign(state, partial);
      syncControlWidgets();
      regenPickupMap();
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
