# Glass for Web

A small static demo of an Aave/Apple-style glass refraction effect using the
**live-DOM SVG filter path**: a generated displacement map is fed into
`feImage`, then used by `feDisplacementMap` to refract DOM content inside a
rounded, draggable lens.

The current implementation is intentionally not a canvas/WebGL main renderer.
The visible glass lens in `index.html` is a DOM layer filtered through SVG, so it
is much closer to the architecture described in Aave's “Building Glass for the
Web” article.

## Live demo

GitHub Pages is configured from the repository root:

```text
https://isaiahdahl.github.io/glass-for-web/
```

## Local run

```bash
./serve.sh
# open http://127.0.0.1:8129/index.html
```

No build step is required. The project is plain HTML, CSS, and JavaScript
modules.

## What it demonstrates

- Procedural rounded-rectangle displacement map generation.
- Live DOM refraction through SVG:
  - `feImage` loads the generated map.
  - `feDisplacementMap` bends `SourceGraphic` from the map's R/G channels.
  - Three displacement passes are recombined for chromatic splitting.
- A clipped live-DOM lens overlay rather than a WebGL/canvas texture.
- Safari-style filter-id cache busting when the map changes.
- Frost as a separate material/opacity veil.
- Specular highlights driven by the displacement map's blue channel.
- Directional Color Pickup layered from nearby scene color onto the specular
  highlight.
- Dark/light theme tuning for different frost behavior.

## Files

| File | Role |
|------|------|
| `index.html` | Static page, SVG filter definitions, layout, styling, controls |
| `app.js` | UI state, drag handling, DOM scene construction, SVG filter updates, map regeneration |
| `glass.js` | Reverse-engineered displacement map generator; older WebGL renderer code remains for reference/fallback experiments |
| `serve.sh` | Simple local static server |
| `.nojekyll` | GitHub Pages static-file passthrough |

## Implementation note

The map generator is the reverse-engineered Aave displacement-map math. The main
left-panel rendering path now follows the article's DOM/SVG strategy instead of
bending a canvas texture with WebGL. The WebGL renderer code still exists in
`glass.js` for reference, but `app.js` no longer imports or uses it for the demo.
