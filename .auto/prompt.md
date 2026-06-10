# Autoresearch: Safari/WebKit parity for the SVG glass refraction

## Objective

We have a working SVG-filter-based "liquid glass" lens in `index.html` / `app.js` /
`glass.js`. **Chromium renders it correctly** (soft Aave-style glass: rounded
lens with a faint refractive shape and the grid bending behind it).
**WebKit/Safari renders it WRONG**: instead of refracting the underlying grid,
the lens shows the unrefracted dashes from the source DOM piercing straight
through the rounded shape as if the displacement map had no effect on the
shape boundary. The corners aren't masking the grid; the grid is bleeding
through the rounded silhouette.

Visually:
- Chromium = lens looks like a subtle pane of glass with soft refraction +
  drop shadow (matches Aave's site at <https://aave.com/design/building-glass-for-the-web>).
- WebKit = dashed grid lines pierce through the rounded rect as sharp
  un-refracted strokes; the lens silhouette is barely there and the
  displacement map is producing hard-edged garbage instead of smooth bending.

Aave's production implementation renders identically across Chrome, Safari,
and Firefox. We reverse-engineered their bundle (saved at
`.auto/refs/aave-glass.pretty.js`) and need to bring Safari to parity.

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

- **Primary**: `pixel_diff_pct` — % of pixels that differ between Chromium
  and WebKit renders of the same scenario (pixelmatch, threshold 0.1), median
  across 3 scenarios. Lower is better. **This is the right metric for this
  problem**: Chromium is the ground truth (matches Aave's site), and we want
  WebKit to converge on it.
- Secondary:
  - `chromium_lens_contrast`: stddev of luminance in the lens center crop on
    Chromium — sanity check Chromium hasn't drifted.
  - `webkit_lens_contrast`: same on WebKit. **Do NOT** treat high contrast as
    good — the broken WebKit lens has *high* stddev because of unrefracted
    sharp dashes piercing through. Useful only for detecting the "lens
    blank" mode (contrast near 0).
  - `lens_region_diff_pct`: pixel diff restricted to the lens bounding box
    only. More sensitive than `pixel_diff_pct` (which averages across the
    whole stage including identical background).
  - `webkit_render_ms`, `chromium_render_ms`: time to ready+paint.
  - Per-scenario `scn_*_diff` lines for the dashboard.

A run is a "win" if `pixel_diff_pct` drops AND `chromium_lens_contrast` stays
within 10% of baseline (don't fix Safari by breaking Chrome).

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

(Newest at top.)

- **WORKED**: `feGaussianBlur stdDeviation=0.25/W` as a *final* stage on the
  filter (`feFinalBlur`), Safari-only. WebKit's compositor applies less
  sub-pixel AA than Chromium's; this final blur matches Chromium's softness
  without destroying the refraction. Worst-case pixel_diff_pct 0.98 -> 0.36.
  (Any non-zero stdDev triggers the same minimum kernel — 0.0, 0.2, 0.35
  all give identical output.)

- **WORKED**: Drop the Safari-only pre-blur on SourceGraphic. With clip-path
  in place the pre-blur did more harm than good (killed light-theme dashes).
  Worst-case 5.04 -> 0.98.

- **WORKED**: `clip-path: inset(0 round Npx)` on `.lensLayer` (Safari and
  Chrome). WebKit doesn't clip filter output through `overflow:hidden +
  border-radius`; the filter writes outside the rounded silhouette,
  producing a hard dark rim where displacement pulls samples from outside
  the bbox. Worst-case 5.04 -> 3.21 on light_center; 0.41 -> 0.37 overall.

- **WORKED**: Soft `feGaussianBlur` on the displacement map after `feImage`.
  Started 0.0015 (-2.5%), bumped to 0.005 (-5%), bumped to 0.015 (-2% more).

- **NOT HELPFUL**: Anti-aliasing the alpha edge of the map in `glass.js`
  (ramp 255->0 over 2 pixels). The hard rim was from displacement at the
  silhouette, not the alpha discontinuity — clip-path made the difference.

- **NOT HELPFUL**: Safari-only `state.scale * 0.88` displacement
  compensation. WebKit's overshoot at small `scale` values was noise.

- **REGRESSED**: Rounding lens position to integer pixels. Both browsers
  ended up at same integer but the grid behind diverged at sub-pixel
  positions and re-aligning broke parity.

- **NOT HELPFUL**: Setting `box-shadow: none` on `.lensOutline`. The dark
  rim was coming from the SVG filter itself, not the box-shadow.

- **NOT HELPFUL**: Expanding the SVG filter region to `-0.2..1.4`.

- **NOT HELPFUL**: Resizing the `<svg class="svgDefs">` to `width:100% height:100%`
  with `viewBox="0 0 0 0"` (matching Aave's structure). Same metric.

- (baseline) `objectBoundingBox` everywhere, lens as a separately positioned
  `.lensLayer` with `clip-path: none` and `filter: url(#glassSvgFilter)`.
  Safari showed a hard dark rim around the lens with sharp piercing dashes.
  Worst-case pixel_diff_pct ~1.14, light_center the worst.

## Current state of the metric

- worst-case `pixel_diff_pct`: 0.36 (was 1.14)
- `edge_ratio` ~ 0.77 (slightly below the 0.8 threshold, hence a small
  `parity_score` penalty of ~0.15)
- All three scenarios under 0.4% diff
- Aave cross-browser diff (their site): ~3.6% (theirs differs on lens position
  between browser sessions — not directly comparable)

## Ideas backlog (also in `.auto/ideas.md`)

Remaining (untried):
- Adopt Aave's hole-and-fill compositing (apply filter to whole stage with
  feFlood/feComposite operator=out cut, instead of positioning a lens div).
  Big restructure but probably closes the remaining 0.36% gap.
- Switch `filterUnits`/`primitiveUnits` to `userSpaceOnUse` on Safari + add
  the `feColorMatrix scaledMap` to compensate. Aave does this explicitly.
- Try the `specularDark` path for dark mode (multiplicative instead of
  additive with the negative-B colorMatrix). Aave's dark-mode branch.
- `in=rawMap` instead of `in=map` for the spec mask on Safari (Aave does
  this in `aave-glass.pretty.js` line 1945).
- Use `-webkit-backdrop-filter: blur(N)` on a separate div for the blur
  slider, instead of `feGaussianBlur` on SourceGraphic. The slider would
  feel more native and the blur values would match between browsers.

## Loop discipline

- Primary metric drops with `webkit_lens_contrast` staying high → **keep**.
- WebKit metric improves but Chrome regresses → discard.
- WebKit shows the lens but it's the wrong shape → secondary diagnostics in
  `webkit_lens_contrast` won't catch that; look at `.auto/shots/diff_*.png`.
- ASI: record what filter graph change you tried, exactly which Aave technique
  you adopted, and what the WebKit screenshot looked like at a high level.
