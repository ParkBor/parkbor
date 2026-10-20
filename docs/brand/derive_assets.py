"""Derives the ParkBor brand assets from the supplied originals (rasters on white).

Run:  python docs/brand/derive_assets.py     (needs Pillow, numpy and scipy)

Originals (kept untouched):
  parkbor-app-icon-original.png   1254x1254  PB pin on a white rounded tile with a soft shadow
  parkbor-web-banner-original.png 2172x724   pin with P + "ParkBor" wordmark
  parkbor-mark-original.png       1254x1254  plain pin with P, arrow, ring
  parkbor-logo-original.png       1448x1086  first logo version (no longer used by this script)

Derived
  parkbor-logo.png        full logo from the banner, transparent, cropped
  parkbor-mark.png        pin with P from the mark file, transparent, 1024 square, padded
  parkbor-app-icon-art.png  PB pin without tile and shadow, transparent, cropped
  mobile/assets/images/*  icon, adaptive icon layers, splash, favicon, in-app logos

Transparency
- Background = near-white / grey (low saturation) pixels CONNECTED to the image border (flood fill).
  For the app icon this removes the tile and its shadow; the white circle inside the pin, the white
  outline of the arrow and the inside of the ring that is enclosed stay opaque white as designed.
- A thin band next to the background is un-mixed: alpha from how far the pixel is from white
  relative to the colour of the nearest solid pixel, and the colour is un-premultiplied, so edges
  have no white halo on dark backgrounds.
- Wordmark (banner, right of WORD_X): all white is background, including the counters of a, o, B, P.

A derivation from rasters: ask the owner for the vector/SVG originals for production.
"""

from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent
MOBILE_IMAGES = ROOT.parent.parent / 'mobile' / 'assets' / 'images'

APP_ICON = ROOT / 'parkbor-app-icon-original.png'
BANNER = ROOT / 'parkbor-web-banner-original.png'
MARK = ROOT / 'parkbor-mark-original.png'

WORD_X = 690  # banner: x where the pin ends and the wordmark begins (source pixels)
EDGE_BAND = 3  # px next to the background in which anti-aliased edges are un-mixed
SOLID_MIN = 110  # a pixel whose darkest channel is below this is solid ink
ADAPTIVE_MAX_RADIUS = 285  # px at 1024; circle-mask launchers guarantee 313, keep a margin
ICON_MAX_RADIUS = 380  # px at 1024 for the iOS icon (rounded-square mask)


def cutout(path: Path, word_x: int | None = None) -> Image.Image:
    rgb = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)
    h, w, _ = rgb.shape
    spread = rgb.max(axis=-1) - rgb.min(axis=-1)
    is_bg = (spread < 30) & (rgb.min(axis=-1) >= 200)

    labels, _ = ndimage.label(is_bg)
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    exterior = np.isin(labels, list(set(np.unique(border)) - {0}))

    # colour of the nearest solid pixel = the ink an edge pixel is a mix of (with white)
    solid = rgb.min(axis=-1) < SOLID_MIN
    _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    ink = rgb[iy, ix]
    # channels where the ink is clearly darker than white carry the signal
    denom = 255.0 - ink
    ratio = np.where(denom > 40, (255.0 - rgb) / np.maximum(denom, 1.0), 0.0)
    alpha_unmix = np.clip(ratio.max(axis=-1), 0.0, 1.0)
    safe = np.maximum(alpha_unmix, 1e-3)[..., None]
    unmixed = np.clip((rgb - 255.0 * (1 - safe)) / safe, 0, 255)

    near = ndimage.binary_dilation(exterior, iterations=EDGE_BAND)
    alpha = np.where(exterior, 0.0, np.where(near, alpha_unmix, 1.0))
    use_unmixed = near & ~exterior
    if word_x is not None:
        is_word = np.arange(w)[None, :].repeat(h, axis=0) >= word_x
        is_white = rgb.min(axis=-1) >= 244
        alpha = np.where(is_word, np.where(is_white, 0.0, alpha_unmix), alpha)
        use_unmixed = np.where(is_word, alpha_unmix > 0, use_unmixed)
    color = np.where(use_unmixed[..., None], unmixed, rgb)

    out = np.zeros((h, w, 4), dtype=np.float64)
    out[..., :3] = color
    out[..., 3] = alpha * 255.0
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGBA')


def crop_to_content(img: Image.Image, pad: int = 0) -> Image.Image:
    bbox = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    assert bbox is not None
    x0, y0, x1, y1 = bbox
    return img.crop((max(0, x0 - pad), max(0, y0 - pad), min(img.width, x1 + pad), min(img.height, y1 + pad)))


def square(img: Image.Image, size: int, fill_ratio: float, background: tuple[int, int, int, int] = (0, 0, 0, 0)) -> Image.Image:
    """`img` scaled so its longer side is `fill_ratio` of a size x size canvas, centred."""
    target = int(size * fill_ratio)
    scale = target / max(img.width, img.height)
    resized = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), background)
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def farthest_opaque(img: Image.Image) -> float:
    """Largest distance (px) of any opaque pixel from the canvas centre."""
    alpha = np.asarray(img.getchannel('A'))
    ys, xs = np.nonzero(alpha > 8)
    cy, cx = (img.height - 1) / 2, (img.width - 1) / 2
    return float(np.hypot(ys - cy, xs - cx).max())


def fit_radius(art: Image.Image, size: int, max_radius: float) -> Image.Image:
    """`art` centred on its bounding-box centre and scaled until the farthest opaque pixel is within
    `max_radius` of the canvas centre. Launchers mask icons with a circle, so a radius (not a box) is the rule."""
    art = crop_to_content(art)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    scale = max_radius / farthest_opaque(canvas)
    resized = art.resize((max(1, round(art.width * scale)), max(1, round(art.height * scale))), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    # rounding can add a pixel: shave the scale until the rule holds
    while farthest_opaque(out) > max_radius and scale > 0.1:
        scale *= 0.995
        resized = art.resize((max(1, round(art.width * scale)), max(1, round(art.height * scale))), Image.LANCZOS)
        out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        out.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return out


def monochrome(art: Image.Image) -> Image.Image:
    """Android themed-icon layer: coloured shapes (not the white cut-outs) as a white silhouette."""
    arr = np.asarray(art, dtype=np.float64)
    rgb, alpha = arr[..., :3], arr[..., 3] / 255.0
    ink = 1.0 - rgb.min(axis=-1) / 255.0  # white cut-outs -> 0
    shape = np.clip(alpha * np.clip(ink * 1.6, 0, 1), 0, 1)
    out = np.zeros(arr.shape, dtype=np.uint8)
    out[..., :3] = 255
    out[..., 3] = (shape * 255).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def half(img: Image.Image, max_width: int) -> Image.Image:
    scale = min(1.0, max_width / img.width)
    return img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)


def main() -> None:
    white = (255, 255, 255, 255)

    # --- the phone icon: PB pin without the tile and the shadow --------------------------------
    app_art = crop_to_content(cutout(APP_ICON), pad=4)
    app_art.save(ROOT / 'parkbor-app-icon-art.png')
    # iOS masks the icon itself (rounded square): full-bleed opaque white, art well inside (<= 380 px of 512).
    icon = Image.new('RGBA', (1024, 1024), white)
    icon.alpha_composite(fit_radius(app_art, 1024, ICON_MAX_RADIUS))
    icon.convert('RGB').save(MOBILE_IMAGES / 'icon.png')
    # Android adaptive: circle masks guarantee only a 313 px radius (66/108 of the canvas / 2): stay within 290.
    foreground = fit_radius(app_art, 1024, ADAPTIVE_MAX_RADIUS)
    foreground.save(MOBILE_IMAGES / 'android-icon-foreground.png')
    Image.new('RGB', (1024, 1024), (255, 255, 255)).save(MOBILE_IMAGES / 'android-icon-background.png')
    monochrome(foreground).save(MOBILE_IMAGES / 'android-icon-monochrome.png')

    # --- full logo (banner): splash and the in-app logo ----------------------------------------
    full = crop_to_content(cutout(BANNER, word_x=WORD_X), pad=6)
    full.save(ROOT / 'parkbor-logo.png')
    splash = full.resize((1024, round(full.height * 1024 / full.width)), Image.LANCZOS)
    splash.save(MOBILE_IMAGES / 'splash-icon.png')
    # Android 12+ draws the splash icon inside a circle (2/3 of the icon canvas): the wide logo would be
    # cut, so Android gets the pin alone, within the same safe radius as the adaptive icon.
    fit_radius(app_art, 1024, ADAPTIVE_MAX_RADIUS).save(MOBILE_IMAGES / 'splash-icon-android.png')
    half(full, 660).save(MOBILE_IMAGES / 'parkbor-logo.png')

    # --- the small mark (pin with P): headers and favicon --------------------------------------
    mark = crop_to_content(cutout(MARK), pad=6)
    square(mark, 1024, 0.86).save(ROOT / 'parkbor-mark.png')
    half(mark, 360).save(MOBILE_IMAGES / 'parkbor-mark.png')
    square(mark, 48, 0.94).save(MOBILE_IMAGES / 'favicon.png')


if __name__ == '__main__':
    main()
