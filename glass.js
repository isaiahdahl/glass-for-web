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

// ─────────────────────────────────────────────────────────────────────────
// Displacement-map generator. Writes straight into an ImageData / canvas.
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

  const r = canvasSize;
  canvas.width = r;
  canvas.height = r;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(r, r);
  const data = img.data;

  const n = lensHalfWidth;
  const l = lensHalfHeight;
  const iRad = borderRadius;
  const o = depth;

  const S = Math.min(iRad, Math.min(n, l)); // outer corner radius
  const w = Math.max(0, n - o); // inner half-width
  const A = Math.max(0, l - o); // inner half-height
  const v = Math.max(0, Math.min(iRad, Math.min(w, A))); // inner corner radius
  const E = o > 0 ? 1 / (o * Math.SQRT2) : 1e6; // erf falloff factor
  const hasSpec = glowStrength > 0 || edgeStrength > 0;
  const C = (specularRotation * Math.PI) / 180;
  const k = Math.cos(C);
  const j = Math.sin(C);
  const I = (1 - glowSpread) * Math.SQRT2;
  const T = glowSpread * Math.SQRT2;
  const F = domeDepth > 0 ? computeDomeConstants(domeDepth, n, l) : null;
  const D = splayAmount < 1;
  const L0 = 0.5 * Math.min(n, l);
  const B = L0 > 0 ? 1 / L0 : 0;

  for (let row = 0; row < r; row++) {
    for (let col = 0; col < r; col++) {
      const t = (row * r + col) * 4;
      const ox = ((col + 0.5) / r) * (2 * n) - n; // x in [-n, n]
      const fy = ((row + 0.5) / r) * (2 * l) - l; // y in [-l, l]
      const g = Math.abs(ox);
      const y = Math.abs(fy);
      const M = g - n + S;
      const Cc = y - l + S;
      const Lc = Math.max(M, 0);
      const H = Math.max(Cc, 0);
      const O = Lc * Lc + H * H;
      // Rounded-rect signed distance (outer shape)
      const sdf =
        (O > 0 ? Math.sqrt(O) : 0) + Math.min(Math.max(M, Cc), 0) - S;

      if (!sdfBoundary || sdf < 0) {
        data[t + 3] = 255;
        let dx, dy;
        if (F) {
          dx = Math.sign(ox) * domeGradient(g, F.Rx, F.scaleX);
          dy = Math.sign(fy) * domeGradient(y, F.Ry, F.scaleY);
        } else {
          dx = Math.max(-1, Math.min(1, ox / n));
          dy = Math.max(-1, Math.min(1, fy / l));
        }

        let u = dx;
        let Mm = dy;

        // Splay: relax displacement toward the edges so the rim flattens.
        if (D) {
          const ee = Math.max(0, 1 - (l - y) * B) * (1 - splayAmount);
          const tt = Math.max(0, 1 - (n - g) * B) * (1 - splayAmount);
          if (ee > 0.001 || tt > 0.001) {
            const r0 = u;
            const n0 = Mm;
            u = r0 * (1 - ee);
            Mm = n0 * (1 - tt);
            const lmag = Math.sqrt(r0 * r0 + n0 * n0);
            const imag = Math.sqrt(u * u + Mm * Mm);
            if (imag > 0.001) {
              const sc = lmag / imag;
              u *= sc;
              Mm *= sc;
            }
          }
        }

        // Edge falloff: erf ramp across the inner-rect SDF (driven by depth).
        let ii;
        if (edgeFalloff) {
          const e2 = g - w + v;
          const t2 = y - A + v;
          const r2 =
            Math.sqrt(Math.max(e2, 0) ** 2 + Math.max(t2, 0) ** 2) +
            Math.min(Math.max(e2, t2), 0) -
            v;
          ii = 0.5 * (1 + erf(r2 * E));
        } else {
          ii = 1;
        }

        data[t] = Math.round((0.5 - 0.5 * u * ii) * 255);
        data[t + 1] = Math.round((0.5 - 0.5 * Mm * ii) * 255);

        if (hasSpec) {
          // Specular term: dot of the (un-domed) normal with the light dir.
          const sd = Math.abs(
            Math.max(-1, Math.min(1, ox / n)) * k +
              Math.max(-1, Math.min(1, fy / l)) * j,
          );
          let sv = 0;
          if (glowStrength > 0)
            sv +=
              glowStrength *
              Math.pow(
                T > 0.001 ? Math.min(1, Math.max(0, sd - I) / T) : 0,
                glowExponent,
              ) *
              ii;
          if (edgeStrength > 0)
            sv +=
              edgeStrength *
              (sdf < 0 ? Math.max(0, 1 + sdf / edgeWidth) : 0) *
              Math.pow(sd, edgeExponent);
          sv = Math.min(1, sv);
          data[t + 2] = Math.round(127 * sv + 128);
        } else {
          data[t + 2] = 128;
        }
      } else {
        data[t] = 128;
        data[t + 1] = 128;
        data[t + 2] = 128;
        // Transparent outside the rounded lens so the SVG map can be composited
        // cleanly over the neutral map background.
        data[t + 3] = 0;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}
