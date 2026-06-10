# Glass for Web

A small static demo of an Aave/Apple-style glass refraction effect using the
**live-DOM SVG filter path**: a generated displacement map is fed into
`feImage`, then used by `feDisplacementMap` to refract DOM content inside a
rounded, draggable lens.

The visible glass lens is a DOM layer filtered through SVG. It is not rendered
with a GPU/canvas shader.

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
- A clipped live-DOM lens overlay.
- Safari/WebKit filter cache busting:
  - Safari can cache filtered output by filter ID;
  - on Safari-like browsers the filter gets a fresh ID on every render/move so
    dragging repaints instead of freezing.
- Frost as a separate material/opacity veil.
- Specular highlights driven by the displacement map's blue channel.
- Directional Color Pickup:
  - the SVG filter offsets the actual full-stage `SourceGraphic`, masks it with
    the map's blue specular channel, then blends it into the lens;
  - nearby/underlying source colors therefore tint the specular highlight.
- Dark/light theme tuning for different frost behavior.

## Files

| File | Role |
|------|------|
| `index.html` | Static page, SVG filter definitions, layout, styling, controls |
| `app.js` | UI state, drag handling, DOM scene construction, SVG filter updates, map regeneration |
| `glass.js` | Reverse-engineered displacement map generator |
| `serve.sh` | Simple local static server |
| `.nojekyll` | GitHub Pages static-file passthrough |

## Implementation note

The map generator is the reverse-engineered displacement-map math. The main
left-panel rendering path follows the DOM/SVG strategy: `feImage` supplies the
map, `feDisplacementMap` refracts the live `SourceGraphic`, and the result is
clipped to the moving lens region.
