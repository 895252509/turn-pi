# Turn Pi — icon

Two colours, one grid: a solid red T, and upstream Pi in pure black at 28 % laid
straight on top of it.

```
layer 1  red T            layer 2  Pi, black 28 %     composite
. . . . .                 . ■ ■ ■ .                  R ■ ■ ■ .
. ■ . . .                 . ■ . ■ .                  . ■ . ■ .
. ■ ■ . .                 . ■ ■ . ■                  . ■ ■ . .
. ■ . . .                 . ■ . . ■                  . ■ . . .
```

`R` is the only cell with nothing over it — the T's left arm, pure red. That single
block keeps the letterform readable while Pi sits on top of the rest.

Open `preview.html` for the margin comparison, layers, resolved values, sizes, and
the red ladder.

## Margins: two files on purpose

The answer to "顶到边还是留边" is **both**, because the two jobs have opposite
constraints:

| File | Canvas | Margin | For |
|---|---|---|---|
| `turnpi-icon.svg` | 120 × 120 | **0 %** — flush left/right, 12 px top/bottom only to square it | Favicon, browser tab, inline beside a wordmark |
| `turnpi-tile.svg` | 144 × 144 | **8.3 %** (12 px = half a module) | App icon, dock, avatar, anything that gets a rounded mask |

Why not one file:

- **Favicons want flush.** At 16 px every pixel counts. An 8 % margin is 1.3 px of
  nothing on each side, and the blocks soften. Flush, the module lands at 3.2 px.
- **App icons want margin.** iOS and macOS clip roughly 12 % off each corner, Android
  adaptive icons clip more. A mark touching the edge loses the T's crossbar end and
  the Pi's leg to the mask.
- **8.3 % is the floor for the tile**, not a taste choice: it is half a module, the
  smallest margin that survives a squircle.

The cream in the tile will look like a white border on a page — that is the ground,
not padding. The ghost is black at 28 %, which needs something light to sit on.

## Inline size (the UI brand mark)

`web/src/components/BrandMark.tsx` uses the same geometry with
`viewBox="0 12 120 96"`. The 12 px bands top and bottom exist only to square the
shipped SVG for favicons; inline they are dead space, so the component drops them and
lets CSS define a **5:4** box.

The aspect ratio is not cosmetic. The mark is 5 modules wide but 4 tall. Put it in a
square box and the browser fits it by width, leaving 10 % empty above and below; each
module is then 1/5 of the box instead of upstream Pi's 1/4. Same nominal size, but
20 % thinner strokes — it reads smaller than Pi even when the boxes measure the same.

Rule of thumb: **width = 5/4 × the size upstream Pi would be drawn at.** If Pi would
be 19.2 px (module 4.8 px), the Turn Pi mark needs 24 px wide.

| Context | Box | Module |
|---|---|---|
| Sidebar / skills header (`.brand-mark`) | 24 × 19.2 | 4.8 px |
| Module rail (`.rail-nav-brand`) | 22 × 17.6 | 4.4 px |
| Settings → About (`.settings-about-mark`) | 36 × 36 raster tile | 7.2 px |

The About slot is the exception: it uses `web/public/brand-mark-128.png`, a 128 × 128
tile rendered from `turnpi-about.svg` (cream ground, glow left on), displayed at
36 × 36. The other two are inline SVG so the ghost can follow `currentColor`.

`turnpi-about.svg` is 128 × 128 and scales the mark to the full 128 px width; at
36 px the mark is **36 × 28.8**, not 28 × 22.4 as before.

The shipped files stay square: `turnpi-icon.svg` is 120 × 120 because a favicon canvas
has to be square. Only the inline component is cropped.

## Files

| File | Canvas | What |
|---|---|---|
| `turnpi-icon.svg` | 120 × 120 | **Primary, flush.** Red T + black ghost 28 %. |
| `turnpi-icon-inverse.svg` | 120 × 120 | Flush, ghost flipped to white 26 %. Dark grounds. |
| `turnpi-tile.svg` | 144 × 144 | Padded app tile, cream ground, black ghost 28 %. |
| `turnpi-about.svg` | 128 × 128 | About tile source: mark fills width, glow on, cream ground. |
| `turnpi-t.svg` | 120 × 120 | Layer 1 alone. Construction aid. |
| `turnpi-pi.svg` | 120 × 120 | Layer 2 alone. Construction aid. |
| `pi-reference.svg` | 120 × 120 | Upstream Pi, untouched. Reference only — do not ship. |
| `preview.html` | — | Margins, layers, values, sizes, red ladder. |

## Resolved values

| Cell | Layers | Light ground | Dark ground |
|---|---|---|---|
| `c0/r0` — left arm | red only | `#E8432B` | `#E8432B` |
| `c1–c2/r0` — crossbar | red + ghost | `#A7301F` | `#EE7462` |
| `c1/r1–r3` — stem | red + ghost | `#A7301F` | `#EE7462` |
| ghost past the T | ghost only | `#B8B8B8` | `#535457` |

Black on a dark ground does not exist, which is why `turnpi-icon-inverse.svg` flips
the ghost to white: black stains the paper, white lifts the ink. Same operation,
opposite direction.

## Glow

The red T is lit from below. Two scales, same chained-shadow idea:

| Where | Blur chain (`stdDeviation`) | Opacity |
|---|---|---|
| Splash, `turnpi-t.svg`, `turnpi-icon-glow.svg`, `turnpi-about.svg` | 2.5 / 7 / 14 | 100 / 80 / 50 % |
| Inline `BrandMark` (22–24 px) | 8 / 14 | 65 / 35 % |

The inline filter uses larger user units because the SVG is 120 units wide but
rendered at 22–24 px: 8 / 14 units lands at roughly 1.6 / 2.8 px. The large chain
uses the original 24-unit grid. Both chain the next pass with `in="core"` so the
alpha compounds instead of stacking independent shadows.

## Geometry

Module 24.

### `turnpi-icon.svg` — 120 × 120, origin (0, 12)

| Layer | Part | Cell(s) | x | y | w | h |
|---|---|---|---|---|---|---|
| red `#E8432B` | crossbar | c0–c2/r0 | 0 | 12 | 72 | 24 |
| red | stem | c1/r1–r3 | 24 | 36 | 24 | 72 |
| black 28 % | bar | c1–c3/r0 | 24 | 12 | 72 | 24 |
| black | descender | c3/r1 | 72 | 36 | 24 | 24 |
| black | leg | c1/r1–r3 | 24 | 36 | 24 | 72 |
| black | nub | c2/r2 | 48 | 60 | 24 | 24 |
| black | leg | c4/r2–r3 | 96 | 60 | 24 | 48 |

### `turnpi-tile.svg` — 144 × 144, origin (12, 24)

Same table with `x += 12`, `y += 12`, plus an `#F6F3EC` ground.

## Where the grid comes from

`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/pi-logo.js`
draws the logo with terminal half-blocks and states the pixel grid in its comment:

```
coral coral coral .
blue  .     coral .
blue  blue  .     yellow
blue  .     .     yellow
```

"4 cells wide and 2 lines tall" — each cell holds two pixels, so the grid is 4 × 4.
The shape is reproduced exactly; only its colour is dropped to black.

## Knobs

| Want | Change |
|---|---|
| Ghost more present | opacity 28 → 34 % |
| Ghost quieter | 28 → 22 % |
| Redder | `#E8432B` (hue 7.6°) → `#E8322A` (2.5°) |
| More orange | `#E8432B` → `#E2502B` (12°) |
| Orangest | `#E8432B` → `#EA5C2E` (15°) |

## Rules

1. **Do not offset the ghost.** The effect only works because the Pi lands exactly on
   the grid; a half-module shift turns it into a misprint.
2. **Do not add a third colour.**
3. **Keep `c0/r0` free of the ghost.** It is the only pure-red cell.
4. **Do not move or resize Pi's blocks.** The ghost must stay identical to upstream.
5. **Do not change the module from 24.**
6. **Keep `shape-rendering="crispEdges"`.**
7. **Never add margin to `turnpi-icon.svg`.** If a target needs padding, that is what
   `turnpi-tile.svg` is for.
8. **Never put the inline `BrandMark` in a square box.** Use a 5:4 box (24 × 19.2 at
   the default size); a square box silently shrinks the strokes by 20 % against
   upstream Pi.

## Still missing

The About tile **is** generated: `web/public/brand-mark-128.png` is a 128 × 128
screenshot of `turnpi-about.svg`, displayed at 36 × 36. It can be regenerated with
any Chromium + Playwright setup.

The rest still need a rasteriser (`rsvg-convert` / `convert` / `inkscape` / Chromium):

- `favicon.ico` (16 / 32 / 48) — from `turnpi-icon.svg`
- `apple-touch-icon.png` (180) — from `turnpi-tile.svg`
- `icon-192.png`, `icon-512.png` — from `turnpi-tile.svg`
- `icon-512-maskable.png` — needs a *third* crop with a 20 % margin (80 % safe zone), more than the tile has
- GitHub social preview `1280 × 640`

```bash
rsvg-convert -w 512 -h 512 turnpi-tile.svg -o icon-512.png
rsvg-convert -w  48 -h  48 turnpi-icon.svg -o favicon-48.png
```
