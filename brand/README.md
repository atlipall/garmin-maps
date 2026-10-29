# Varda's logo

A map pin holding a cairn: a *varða* is the pile of stones that marks a route across Iceland's
highlands. Chosen 30 October 2026 (option 4c of the logo canvas,
claude.ai/artifact/VmyrLiyh1cgd3vfEMRXfLx).

The logo and the name are not covered by the code's MIT License (see `LICENSE`): a copy or fork of the
app should get its own name and icon.

| File | What it is | Use it for |
|---|---|---|
| `varda-icon.svg` | The app icon, rounded corners | The logo anywhere it stands alone: the guide, the browser tab, documents |
| `varda-icon-square.svg` | The same without rounded corners | Platforms that round icons themselves (iPhone Home Screen, the web app's icons) |
| `varda-icon-maskable.svg` | The pin at 80%, full-bleed cream | Android's maskable icon: stays inside the safe circle whatever shape the launcher cuts |
| `varda-mark.svg` | The pin alone, the stones cut out (see-through) | Next to the wordmark, on maps or photos; recolour with its `fill` |

## Colours

| | Hex | |
|---|---|---|
| Moss | `#3d6b50` | The pin |
| Cream | `#f4efe2` | The background and the stones |
| Deep moss | `#2f5741` | The wordmark (passes 4.5:1 on white and on cream) |

The app's own interface keeps its blue (`--accent #1d3f8f` in `web/index.html`).

## Wordmark

"Varda" in **Bricolage Grotesque** Bold (700), letter spacing −0.02em, deep moss; free on Google
Fonts (SIL Open Font License). Set it as text rather than an image: no SVG of the wordmark is kept,
because it would need the font's outlines.

## The app's icons

The PNGs are drawn from these files, never edited by hand:

```bash
cd web && npm run icons
```

It writes `web/public/icons/` (`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`,
`apple-touch-icon.png`, `favicon.svg`) and the Android app's `mipmap-xxhdpi`/`mipmap-xxxhdpi`
launcher PNGs. The Android adaptive icon (`android/app/src/main/res/drawable/ic_launcher_foreground.xml`)
is the same drawing as a vector; change it by hand if the pin's shape changes.
