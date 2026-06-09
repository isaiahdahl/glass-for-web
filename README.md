# Glass for Web

A small static WebGL demo exploring a draggable glass/refraction effect for the
web. The page renders a rounded glass lens, a procedural background, a live
procedural displacement map, and controls for tuning refraction, chroma, blur,
frost, specular highlights, and color pickup.

This project is an educational/prototyping demo. It is not affiliated with,
endorsed by, or using assets from Aave.

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

No build step is required. The project is plain HTML, CSS, JavaScript modules,
and WebGL2.

## What it demonstrates

- Procedural rounded-rectangle displacement map generation
- WebGL2 refraction using R/G displacement channels
- Chromatic channel splitting
- Blur as a separate source-filtering control
- Frost as a separate material/opacity control
- Specular highlights driven by the displacement map
- Directional Color Pickup, which stacks saturated nearby scene color onto the
  specular highlight
- Dark/light theme tuning for different frost behavior

## Files

| File | Role |
|------|------|
| `index.html` | Static page, layout, styling, controls |
| `app.js` | UI state, drag handling, procedural background, map regeneration |
| `glass.js` | Displacement map generator and WebGL renderer |
| `serve.sh` | Simple local static server |
| `.nojekyll` | GitHub Pages static-file passthrough |

## Notes

The demo intentionally uses a procedural background instead of third-party image
assets so the public repository can be published cleanly.
