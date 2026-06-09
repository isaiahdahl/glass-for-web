// glass.js — procedural displacement-map + WebGL2 glass renderer.
//
// The map's R/G channels encode a normalized refraction direction; B encodes
// specular/glow intensity. The renderer displaces the background by
// (rg-0.5)*scale with per-channel chromatic splitting, optional source blur,
// separate frost, and directional color pickup.

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
        // Transparent outside the rounded lens. The WebGL path uses alpha so
        // frost/blur/specular are contained to the rounded shape instead of the
        // rectangular bbox.
        data[t + 3] = 0;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ─────────────────────────────────────────────────────────────────────────
// WebGL2 refraction renderer
// ─────────────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_src;
uniform sampler2D u_disp;
uniform sampler2D u_blurred;
uniform int u_active;
uniform float u_hasBlur;
uniform float u_frost;
uniform vec2 u_lensOrigin;
uniform vec2 u_lensSize;
uniform vec2 u_scale;
uniform float u_chroma;

// ── specular + "Color Pickup" extension (ported from the client-core
//    glass-refraction-prototype). The highlight sits where the map's blue
//    channel is bright, and is tinted toward the scene colour sampled at a
//    short offset along the specular angle. ──
uniform float u_specStrength;   // overall highlight strength
uniform float u_colorPickup;    // 0 = white highlight, 1 = environment colour
uniform vec2 u_pickupOffset;    // UV-space sample offset (dir * px / frame)
uniform float u_pickupSoftness; // UV-space blur radius for the env sample
uniform float u_isDark;         // 1 dark: additive neon, 0 light: tint-preserve

vec4 srcSample(vec2 p, float mixAmt) {
  vec4 raw = texture(u_src, p);
  if (mixAmt <= 0.0) return raw;
  vec4 b = texture(u_blurred, p);
  b.rgb = b.a > 1e-4 ? b.rgb / b.a : b.rgb;
  return mix(raw, b, mixAmt);
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);

  if (u_active == 0) { fragColor = texture(u_src, uv); return; }

  vec2 lensUV = (uv - u_lensOrigin) / u_lensSize;
  bool inside = lensUV.x >= 0.0 && lensUV.x <= 1.0 &&
                lensUV.y >= 0.0 && lensUV.y <= 1.0;
  if (!inside) { fragColor = texture(u_src, uv); return; }

  vec4 d = texture(u_disp, lensUV);
  if (d.a < 0.01) { fragColor = texture(u_src, uv); return; }

  vec2 disp = (d.rg - 0.5) * u_scale;
  float blurMix = u_hasBlur * d.a;
  vec2 uvR = uv + disp * (1.0 + u_chroma * 0.2);
  vec2 uvG = uv + disp * (1.0 + u_chroma * 0.1);
  vec2 uvB = uv + disp;

  vec4 sr = srcSample(uvR, blurMix);
  vec4 sg = srcSample(uvG, blurMix);
  vec4 sb = srcSample(uvB, blurMix);
  float a = max(max(sr.a, sg.a), sb.a);
  vec3 rgb = vec3(sr.r, sg.g, sb.b);

  // Frost veil: separate from blur. Blur refracts a softened source; frost is
  // a milky material layer whose colour/strength changes by theme.
  if (u_frost > 0.001) {
    if (u_isDark > 0.5) {
      // Dark mode should get dense / smoked glass at high frost values.
      // Use a much higher opacity curve than light mode so max frost actually
      // obscures the content instead of staying transparent.
      vec3 frostColor = vec3(0.012, 0.010, 0.030);
      float frostMix = clamp(pow(u_frost, 0.72) * 0.94, 0.0, 0.94);
      rgb = mix(rgb, frostColor, frostMix);
    } else {
      // Light mode was turning into a white rectangle. Keep it lavender/pearl
      // and cap the veil so refraction and picked-up colour still show through.
      vec3 frostColor = vec3(0.90, 0.88, 0.98);
      float frostMix = clamp(pow(u_frost, 1.18) * 0.38, 0.0, 0.38);
      rgb = mix(rgb, frostColor, frostMix);
    }
  }

  // Specular pass: highlight intensity lives in the map's blue channel.
  float specA = max(0.0, d.b - 0.50196);
  if (u_specStrength > 0.0 && specA > 0.0) {
    // Environment sample: aggressive max-gather along the specular ray. Rather
    // than averaging (which washes saturated objects into the pale background),
    // take the strongest colour seen from multiple distances + a soft cross.
    vec2 dir = u_pickupOffset;
    vec2 ep = uv + dir;
    vec3 env = texture(u_src, ep).rgb;
    env = max(env, texture(u_src, uv + dir * 0.5).rgb);
    env = max(env, texture(u_src, uv + dir * 1.5).rgb);
    env = max(env, texture(u_src, uv + dir * 2.25).rgb);
    if (u_pickupSoftness > 0.0) {
      float s = u_pickupSoftness;
      vec2 a = vec2(s, 0.0), b = vec2(0.0, s);
      vec2 c = vec2(s, s) * 0.7071, e = vec2(s, -s) * 0.7071;
      env = max(env, texture(u_src, ep + a).rgb);
      env = max(env, texture(u_src, ep - a).rgb);
      env = max(env, texture(u_src, ep + b).rgb);
      env = max(env, texture(u_src, ep - b).rgb);
      env = max(env, texture(u_src, ep + c).rgb);
      env = max(env, texture(u_src, ep - c).rgb);
      env = max(env, texture(u_src, ep + e).rgb);
      env = max(env, texture(u_src, ep - e).rgb);
      env = max(env, texture(u_src, ep + a * 2.0).rgb);
      env = max(env, texture(u_src, ep - a * 2.0).rgb);
      env = max(env, texture(u_src, ep + b * 2.0).rgb);
      env = max(env, texture(u_src, ep - b * 2.0).rgb);
    }

    // Brightness-cohesive colour stacking.
    // Dark mode: additive neon works because the surface has headroom.
    // Light mode: additive colour clips into white, so preserve highlight
    // luminance but tint the highlight toward the gathered hue.
    float neutral = min(env.r, min(env.g, env.b));
    vec3 chroma = max(env - vec3(neutral), vec3(0.0));
    float maxChroma = max(chroma.r, max(chroma.g, chroma.b));
    vec3 hue = maxChroma > 0.001 ? chroma / maxChroma : vec3(1.0);
    float spec = u_specStrength * specA;

    if (u_isDark > 0.5) {
      vec3 specColor = vec3(1.0) + u_colorPickup * 7.0 * chroma;
      rgb += spec * specColor;
    } else {
      // Light surfaces have very little headroom; use a power curve to narrow
      // the broad specular mask so it reads as crisp coloured edge/sparkle, not
      // a thick white blob.
      float specLite = u_specStrength * pow(specA, 2.25);
      rgb += specLite * vec3(0.18);
      // Paint a coloured glaze over the bright highlight. This can reduce
      // non-hue channels slightly, which is exactly what lets colour be visible
      // on a white/light surface while retaining perceived brightness.
      float tintA = clamp(specLite * u_colorPickup * smoothstep(0.02, 0.20, maxChroma) * 3.2, 0.0, 0.82);
      float lum = max(rgb.r, max(rgb.g, rgb.b));
      vec3 tintedHighlight = mix(vec3(lum), hue * lum, 0.78);
      rgb = mix(rgb, tintedHighlight, tintA);
      // Add a smaller saturated kick on top after tinting.
      rgb += specLite * u_colorPickup * 1.9 * chroma;
    }
  }

  fragColor = vec4(rgb, a);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_source;
uniform vec2 u_dir;
uniform float u_premul;

vec4 fetch(vec2 uv) {
  vec4 c = texture(u_source, uv);
  if (u_premul > 0.5) c.rgb *= c.a;
  return c;
}

void main() {
  vec4 c = fetch(v_uv) * 0.2042;
  c += (fetch(v_uv + 1.0 * u_dir) + fetch(v_uv - 1.0 * u_dir)) * 0.1801;
  c += (fetch(v_uv + 2.0 * u_dir) + fetch(v_uv - 2.0 * u_dir)) * 0.1240;
  c += (fetch(v_uv + 3.0 * u_dir) + fetch(v_uv - 3.0 * u_dir)) * 0.0663;
  c += (fetch(v_uv + 4.0 * u_dir) + fetch(v_uv - 4.0 * u_dir)) * 0.0276;
  fragColor = c;
}`;

function compile(gl, src, type) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("Shader compile failed: " + log);
  }
  return sh;
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error("Program link failed: " + gl.getProgramInfoLog(p));
  return p;
}

export class GlassRenderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      alpha: true,
      antialias: true,
    });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    this.srcSize = { w: 0, h: 0 };
    this.blurW = 0;
    this.blurH = 0;
    this.dispReady = false;

    const vs = compile(gl, VERT, gl.VERTEX_SHADER);
    this.program = link(gl, vs, compile(gl, FRAG, gl.FRAGMENT_SHADER));
    this.blurProgram = link(gl, vs, compile(gl, BLUR_FRAG, gl.FRAGMENT_SHADER));
    gl.useProgram(this.program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const mkTex = (unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    this.srcTex = mkTex(0);
    this.dispTex = mkTex(1);
    this.blurTexA = mkTex(3);
    this.blurTexB = mkTex(3);

    const mkFbo = (tex) => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        tex,
        0,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return f;
    };
    this.fboA = mkFbo(this.blurTexA);
    this.fboB = mkFbo(this.blurTexB);

    this.u = {
      u_src: gl.getUniformLocation(this.program, "u_src"),
      u_disp: gl.getUniformLocation(this.program, "u_disp"),
      u_blurred: gl.getUniformLocation(this.program, "u_blurred"),
      u_active: gl.getUniformLocation(this.program, "u_active"),
      u_hasBlur: gl.getUniformLocation(this.program, "u_hasBlur"),
      u_frost: gl.getUniformLocation(this.program, "u_frost"),
      u_lensOrigin: gl.getUniformLocation(this.program, "u_lensOrigin"),
      u_lensSize: gl.getUniformLocation(this.program, "u_lensSize"),
      u_scale: gl.getUniformLocation(this.program, "u_scale"),
      u_chroma: gl.getUniformLocation(this.program, "u_chroma"),
      u_specStrength: gl.getUniformLocation(this.program, "u_specStrength"),
      u_colorPickup: gl.getUniformLocation(this.program, "u_colorPickup"),
      u_pickupOffset: gl.getUniformLocation(this.program, "u_pickupOffset"),
      u_pickupSoftness: gl.getUniformLocation(this.program, "u_pickupSoftness"),
      u_isDark: gl.getUniformLocation(this.program, "u_isDark"),
    };
    gl.uniform1i(this.u.u_src, 0);
    gl.uniform1i(this.u.u_disp, 1);
    gl.uniform1i(this.u.u_blurred, 2);

    gl.useProgram(this.blurProgram);
    this.bu = {
      u_source: gl.getUniformLocation(this.blurProgram, "u_source"),
      u_dir: gl.getUniformLocation(this.blurProgram, "u_dir"),
      u_premul: gl.getUniformLocation(this.blurProgram, "u_premul"),
    };
    gl.uniform1i(this.bu.u_source, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  setDisplacementMap(src) {
    const gl = this.gl;
    if (!src) {
      this.dispReady = false;
      return;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.dispReady = true;
  }

  ensureBlurSize(w, h) {
    if (w === this.blurW && h === this.blurH) return;
    this.blurW = w;
    this.blurH = h;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    for (const t of [this.blurTexA, this.blurTexB]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        w,
        h,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    }
  }

  blurPass(fbo, tex, dx, dy, premul) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform2f(this.bu.u_dir, dx, dy);
    gl.uniform1f(this.bu.u_premul, premul);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  uploadSource(canvas) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    if (canvas.width !== this.srcSize.w || canvas.height !== this.srcSize.h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      this.srcSize.w = canvas.width;
      this.srcSize.h = canvas.height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }
  }

  render(sourceCanvas, lens) {
    const gl = this.gl;
    const a = gl.drawingBufferWidth;
    const s = gl.drawingBufferHeight;
    this.uploadSource(sourceCanvas);

    const active = lens && this.dispReady ? 1 : 0;
    const hasBlur = !!(active && lens && lens.blur > 0.01);

    if (hasBlur && lens) {
      const bw = Math.max(1, a >> 1);
      const bh = Math.max(1, s >> 1);
      this.ensureBlurSize(bw, bh);
      const i = lens.blur / 2;
      gl.useProgram(this.blurProgram);
      gl.viewport(0, 0, bw, bh);
      this.blurPass(this.fboA, this.srcTex, i / a, 0, 1);
      this.blurPass(this.fboB, this.blurTexA, 0, i / s, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    gl.useProgram(this.program);
    gl.viewport(0, 0, a, s);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, hasBlur ? this.blurTexB : this.srcTex);
    gl.uniform1i(this.u.u_active, active);
    gl.uniform1f(this.u.u_hasBlur, hasBlur ? 1 : 0);
    gl.uniform1f(this.u.u_frost, lens?.frost || 0);
    if (active && lens) {
      gl.uniform2f(this.u.u_lensOrigin, lens.originX, lens.originY);
      gl.uniform2f(this.u.u_lensSize, lens.sizeX, lens.sizeY);
      gl.uniform2f(this.u.u_scale, lens.scaleX, lens.scaleY);
      gl.uniform1f(this.u.u_chroma, lens.chroma);
      gl.uniform1f(this.u.u_specStrength, lens.specStrength || 0);
      gl.uniform1f(this.u.u_colorPickup, lens.colorPickup || 0);
      gl.uniform2f(
        this.u.u_pickupOffset,
        (lens.pickupOffset && lens.pickupOffset[0]) || 0,
        (lens.pickupOffset && lens.pickupOffset[1]) || 0,
      );
      gl.uniform1f(this.u.u_pickupSoftness, lens.pickupSoftness || 0);
      gl.uniform1f(this.u.u_isDark, lens.isDark ? 1 : 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
