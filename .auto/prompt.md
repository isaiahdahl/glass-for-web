# Autoresearch: Safari/WebKit parity for the SVG glass refraction

## Objective

We have a working SVG-filter-based "liquid glass" lens in `index.html` / `app.js` /
`glass.js`. **Chromium renders it correctly**; **Safari/WebKit renders it dim,
nearly transparent, with no visible refraction** — see the first screenshot the
user provided. Aave's production implementation
(<https://aave.com/design/building-glass-for-the-web>) renders identically in
Chrome, Safari, and Firefox. We reverse-engineered their bundle (saved at
`.auto/refs/aave-glass.pretty.js`) and we need to bring Safari to parity, ideally
matching the *Aave* render where Chrome diverges.

Constraints (hard):
- **No WebGL.** Stay on SVG filters + (optionally) `backdrop-filter`.
- Keep the existing slider-driven playground UX in `index.html` working.
- Map generator math in `glass.js` is the reverse-engineered Aave algorithm and
  is known-good — don't rewrite it casually.
- No new heavy deps in production code. Dev deps under `.auto/tools/` are fine.

## Metrics

Captured by `./.auto/measure.sh` for a fixed set of scenarios in BOTH
Chromium and WebKit at a fixed viewport. All emitted as `METRIC name=value`
lines. Median over 3 captures per scenario where noted.

- **Primary**: `safari_parity_score` — *combined* score (lower is better) made
  of pixel-diff between Chromium and WebKit renders + a penalty when the
  WebKit lens has no contrast (the "lens went blank" failure mode). Computed
  as `pixel_diff_pct + max(0, 8 - webkit_lens_contrast) * 2`.
- Secondary:
  - `webkit_lens_contrast`: stddev of luminance in the lens center crop on
    WebKit. **Must be roughly >= chromium_lens_contrast.** If this drops near
    zero the lens disappeared in Safari.
  - `chromium_lens_contrast`: same metric on Chromium — sanity check we
    haven't broken Chrome.
  - `pixel_diff_pct`: % pixels exceeding threshold between Chromium and WebKit
    in the stage crop (pixelmatch with threshold 0.1).
  - `webkit_render_ms`, `chromium_render_ms`: time to ready+paint.
  - `webkit_has_filter_output`: 1 if the WebKit screenshot has any
    nontrivial color variation in the lens region, 0 otherwise.

A run is a "win" if `safari_parity_score` drops AND `chromium_lens_contrast`
stays within 10% of baseline (we don't want to fix Safari by breaking Chrome).

## How to run

```bash
./.auto/measure.sh
```

This script:
1. Starts a local static server on `127.0.0.1:8132` if not already up.
2. Launches Playwright Chromium + WebKit, navigates to the demo, sets a
   deterministic state via `window.__glass.set(...)`, screenshots the `.stage`
   element for 3 scenarios (dark@(0.35,0.45), dark@(0.5,0.5), light@(0.5,0.5)).
3. Computes per-scenario `pixel_diff_pct` and `*_lens_contrast`, then medians
   the timings and aggregates the primary metric.

Per-scenario PNGs and diff images go to `.auto/shots/` (gitignored).

## Files in scope

- `index.html` — SVG filter definitions, layout, styles. Filter graph lives in
  `<filter id="glassSvgFilter">`.
- `app.js` — UI state, filter primitive updates, render loop, Safari detection
  + filter-ID cycling, scene construction.
- `glass.js` — displacement-map baker (R/G refraction direction, B specular).
  Treat as mostly fixed.

## Off limits

- The map baker math in `glass.js` (the dome / SDF / splay code). Tweaking
  encoding *outputs* is fine; reworking the SDF math is out of scope.
- `assets/`, `serve.sh`, `.nojekyll`.

## Reference: Aave's actual technique (from `.auto/refs/aave-glass.pretty.js`)

The bundle at `504982d42d3368e6.js` (pretty-printed in `aave-glass.pretty.js`)
contains the React component. Key findings — **these are the things our Safari
path likely needs to mirror**:

### Filter graph (around lines 1810–1955 of `aave-glass.pretty.js`)

```
filterUnits = (multiSlot || isSafari) ? "userSpaceOnUse" : "objectBoundingBox"
primitiveUnits = same
```

Note the explicit branch: **they switch to `userSpaceOnUse` on Safari** in the
multi-lens path. Our code uses `objectBoundingBox` everywhere.

```
feFlood "rgb(128,128,128)" → mapBg
feImage data-lens href=mapUrl preserveAspectRatio=none → rawMap
feComposite rawMap over mapBg → map
(if userSpaceOnUse) feColorMatrix in=map values=tO → scaledMap
                   ↑ this normalizes the displacement scale because USS uses
                     pixel units instead of [0..1]. tO matrix is built by
                     helper `y(sx, sy)` at line 365:
                     y = (e, t) => `${e} 0 0 0 ${0.5*(1-e)}  0 ${t} 0 0 ${0.5*(1-t)}  0 0 1 0 0  0 0 0 1 0`
                     i.e. it rescales R and G channels with a centered remap.

(if blur) feGaussianBlur in=SourceGraphic stdDeviation="bx/lensW by/lensH" → blurred

(if chroma > 0):
  feDisplacementMap in=blurred  in2=scaledMap scale=tL*(1+0.2*ca) RG → temp
  feColorMatrix → keep R only (dispR)
  feDisplacementMap scale=tL*(1+0.1*ca) → temp
  feColorMatrix → keep G only (dispG)
  feDisplacementMap scale=tL → temp
  feColorMatrix → keep B only (dispB)
  feComposite arithmetic 0 1 1 0 (R+G) → temp
  feComposite arithmetic 0 1 1 0 (RG+B) → lensResult
else:
  feDisplacementMap scale=tL → lensResult

# Specular branch — TWO completely different paths
if specularDark:
  feColorMatrix in=map → specMask  (NEGATIVE coefficient on B channel:
    `0 0 -S 0 (1 + 128S/255)`  rows R,G,B; alpha row `0 0 0 0 1`)
  feComposite in=specMask in2=lensResult arithmetic k1=1 k2=0 k3=0 k4=0 → lensResult
  # i.e. lensResult *= specMask (multiplicative darkening from the spec map)
else (default, light):
  feColorMatrix in=(isSafari ? rawMap : map) → specMask  values:
    "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 -128/255"
    # this drives ALPHA from the blue channel of the map
  feComposite in=specMask in2=lensResult arithmetic k1=0 k2=specStr k3=1 k4=0 → lensResult
  # i.e. lensResult = lensResult + specStr * specMask  (additive highlight)

# THE HOLE TRICK — this is the big one we don't do
feFlood floodColor=black floodOpacity=1 → lensMask
feComposite in=SourceGraphic in2=lensMask operator=out → holedSG
  # holedSG = SourceGraphic with a hole where the lens is
feComposite in=lensResult in2=holedSG operator=over → final
  # final = SourceGraphic-with-hole, with lensResult painted into the hole
```

This means **Aave's filter is applied to the whole SourceGraphic (the page
content), not to a separately positioned lens layer.** The lens is positioned
purely by where `feImage`'s `x/y/width/height` puts the displacement map. That
sidesteps every Safari clip-path/positioning bug in one move.

### The container DOM (lines 2000+)

```
<div data-aave-glass-container>
  <div style="will-change:filter">   ← gets the filter applied
    {children}                       ← real DOM content
  </div>
  <div style="position:absolute;inset:0;pointerEvents:none;
              willChange:filter, clip-path;
              background: var(--body-bg)">
    {overlay}                        ← the refractionTarget copy
  </div>
  <div style="...backdrop-filter: blur(N) | -webkit-backdrop-filter">
    ← native backdrop-filter blur layer, separate from SVG
  </div>
  <div ...box-shadow for outline/shadow>
</div>
```

Key: **they use `-webkit-backdrop-filter` for the blur** rather than trying to
get `feGaussianBlur` looking right on Safari. The SVG filter is only doing
refraction + specular.

### Safari detection (lines 254–260)
```js
ea(/^((?!chrome|chromium|android).)*safari/i.test(navigator.userAgent))
```
And iOS:
```js
ei(/iPad|iPhone|iPod/.test(ua) || (platform==="MacIntel" && maxTouchPoints>1))
```
Our `isSafariLike` check is similar; reuse it to gate the new paths.

### Map encoding helper `y(sx, sy)` at line 365
For USS, they remap the R and G channels of the map by `sx`/`sy`:
`y = (sx, sy) => "${sx} 0 0 0 ${0.5*(1-sx)}  0 ${sy} 0 0 ${0.5*(1-sy)}  0 0 1 0 0  0 0 0 1 0"`
This is how they keep displacement magnitudes correct when filterUnits is
pixel-based: you can't change `scale` past the SVG spec's clamp, so they
pre-scale the map's R/G channels.

### Filter ID cycling (we already do this; see line 1382 in their code) — they
do the same thing, refreshing `href` and re-setting filter id when the URL
changes.

## What's been tried

(append here as you go — *with* approach + outcome + why it failed)

- (baseline) `objectBoundingBox` everywhere, lens as a separately positioned
  `.lensLayer` with `clip-path: none` and `filter: url(#glassSvgFilter)`.
  Safari shows the lens as nearly transparent / no refraction visible.

## Ideas backlog (also in `.auto/ideas.md`)

- Adopt Aave's hole-and-fill compositing (apply filter to whole stage with
  feFlood/feComposite operator=out cut, instead of positioning a lens div).
- Switch `filterUnits`/`primitiveUnits` to `userSpaceOnUse` on Safari + add
  the `feColorMatrix scaledMap` to compensate.
- Replace `feGaussianBlur` on SourceGraphic with `-webkit-backdrop-filter`
  on a separate div.
- Try the `specularDark` path for dark mode (multiplicative instead of additive
  with the negative-B colorMatrix).
- Inspect WebKit's actual `<filter>` DOM after render via Playwright
  (`page.evaluate(() => document.getElementById('glassSvgFilter').outerHTML)`)
  to verify our attributes survived parsing.

## Loop discipline

- Primary metric drops with `webkit_lens_contrast` staying high → **keep**.
- WebKit metric improves but Chrome regresses → discard.
- WebKit shows the lens but it's the wrong shape → secondary diagnostics in
  `webkit_lens_contrast` won't catch that; look at `.auto/shots/diff_*.png`.
- ASI: record what filter graph change you tried, exactly which Aave technique
  you adopted, and what the WebKit screenshot looked like at a high level.
