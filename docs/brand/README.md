# ParkBor brand assets

ParkBor is the product name. The **mobile app** is for drivers and gate operators; the web is **ParkBor CRM**
for parking owners and platform admins.

## Originals (supplied by the owner; never edited)

| File | What |
|---|---|
| `parkbor-app-icon-original.png` | 1254x1254. The phone app icon: blue pin with bold **PB**, green arrow and ring, drawn on a white rounded tile with a soft shadow (tile and shadow are NOT part of the art). |
| `parkbor-web-banner-original.png` | 2172x724. Full wordmark: pin with P + "ParkBor". |
| `parkbor-mark-original.png` | 1254x1254. Plain pin with P, arrow and ring. |
| `parkbor-logo-original.png` | 1448x1086. First logo version; no longer used by the script. |

## Derived files

Produced by `python docs/brand/derive_assets.py` (needs Pillow, numpy, scipy):

| File | From | Use |
|---|---|---|
| `parkbor-app-icon-art.png` | app icon | PB pin without tile and shadow, transparent, cropped |
| `parkbor-logo.png` | banner | full logo, transparent, cropped |
| `parkbor-mark.png` | mark | pin with P, transparent, 1024 square with padding |

Mobile assets written into `mobile/assets/images/`:

| File | Content |
|---|---|
| `icon.png` | 1024x1024, **opaque**, full-bleed white square with the PB pin at 72 % (no rounded corners and no shadow: iOS applies its own mask) |
| `android-icon-foreground.png` | 1024, PB pin transparent, longer side 62 % (inside the 66 % adaptive safe zone) |
| `android-icon-background.png` | plain white (`adaptiveIcon.backgroundColor` is white too) |
| `android-icon-monochrome.png` | white silhouette of the pin (the white circle becomes a cut-out) for Android 13 themed icons |
| `splash-icon.png` | full logo (banner), transparent, 1024 wide; the splash plugin supplies the white background |
| `parkbor-logo.png` | full logo, 660 wide, shown by `BrandLogo` (welcome, login) |
| `parkbor-mark.png` | pin with P, 360 wide, `BrandLogo variant="mark"` |
| `favicon.png` | pin with P, 48x48 |

`mobile/src/components/brandAssets.test.ts` checks the sizes and colour types (icon without alpha, the rest with alpha)
so a regenerated file cannot silently break the build or stretch the logo.

The unused Expo template images (`react-logo*`, `expo-*`, `logo-glow`, `tutorial-web`, `tabIcons`) were left alone.

## Palette

Sampled from the artwork:

| Token | Value | Source |
|---|---|---|
| Brand blue | `#0057B5` | "Park" letters and the P/B in the pin. The pin itself is a gradient from about `#0045C8` to `#0A9BFF` in the icon. |
| Brand green | `#3CC755` | "Bor" letters (`#34C759`-ish in the banner) and the ring. The icon's green is a brighter gradient (`#3FE02F` to `#0DB04B`). |
| White | `#FFFFFF` | circle inside the pin, arrow outline, icon background |

App tokens (`mobile/src/theme/palette.ts`), contrast checked by `palette.test.ts` (WCAG AA, 4.5:1 for text):

| Token | Light | Dark | Contrast |
|---|---|---|---|
| `primary` (buttons, links) | `#0057B5` | `#4DA3FF` | 6.9:1 on white; 7.3:1 on the dark background (the brand blue itself is only 2.6:1 there, so it is lightened) |
| `accent` (decorative fills) | `#3CC755` | `#3CC755` | 2.2:1 on white: never used for text |
| `accentText` | `#177A32` | `#3CC755` | 5.4:1 on white, 4.9:1 on the grey surface; 7.2:1 on the dark surface |
| `onAccent` (label on green) | `#0B0F17` | `#0B0F17` | 8.7:1 |

## Usage

- Use the full logo on light backgrounds. The dark blue "Park" does not read on dark backgrounds (about 2:1 on
  `#0B0F17`); in dark mode the app shows the full logo on a white rounded plate. The pin alone works on both.
- The PB pin is the app icon; the P-only pin is the small mark (headers, favicon), because PB gets unreadable below ~48 px.
- Keep clear space of at least the height of the "P" around the logo; do not recolour, stretch or add effects.

## How the transparent versions were derived

All originals are rasters on white with anti-aliased edges.

- **Background** = near-white / light-grey, low-saturation pixels **connected to the image border** (flood fill). For the
  app icon this removes the rounded tile and its soft shadow in one step. White that is enclosed by the art (the circle
  inside the pin, the outline around the arrow) is not reachable from the border and stays opaque white, as designed.
  The inside of the ring is open to the outside through its two gaps and becomes transparent.
- **Edges:** a 3 px band next to the background is un-mixed: alpha comes from how far a pixel is from white relative to
  the colour of the nearest solid pixel, and the colour is un-premultiplied. No white halo on dark backgrounds.
- **Wordmark** (banner, right of x = 690): all white is background including the counters of a, o, B, P.
- Checked by compositing on white and on `#0B0F17` and inspecting the edges.

## Limits and open points

- Derived from rasters (1254 px and 2172 px). **Ask the owner for the vector/SVG originals** before the store release:
  icons, store graphics, signage and print need real vectors. The derived files are fine for development and internal builds.
- The splash has no dark variant because of the wordmark contrast.
- `uz.parkbor.app` (iOS bundle id / Android package) is a placeholder the owner may change before the first store release.
