# Autoresearch: EXACT Aave parity in Safari/WebKit (no color pickup)

## Objective

Rebuild our glass demo so it is a **pixel-faithful clone of Aave's
DisplacementMapPlayground**, especially in **Safari/WebKit**, by mirroring
their reverse-engineered scripts exactly. Strip out everything we added
(color pickup, frost, specular sliders) for now — get exact parity on their
core algorithm first, then re-add color pickup later on top.

Ground truth = Aave's live page:
<https://aave.com/design/building-glass-for-the-web> — the interactive
"On the left is the refracted result..." playground. Their bundle is saved,
pretty-printed, at `.auto/refs/aave-glass.pretty.js` (map baker + AaveGlass
component) and `.auto/refs/25ef42f3c325a091.js` (playground component `S`,
defaults, and a WebGL renderer they use elsewhere).

We want: same background images (already byte-identical), same lens shape,
same sizing, same defaults, same slider ranges, same shadow, same filter
graph — so the WebKit render matches theirs.

## Hard constraints
- **No WebGL** in our path (SVG filters only). (Aave's bundle *has* a WebGL
  renderer `_` in chunk 25ef42f3, but their on-page glass uses the SVG path.)
- Keep the playground interactive.
- Color pickup is removed for now; will be re-added after parity.

## Exact Aave playground defaults (from `25ef42f3c325a091.js`, component `S`)
```
Width 70        (slider 20..120 step 1)
Height 60       (slider 20..80  step 1)
BorderRadius 28 (slider 0..64   step 1)
Scale 0.1       (slider 0..0.2  step 0.001)   scaleX=scaleY=scale
Depth 10        (slider 5..60   step 1)
Curvature 40    (slider 0..80   step 1)       -> domeDepth
Splay 1         (slider 0..1    step 0.01)
Chroma 0.2      (slider 0..1    step 0.01)
Blur 0          (slider 0..2    step 0.25)     <-- NOTE range 0..2, not 0..12
Glow 0.1        (slider 0..1    step 0.01)
Edge Highlight 0.25 (slider 0..1 step 0.01)
Specular Angle 45   (slider 0..180 step 1)
mapSize 512
sdfBoundary true, edgeFalloff true
edgeShadow: "0 0 0 1px var(--bg-max), 0 8px 24px rgba(0, 0, 0, 0.4)"
```
No Frost / Specular / ColorPickup / Pickup* sliders — those were ours.

## Aave's map baker (function `o()` at top of aave-glass.pretty.js)
Matches our `glass.js` math EXACTLY (same SDF, domeGradient, splay, erf edge
falloff, specular) WITH ONE CRITICAL DIFFERENCE:

  **Every pixel ends with `data[t+3] = 255`.** Outside the lens they write
  RGB = (128,128,128) and alpha = 255 — fully OPAQUE GRAY. They do NOT use a
  transparent edge.

Our `glass.js` currently writes alpha = 0 outside the lens. On WebKit this
makes `feImage` sample premultiplied RGB toward 0 at the silhouette
(gray fades to black as alpha drops), which `feDisplacementMap` reads as a
big displacement — producing the dark rim we kept fighting with clip-path and
final-blur hacks. **Matching alpha=255 everywhere should fix the rim at the
source.**

They also bake in 64-row chunks with `await setTimeout(0)` between chunks
(non-blocking); cosmetic, not needed for parity.

## Aave's filter graph (function `tX`, aave-glass.pretty.js ~line 1810)
Key structural points to mirror:
- `filterUnits = primitiveUnits = (multiSlot || isSafari) ? "userSpaceOnUse"
  : "objectBoundingBox"`. **They switch to userSpaceOnUse on Safari.**
  In USS they insert a `feColorMatrix` (`scaledMap`) that rescales the map's
  R/G channels via helper `y(sx,sy)` (line 365):
  `${sx} 0 0 0 ${0.5*(1-sx)}  0 ${sy} 0 0 ${0.5*(1-sy)}  0 0 1 0 0  0 0 0 1 0`
- feFlood rgb(128,128,128) -> mapBg
- feImage href=mapUrl preserveAspectRatio=none -> rawMap
- feComposite rawMap over mapBg -> map
- (chroma>0) three feDisplacementMaps at scale*(1+0.2c), *(1+0.1c), *1 with
  R/G/B colour-matrix splits recombined via arithmetic feComposite -> lensResult
  (chroma==0) single feDisplacementMap -> lensResult
- specular: light path = feColorMatrix(map, drive alpha from B) -> specMask;
  feComposite(specMask over lensResult, arithmetic k2=specularStrength k3=1)
  Safari uses `in=rawMap` for that colour matrix instead of `map`.
- **HOLE-AND-FILL**: feFlood black -> lensMask; feComposite(SourceGraphic out
  lensMask) -> holedSG; feComposite(lensResult over holedSG). i.e. the filter
  runs on the WHOLE source and paints the lens into a cut hole. Lens position
  is set by feImage x/y/width/height, not by moving a separate div.

## Metric (NEW — direct Aave comparison)
`./.auto/measure.sh` now does an **our-WebKit vs Aave-WebKit** comparison:
- Render OUR demo in Playwright WebKit at the default lens (centered, light),
  screenshot `#stage`.
- Load AAVE's page in the SAME WebKit, scroll their playground into view,
  screenshot their stage (left panel) at default lens.
- Normalize to the same size, diff with pixelmatch.
- Primary metric: `aave_webkit_diff_pct` (lower is better).
- Also keep our internal `chromium_vs_webkit` parity as a secondary guard.
- Secondary: `aave_webkit_diff_pct_dark`, render times.

Aave's stage pixel size may differ from ours; the harness resizes both to a
common box before diffing. We compare at the shared default state so the
underlying content (same bg image, same lens params) lines up.

## Files in scope
- `index.html` — filter graph + layout + styles + defaults
- `app.js` — state, slider defs, filter updates, scene
- `glass.js` — map baker (match Aave's `o()` exactly, alpha=255 everywhere)

## BREAKTHROUGH (exact-parity phase)

The big Safari bug was architectural. Two fixes nailed it:

1. **Harness was comparing against a NON-refracting Aave reference.** Aave's
   playground only applies its displacement filter after a pointer interaction
   moves the lens; a static headless load shows a bare lens. `captureAave` now
   drags the lens and returns it to centre before screenshotting. Without this
   we were optimising toward a blank reference.

2. **Apply the SVG filter to the FULL-STAGE scene, not a lens-sized layer.**
   WebKit derives a filter's objectBoundingBox from the filtered element's own
   bbox. Our old lens layer contained the full stage as an overflowing child,
   so WebKit scaled all objectBoundingBox primitive coords by ~2.4x and
   anchored top-left -> the "scaled 2x, pinned, cut off" refraction the user
   reported. Now the filter lives on the full-stage `scene`, `feImage` is
   positioned at the lens sub-region (stage-fraction x/y/width/height), and
   `feDisplacementMap scale` is relative to the stage (= Aave). This both
   fixes the scale/anchor bug AND gives the strong edge refraction.

Result: our-WebKit vs Aave-WebKit = 0.40% (from 1.15%); our Chromium vs our
WebKit = 0.067%. Refraction pattern (edge-curving vertical dashes) matches
Aave in both light and dark.

Metric note: pixelmatch threshold matters — 0.12 was blind to the low-contrast
refracted dashes. Use <=0.06 when judging refraction pattern.

## What's been tried (cross-browser phase, on master)
Cross-browser (our-Chrome vs our-WebKit) parity got worst-case pixel_diff from
1.14% to 0.36% via: clip-path inset rounded on lensLayer, Safari-only final
feGaussianBlur, minimum-kernel feMapBlur. Those were *patches*. This phase
replaces them with Aave's actual technique (opaque map + hole-and-fill +
userSpaceOnUse-on-Safari) for true parity, then we can drop the patches.

## Loop discipline
- Primary = `aave_webkit_diff_pct`. Lower is better.
- Don't break Chromium (watch `chromium_vs_webkit`).
- Visual-check `.auto/shots/aave_webkit.png` vs `.auto/shots/our_webkit.png`
  every keep — the metric can be fooled by global tint shifts.
- ASI: record which Aave technique you mirrored + the visual result.
