// glass.js — procedural displacement-map generator for the SVG glass filter.
//
// The map's R/G channels encode a normalized refraction direction; B encodes
// specular/glow intensity. The visible renderer is the SVG filter in index.html
// (`feImage` + `feDisplacementMap`).

// ─────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────

// erf approximation: tanh(sqrt(pi)*x)
export function erf(x) {
  return Math.tanh(1.7724538509 * x);
}

// Numerical integral used to normalise the dome profile (original `r`).
function domeIntegral(R, half) {
  let acc = 0;
  for (let i = 0; i <= 200; i++) {
    const a = (i / 200) * half;
    const s = a / Math.sqrt(R * R - a * a);
    acc += i === 0 || i === 200 ? 0.5 * s : s;
  }
  return acc / 200;
}

// computeDomeConstants(depth, halfW, halfH) — sphere radii + gradient scales.
export function computeDomeConstants(depth, hw, hh) {
  const a = Math.max(0.01, Math.min(depth, Math.min(hw, hh) - 1));
  const Rx = (hw * hw + a * a) / (2 * a);
  const Ry = (hh * hh + a * a) / (2 * a);
  const lx = domeIntegral(Rx, hw);
  const ly = domeIntegral(Ry, hh);
  return {
    Rx,
    Ry,
    scaleX: lx > 0 ? 0.5 / lx : 1,
    scaleY: ly > 0 ? 0.5 / ly : 1,
  };
}

// Spherical-cap surface gradient at |coord| (original `a`/domeGradient).
function domeGradient(absCoord, R, scale) {
  const n = Math.min(absCoord, 0.999 * R);
  return (n / Math.sqrt(R * R - n * n)) * scale;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const byte = (v) => Math.max(0, Math.min(255, (v + 0.5) | 0));

// ─────────────────────────────────────────────────────────────────────────
// Displacement-map generator. Writes straight into an ImageData / canvas.
// Aave optimization: compute one quadrant, mirror into all four. R displacement
// negates across X, G displacement negates across Y, and specular is computed
// for the two mirrored dot-product magnitudes.
// ─────────────────────────────────────────────────────────────────────────
export function generateDisplacementMap(canvas, opts) {
  const {
    canvasSize,
    lensHalfWidth,
    lensHalfHeight,
    borderRadius,
    depth,
    sdfBoundary,
    edgeFalloff,
    specularRotation = 45,
    glowStrength = 0,
    glowSpread = 1,
    glowExponent = 1.5,
    edgeStrength = 0,
    edgeWidth = 3,
    edgeExponent = 1.5,
    domeDepth = 0,
    splayAmount = 1,
  } = opts;

  const size = canvasSize;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const hw = lensHalfWidth;
  const hh = lensHalfHeight;
  const outerR = Math.min(borderRadius, Math.min(hw, hh));
  const innerW = Math.max(0, hw - depth);
  const innerH = Math.max(0, hh - depth);
  const innerR = Math.max(0, Math.min(borderRadius, Math.min(innerW, innerH)));
  const falloff = depth > 0 ? 1 / (depth * Math.SQRT2) : 1e6;
  const hasSpec = glowStrength > 0 || edgeStrength > 0;
  const specRad = (specularRotation * Math.PI) / 180;
  const cosA = Math.cos(specRad);
  const sinA = Math.sin(specRad);
  const glowStart = (1 - glowSpread) * Math.SQRT2;
  const glowRange = glowSpread * Math.SQRT2;
  const invGlowRange = glowRange > 0.001 ? 1 / glowRange : 0;
  const invEdgeWidth = edgeWidth > 0 ? 1 / edgeWidth : 0;
  const dome = domeDepth > 0 ? computeDomeConstants(domeDepth, hw, hh) : null;
  const doSplay = splayAmount < 1;
  const halfMin = 0.5 * Math.min(hw, hh);
  const invHalfMin = halfMin > 0 ? 1 / halfMin : 0;
  const pxW = (2 * hw) / size;
  const pxH = (2 * hh) / size;
  const invW = hw > 0 ? 1 / hw : 0;
  const invH = hh > 0 ? 1 / hh : 0;
  const half = size >> 1;

  // Optional x dome-gradient cache. Aave caches this because domeGradient is
  // one of the expensive paths during live resize/squish.
  let domeX = null;
  if (dome) {
    domeX = new Float32Array(half);
    for (let col = 0; col < half; col++) {
      const ax = hw - (col + 0.5) * pxW;
      domeX[col] = domeGradient(ax, dome.Rx, dome.scaleX);
    }
  }

  for (let row = 0; row < half; row++) {
    const bottomRow = size - 1 - row;
    const ay = hh - (row + 0.5) * pxH;
    const my = ay - hh + outerR;
    const innerY = edgeFalloff ? ay - innerH + innerR : 0;
    const dyBase = dome ? domeGradient(ay, dome.Ry, dome.scaleY) : clamp01(ay * invH);
    const normY = clamp01(ay * invH);
    const splayY = doSplay ? Math.max(0, 1 - (hh - ay) * invHalfMin) : 0;

    for (let col = 0; col < half; col++) {
      const rightCol = size - 1 - col;
      const ax = hw - (col + 0.5) * pxW;
      const mx = ax - hw + outerR;
      const ox = Math.max(mx, 0);
      const oy = Math.max(my, 0);
      const sdf =
        (ox || oy ? Math.sqrt(ox * ox + oy * oy) : 0) +
        Math.min(Math.max(mx, my), 0) -
        outerR;

      const tl = (row * size + col) * 4;
      const tr = (row * size + rightCol) * 4;
      const bl = (bottomRow * size + col) * 4;
      const br = (bottomRow * size + rightCol) * 4;

      if (!sdfBoundary || sdf < 0) {
        let dx = dome ? domeX[col] : clamp01(ax * invW);
        let dy = dyBase;

        if (doSplay) {
          const relax = 1 - splayAmount;
          const sy = splayY * relax;
          const sx = Math.max(0, 1 - (hw - ax) * invHalfMin) * relax;
          if (sy > 0.001 || sx > 0.001) {
            const ox0 = dx;
            const oy0 = dy;
            dx = ox0 * (1 - sy);
            dy = oy0 * (1 - sx);
            const oldMag = Math.sqrt(ox0 * ox0 + oy0 * oy0);
            const newMag = Math.sqrt(dx * dx + dy * dy);
            if (newMag > 0.001) {
              const scale = oldMag / newMag;
              dx *= scale;
              dy *= scale;
            }
          }
        }

        let edge = 1;
        if (edgeFalloff) {
          const ix = ax - innerW + innerR;
          const rx = Math.max(ix, 0);
          const ry = Math.max(innerY, 0);
          const innerSdf =
            Math.sqrt(rx * rx + ry * ry) +
            Math.min(Math.max(ix, innerY), 0) -
            innerR;
          edge = 0.5 * (1 + erf(innerSdf * falloff));
        }

        const hx = 0.5 * dx * edge;
        const hy = 0.5 * dy * edge;
        const redLeft = byte((0.5 + hx) * 255);
        const redRight = byte((0.5 - hx) * 255);
        const greenTop = byte((0.5 + hy) * 255);
        const greenBottom = byte((0.5 - hy) * 255);

        let blueDiag = 128;
        let blueAnti = 128;
        if (hasSpec) {
          const nx = clamp01(ax * invW) * cosA;
          const ny = normY * sinA;
          const diagDot = Math.abs(nx + ny);
          const antiDot = Math.abs(nx - ny);
          let diag = 0;
          let anti = 0;
          const edgeBand = edgeStrength > 0 && sdf < 0 ? Math.max(0, 1 + sdf * invEdgeWidth) : 0;
          if (glowStrength > 0) {
            const gd = clamp01((diagDot - glowStart) * invGlowRange);
            const ga = clamp01((antiDot - glowStart) * invGlowRange);
            diag += glowStrength * Math.pow(gd, glowExponent) * edge;
            anti += glowStrength * Math.pow(ga, glowExponent) * edge;
          }
          if (edgeStrength > 0) {
            diag += edgeStrength * edgeBand * Math.pow(diagDot, edgeExponent);
            anti += edgeStrength * edgeBand * Math.pow(antiDot, edgeExponent);
          }
          blueDiag = byte(127 * Math.min(1, diag) + 128);
          blueAnti = byte(127 * Math.min(1, anti) + 128);
        }

        data[tl] = redLeft; data[tl + 1] = greenTop; data[tl + 2] = blueDiag; data[tl + 3] = 255;
        data[tr] = redRight; data[tr + 1] = greenTop; data[tr + 2] = blueAnti; data[tr + 3] = 255;
        data[bl] = redLeft; data[bl + 1] = greenBottom; data[bl + 2] = blueAnti; data[bl + 3] = 255;
        data[br] = redRight; data[br + 1] = greenBottom; data[br + 2] = blueDiag; data[br + 3] = 255;
      } else {
        data[tl] = data[tl + 1] = data[tl + 2] = 128; data[tl + 3] = 255;
        data[tr] = data[tr + 1] = data[tr + 2] = 128; data[tr + 3] = 255;
        data[bl] = data[bl + 1] = data[bl + 2] = 128; data[bl + 3] = 255;
        data[br] = data[br + 1] = data[br + 2] = 128; data[br + 3] = 255;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}
