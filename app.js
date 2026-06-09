// app.js — wires the playground: sliders, drag, map regeneration, refraction.
import { generateDisplacementMap, GlassRenderer } from "./glass.js";

const DPR = Math.min(window.devicePixelRatio || 1, 1.25);
const MAP_SIZE = 512;
const THEME_KEY = "glass-web-theme";

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
  // ── specular highlight + Color Pickup extension (from client-core prototype) ──
  { key: "specular", label: "Specular", min: 0, max: 2, step: 0.02, dp: 2 },
  { key: "colorPickup", label: "Color Pickup", min: 0, max: 1, step: 0.02, dp: 2 },
  { key: "pickupOffset", label: "Pickup Offset", min: 0, max: 140, step: 1, dp: 0 },
  { key: "pickupSoftness", label: "Pickup Softness", min: 0, max: 80, step: 1, dp: 0 },
];

// Defaults chosen to match the original public demo's initial visual balance.
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
  glow: 0.1,
  edgeHighlight: 0.25,
  specularAngle: 45,
  // specular highlight + Color Pickup (prototype defaults)
  specular: 1.0,
  colorPickup: 0.7,
  pickupOffset: 56,
  pickupSoftness: 28,
  // lens position in [0,1] within the stage
  posX: 0.5,
  posY: 0.5,
};

// six studio hues for the colourful dotted scene (so the highlight has
// something to pick up). Matches the client-core prototype palette.
const GRID_PALETTE = ["#844be7", "#e74bae", "#53B1E9", "#4be784", "#FD9843", "#e1c71e"];
let darkMode = false;

const stageEl = document.getElementById("stage");
const mapStageEl = document.getElementById("mapStage");
const glassCanvas = document.getElementById("glass");
const outlineEl = document.getElementById("outline");
const mapImg = document.getElementById("mapBlob");
const controlsEl = document.getElementById("controls");

const mapCanvas = document.createElement("canvas");
const srcCanvas = document.createElement("canvas");
const srcCtx = srcCanvas.getContext("2d");

let renderer = null;
let stageRect = { w: 0, h: 0 };

// ── source background (cover) ────────────────────────────────────────────
function drawSource() {
  if (stageRect.w === 0) return;
  const w = Math.max(1, Math.round(stageRect.w * DPR));
  const h = Math.max(1, Math.round(stageRect.h * DPR));
  if (srcCanvas.width !== w || srcCanvas.height !== h) {
    srcCanvas.width = w;
    srcCanvas.height = h;
  }
  drawProceduralBackground(w, h);
  drawColorGrid(w, h);
}

function drawProceduralBackground(w, h) {
  srcCtx.clearRect(0, 0, w, h);
  const base = srcCtx.createLinearGradient(0, 0, w, h);
  if (darkMode) {
    base.addColorStop(0, "#17142d");
    base.addColorStop(0.55, "#111021");
    base.addColorStop(1, "#241844");
  } else {
    base.addColorStop(0, "#fbf8ff");
    base.addColorStop(0.5, "#f4efff");
    base.addColorStop(1, "#dfd7ff");
  }
  srcCtx.fillStyle = base;
  srcCtx.fillRect(0, 0, w, h);

  const glow1 = srcCtx.createRadialGradient(w * 0.18, h * 0.25, 0, w * 0.18, h * 0.25, w * 0.75);
  glow1.addColorStop(0, darkMode ? "rgba(110,92,255,.22)" : "rgba(255,255,255,.72)");
  glow1.addColorStop(1, "rgba(255,255,255,0)");
  srcCtx.fillStyle = glow1;
  srcCtx.fillRect(0, 0, w, h);

  const glow2 = srcCtx.createRadialGradient(w * 0.86, h * 0.84, 0, w * 0.86, h * 0.84, w * 0.55);
  glow2.addColorStop(0, darkMode ? "rgba(170,70,255,.18)" : "rgba(139,123,246,.20)");
  glow2.addColorStop(1, "rgba(139,123,246,0)");
  srcCtx.fillStyle = glow2;
  srcCtx.fillRect(0, 0, w, h);
}

// Colourful dotted grid drawn over the background so the Color Pickup highlight
// has live hues to sample (6 hues, dotted, like the prototype scene).
function drawColorGrid(w, h) {
  const inset = 0.08 * Math.min(w, h);
  const innerW = w - inset * 2;
  const innerH = h - inset * 2;
  const cols = 6;
  const rows = 4;
  srcCtx.save();
  srcCtx.lineCap = "round";
  srcCtx.lineWidth = Math.max(3, 0.008 * w);
  srcCtx.setLineDash([srcCtx.lineWidth, srcCtx.lineWidth * 4]);
  srcCtx.globalAlpha = darkMode ? 0.9 : 0.8;
  for (let i = 0; i < cols; i++) {
    const x = inset + (innerW * i) / (cols - 1);
    srcCtx.strokeStyle = GRID_PALETTE[i % GRID_PALETTE.length];
    srcCtx.beginPath();
    srcCtx.moveTo(x, inset);
    srcCtx.lineTo(x, h - inset);
    srcCtx.stroke();
  }
  for (let i = 0; i < rows; i++) {
    const y = inset + (innerH * i) / (rows - 1);
    srcCtx.strokeStyle = GRID_PALETTE[(i + 3) % GRID_PALETTE.length];
    srcCtx.beginPath();
    srcCtx.moveTo(inset, y);
    srcCtx.lineTo(w - inset, y);
    srcCtx.stroke();
  }
  srcCtx.restore();
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
  if (renderer) renderer.setDisplacementMap(mapCanvas);
  mapImg.src = mapCanvas.toDataURL("image/png");
}

// ── per-frame lens params (mirrors getLens `ea`) ─────────────────────────
function getLens() {
  const fullW = 2 * state.width; // lens spans 2*Width px
  const fullH = 2 * state.height;
  const e = stageRect.w;
  const t = stageRect.h;
  if (e <= 0 || t <= 0) return null;
  // Color Pickup sample vector: offset px along the specular angle (y up),
  // expressed in UV space. Matches the prototype's feOffset direction.
  const ang = (state.specularAngle * Math.PI) / 180;
  const pickupOffset = [
    (state.pickupOffset * Math.cos(ang)) / e,
    (-state.pickupOffset * Math.sin(ang)) / t,
  ];
  return {
    sizeX: fullW / e,
    sizeY: fullH / t,
    originX: state.posX - fullW / e / 2,
    originY: state.posY - fullH / t / 2,
    scaleX: state.scale,
    scaleY: state.scale,
    chroma: state.chroma,
    blur: state.blur * DPR,
    frost: state.frost,
    specStrength: state.specular,
    colorPickup: state.colorPickup,
    pickupOffset,
    // Use the larger stage dimension so softness feels like a true pixel radius
    // rather than shrinking too much on wide stages.
    pickupSoftness: state.pickupSoftness / Math.max(e, t),
    isDark: darkMode,
  };
}

function render() {
  if (!renderer) return;
  renderer.render(srcCanvas, getLens());

  // overlay outline (the CSS box-shadow tile that rides on the lens)
  const fullW = 2 * state.width;
  const fullH = 2 * state.height;
  outlineEl.style.width = fullW + "px";
  outlineEl.style.height = fullH + "px";
  outlineEl.style.borderRadius = state.borderRadius + "px";
  outlineEl.style.transform = `translate(${state.posX * stageRect.w - fullW / 2}px, ${
    state.posY * stageRect.h - fullH / 2
  }px)`;

  // right-side map blob, centred on the same drag point
  const mr = mapStageEl.getBoundingClientRect();
  mapImg.style.width = fullW + "px";
  mapImg.style.height = fullH + "px";
  mapImg.style.left = state.posX * mr.width - fullW / 2 + "px";
  mapImg.style.top = state.posY * mr.height - fullH / 2 + "px";
}

// ── sizing ───────────────────────────────────────────────────────────────
function resize() {
  const r = stageEl.getBoundingClientRect();
  stageRect = { w: r.width, h: r.height };
  glassCanvas.width = Math.max(1, Math.round(r.width * DPR));
  glassCanvas.height = Math.max(1, Math.round(r.height * DPR));
  drawSource();
  render();
}

// ── controls UI ──────────────────────────────────────────────────────────
function fmt(s, v) {
  return v.toFixed(s.dp);
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
      // geometry/specular params need a fresh map; scale/chroma/blur don't.
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
// purple fill to the left of the thumb (matches the demo's slider styling)
function paintTrack(input, s) {
  const pct = ((state[s.key] - s.min) / (s.max - s.min)) * 100;
  input.style.background = `linear-gradient(to right, var(--primary) 0 ${pct}%, var(--track) ${pct}% 100%)`;
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
  const up = () => { dragging = false; };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

// ── boot ─────────────────────────────────────────────────────────────────
function applyTheme(theme, redraw = true) {
  darkMode = theme === "dark";
  document.documentElement.classList.toggle("dark", darkMode);
  document.body.classList.toggle("dark", darkMode);
  const label = document.querySelector("[data-theme-label]");
  if (label) label.textContent = darkMode ? "Light" : "Dark";
  if (redraw) {
    drawSource();
    render();
  }
}

function setupTheme() {
  const toggle = document.getElementById("themeToggle");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch (_) {}
  darkMode = (stored || (prefersDark.matches ? "dark" : "light")) === "dark";
  document.documentElement.classList.toggle("dark", darkMode);
  document.body.classList.toggle("dark", darkMode);
  const label = document.querySelector("[data-theme-label]");
  if (label) label.textContent = darkMode ? "Light" : "Dark";
  toggle.addEventListener("click", () => {
    const next = document.body.classList.contains("dark") ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyTheme(next);
  });
  prefersDark.addEventListener("change", (e) => {
    try { if (localStorage.getItem(THEME_KEY)) return; } catch (_) {}
    applyTheme(e.matches ? "dark" : "light");
  });
}

async function boot() {
  renderer = new GlassRenderer(glassCanvas);
  buildControls();
  attachDrag(stageEl);
  attachDrag(mapStageEl);
  setupTheme();
  regenMap();
  resize();
  new ResizeObserver(resize).observe(stageEl);
  window.addEventListener("resize", resize);

  // Test hook for the screenshot harness.
  window.__glass = {
    set(partial) {
      Object.assign(state, partial);
      // refresh slider widgets
      controlsEl.querySelectorAll(".ctl").forEach((row, i) => {
        const s = SLIDERS[i];
        const input = row.querySelector("input");
        const val = row.querySelector(".val");
        input.value = state[s.key];
        val.textContent = fmt(s, state[s.key]);
        paintTrack(input, s);
      });
      regenMap();
      render();
    },
    setTheme(theme) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
      applyTheme(theme);
    },
    state,
  };
  window.__ready = true;
}

boot();
