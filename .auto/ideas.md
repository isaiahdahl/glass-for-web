# Ideas backlog — Safari/WebKit parity

(Prioritised top-down. Cross items off as we try them.)

1. **Adopt Aave's hole-and-fill composite** (the biggest structural change):
   apply the SVG filter to a container that includes the *full stage*, and let
   the filter cut a lens-shaped hole into SourceGraphic via
   `feFlood + feComposite operator=out`, then paste `lensResult` into the hole
   with `over`. Position the lens via the `feImage` `x/y/width/height` of the
   map, not via positioning a separate div. This is what makes Aave's lens
   immune to Safari's clip-path/transform/filter-region quirks.

2. **`filterUnits=userSpaceOnUse` on Safari** + add the `scaledMap`
   colorMatrix that rescales R/G channels to compensate for pixel units.
   Use the same helper math: `y(sx, sy)` from `aave-glass.pretty.js:365`.

3. **Replace `feGaussianBlur` blur on SourceGraphic with
   `-webkit-backdrop-filter: blur(N)`** on a separate stacked div. Aave does
   this — Safari's `feGaussianBlur` on a full-stage SourceGraphic is one of
   the things that goes wrong.

4. **Specular dark path**: in dark mode, switch to Aave's multiplicative
   specular (negative-B colorMatrix → arithmetic k1=1 k2=0). Our additive
   highlight may be the reason the lens looks washed out / invisible.

5. **`in=rawMap` (pre-composite-over-grey) for spec mask on Safari**: their
   code special-cases Safari to use `rawMap` instead of `map` for the spec
   colorMatrix input. Possibly because the over-grey composite tints the blue
   channel.

6. **Inspect WebKit's parsed filter DOM** mid-run:
   `page.evaluate(() => document.querySelector('filter').outerHTML)` and save
   per-iteration. If Safari is dropping primitives silently, we'll see it.

7. **Try `feImage href=` (no `xlink:href`) only** on Safari — newer WebKit
   prefers plain `href`. We already set both; harmless but verify.

8. **Filter region `x="-10%" y="-10%" width="120%" height="120%"`** —
   Safari clamps output to the region; if the displacement pushes a pixel
   outside the default 0..1 region, it gets clipped.

9. **`color-interpolation-filters="sRGB"`** is already set; double-check
   Safari isn't falling back to linearRGB which would shift gamma and dim the
   result.

10. **Render the displacement map straight from a `<canvas>` via `data: URL`
    on Safari** — sometimes Safari's `feImage` decoder gets stuck on
    PNG decoding timing. Could re-bake on a `<feImage href="data:image/svg+xml;...">`
    using SVG primitives instead.

11. **`will-change: filter`** on the filtered container (Aave does this on
    their inner div). Promotes to its own layer and may avoid Safari's
    stale-paint caching.

12. **Aave's helper `y(sx, sy)` for scaledMap matrix**:
    ```
    [sx   0   0  0  0.5*(1-sx)
     0   sy   0  0  0.5*(1-sy)
     0    0   1  0   0
     0    0   0  1   0]
    ```
    Where `sx = lensW_userSpace / 1.0`, etc — we need to compute the right
    sx/sy. Read the body around line 1700–1800 in
    `aave-glass.pretty.js` to find how `tO` is constructed.

13. **Group children of `Glass` in a `g` with the filter, not the outer div**
    — try applying `filter` to an SVG `<g>` wrapping a `<foreignObject>` of
    the live DOM. Slower path, but worth measuring if 1–11 fail.
