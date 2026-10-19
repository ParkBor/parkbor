# ParkBor brand assets

ParkBor is the product name. The **mobile app** is for drivers and gate operators; the web is **ParkBor CRM**
for parking owners and platform admins.

## Files

| File | What |
|---|---|
| `parkbor-logo-original.png` | The supplied artwork: 1448x1086 raster on a white background. Source of everything else. |
| `parkbor-logo.png` | Full logo (pin + wordmark), transparent background, cropped to content. |
| `parkbor-mark.png` | Mark only (pin, arrow, ring), transparent, 1024x1024, centred with padding. |
| `derive_assets.py` | Script that produces the two files above and the mobile assets below (`python docs/brand/derive_assets.py`; needs Pillow, numpy, scipy). |

Mobile assets written by the script into `mobile/assets/images/`:
`icon.png` (1024, opaque white background, no transparency for iOS), `android-icon-foreground.png`
(1024, mark inside the ~66 % adaptive safe zone, used at 60 %), `android-icon-background.png` (plain white),
`android-icon-monochrome.png` (white silhouette for Android 13 themed icons), `splash-icon.png`
(full logo, transparent; the splash plugin supplies the white background), `favicon.png` (48),
`parkbor-logo.png` / `parkbor-mark.png` (half size, shown in the app by `BrandLogo`).
The unused Expo template images (`react-logo*`, `expo-*`, `logo-glow`, `tutorial-web`, `tabIcons`) were left alone.

## Palette

Sampled from the artwork (not eyeballed):

| Token | Value | Source |
|---|---|---|
| Brand blue | `#0057B5` | "Park" letters, P in the pin. Gradient of the pin: `#0161C4` to `#057AEB`. |
| Brand green | `#3CC755` | "Bor" letters, ring, arrow (`#46CD5F`). |
| White | `#FFFFFF` | Circle inside the pin, arrow outline, icon background. |

App tokens (`mobile/src/theme/palette.ts`), contrast checked by `palette.test.ts` (WCAG AA, 4.5:1 for text):

| Token | Light | Dark | Contrast |
|---|---|---|---|
| `primary` (buttons, links) | `#0057B5` | `#4DA3FF` | 6.9:1 on white; 7.3:1 on the dark background (the brand blue itself is only 2.6:1 there, so it is lightened) |
| `accent` (decorative fills) | `#3CC755` | `#3CC755` | 2.2:1 on white: never used for text |
| `accentText` | `#177A32` | `#3CC755` | 5.4:1 on white, 4.9:1 on the grey surface; 7.2:1 on dark surface |
| `onAccent` (label on green) | `#0B0F17` | `#0B0F17` | 8.7:1 |

## Usage

- Use the full logo on light backgrounds. The dark blue "Park" does not read on dark backgrounds
  (about 2:1 on `#0B0F17`); in dark mode the app shows the full logo on a white rounded plate, the mark alone works on both.
- Keep clear space of at least the height of the "P" around the logo; do not recolour, stretch or add effects.
- The mark is the app icon; it is used on white with about 15 % padding on each side.

## How the transparent versions were derived

The original is a raster with a white background and anti-aliased edges.

- **Wordmark:** every near-white pixel is background (this includes the counters of a, o, B, P). Alpha is un-mixed per
  pixel against white using the ink colour of that glyph (blue or green), and the colour is un-premultiplied, so the
  edges have no white halo on dark backgrounds.
- **Pin, arrow, ring:** only white connected to the outside of the artwork (flood fill from the corners) is background.
  The white circle inside the pin, the cut-out P and the white outline around the arrow are design and stay opaque.
  A 3 px band next to the background is un-mixed for clean edges.
- Checked by compositing on white and on `#0B0F17` and inspecting the edges.

## Limits and open points

- The result is derived from a 1448 px raster. **Ask the owner for the vector/SVG original** before the store release
  (icons, app store graphics, signage and print need real vectors; the derived files are good for development and
  internal builds, and acceptable for a first store submission only as a stop-gap).
- The splash has no dark variant because of the wordmark contrast.
- `uz.parkbor.app` (iOS bundle id / Android package) is a placeholder the owner may change before the first store release.
