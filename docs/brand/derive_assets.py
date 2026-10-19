"""Derives the ParkBor brand assets from parkbor-logo-original.png (a raster on white).

Run:  python docs/brand/derive_assets.py     (needs Pillow, numpy and scipy)

Transparency
- Wordmark (right of WORD_X): every near-white pixel is background, including the counters of
  a, o, B, P. Alpha is un-mixed per pixel against white using the ink colour of that glyph
  (blue "Park", green "Bor"), so anti-aliased edges stay clean on light AND dark backgrounds.
- Pin / arrow / ring (left of WORD_X): only the white that is CONNECTED to the outside is
  background (flood fill from the corners). The white circle inside the pin, the P cut-out and the
  white outline around the arrow are part of the design and stay opaque white.

This is a derivation from a raster: ask the owner for the vector/SVG original for production.
"""

from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'parkbor-logo-original.png'
MOBILE_IMAGES = ROOT.parent.parent / 'mobile' / 'assets' / 'images'

WORD_X = 432  # x where the pin region ends and the wordmark begins (source pixels)
WHITE_MIN = 244  # min channel at/above which a pixel counts as background white
EDGE_BAND = 3  # px around the background in which anti-aliased edges are un-mixed
BRAND_BLUE = (0, 87, 181)
BRAND_GREEN = (60, 199, 85)


def load() -> np.ndarray:
    return np.asarray(Image.open(SRC).convert('RGB'), dtype=np.float64)


def ink_for(rgb: np.ndarray) -> np.ndarray:
    """Ink colour a pixel is a mix of (with white): green family or blue family."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    is_green = (g - b > 18) & (g - r > 18)
    ink = np.empty_like(rgb)
    ink[...] = BRAND_BLUE
    ink[is_green] = BRAND_GREEN
    return ink


def unmix_alpha(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Alpha and un-premultiplied colour of pixels that are `ink * a + white * (1 - a)`."""
    ink = ink_for(rgb)
    denom = 255.0 - ink
    alpha = np.clip(((255.0 - rgb) / np.maximum(denom, 1.0)).max(axis=-1), 0.0, 1.0)
    safe = np.maximum(alpha, 1e-3)[..., None]
    color = np.clip((rgb - 255.0 * (1 - safe)) / safe, 0, 255)
    return alpha, color


def transparent_logo() -> Image.Image:
    rgb = load()
    h, w, _ = rgb.shape
    is_white = rgb.min(axis=-1) >= WHITE_MIN

    # background that touches the border
    labels, _ = ndimage.label(is_white)
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    exterior = np.isin(labels, list(set(np.unique(border)) - {0}))

    alpha_all, color_all = unmix_alpha(rgb)
    out = np.zeros((h, w, 4), dtype=np.float64)
    xs = np.arange(w)[None, :].repeat(h, axis=0)
    is_word = xs >= WORD_X

    # wordmark: global un-mix (counters become transparent)
    word_alpha = np.where(is_white, 0.0, alpha_all)
    # pin region: opaque everywhere except the exterior and a thin anti-aliased band next to it
    near_exterior = ndimage.binary_dilation(exterior, iterations=EDGE_BAND)
    pin_alpha = np.where(exterior, 0.0, np.where(near_exterior, alpha_all, 1.0))

    alpha = np.where(is_word, word_alpha, pin_alpha)
    use_unmixed = np.where(is_word, alpha_all > 0, near_exterior & ~exterior)
    color = np.where(use_unmixed[..., None], color_all, rgb)
    out[..., :3] = color
    out[..., 3] = alpha * 255.0
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGBA')


def crop_to_content(img: Image.Image, pad: int = 0) -> Image.Image:
    bbox = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    assert bbox is not None
    x0, y0, x1, y1 = bbox
    return img.crop((max(0, x0 - pad), max(0, y0 - pad), min(img.width, x1 + pad), min(img.height, y1 + pad)))


def square(img: Image.Image, size: int, fill_ratio: float, background: tuple[int, int, int, int] = (0, 0, 0, 0)) -> Image.Image:
    """`img` scaled to fill `fill_ratio` of a size x size canvas, centred."""
    target = int(size * fill_ratio)
    scale = target / max(img.width, img.height)
    resized = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), background)
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def monochrome(mark: Image.Image) -> Image.Image:
    """Android themed-icon layer: coloured shapes (not the white cut-outs) as an opaque silhouette."""
    arr = np.asarray(mark, dtype=np.float64)
    rgb, alpha = arr[..., :3], arr[..., 3] / 255.0
    ink = 1.0 - rgb.min(axis=-1) / 255.0  # white cut-outs -> 0
    shape = np.clip(alpha * np.clip(ink * 1.6, 0, 1), 0, 1)
    out = np.zeros(arr.shape, dtype=np.uint8)
    out[..., :3] = 255
    out[..., 3] = (shape * 255).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def main() -> None:
    transparent = transparent_logo()
    full = crop_to_content(transparent, pad=6)
    full.save(ROOT / 'parkbor-logo.png')

    mark = crop_to_content(transparent.crop((0, 0, WORD_X - 4, transparent.height)), pad=6)
    square(mark, 1024, 0.86).save(ROOT / 'parkbor-mark.png')

    white = (255, 255, 255, 255)
    # iOS / store icon: no transparency
    square(mark, 1024, 0.70, background=white).convert('RGB').save(MOBILE_IMAGES / 'icon.png')
    # Android adaptive: foreground inside the 66 % safe zone, plain white background layer
    square(mark, 1024, 0.60).save(MOBILE_IMAGES / 'android-icon-foreground.png')
    Image.new('RGB', (1024, 1024), (255, 255, 255)).save(MOBILE_IMAGES / 'android-icon-background.png')
    monochrome(square(mark, 1024, 0.60)).save(MOBILE_IMAGES / 'android-icon-monochrome.png')
    # splash: full logo, transparent (the splash plugin sets the background colour)
    crop_to_content(square(full, 1024, 1.0)).save(MOBILE_IMAGES / 'splash-icon.png')
    # in-app logos (shown at up to ~300 dp wide)
    full.resize((full.width // 2, full.height // 2), Image.LANCZOS).save(MOBILE_IMAGES / 'parkbor-logo.png')
    mark.resize((mark.width // 2, mark.height // 2), Image.LANCZOS).save(MOBILE_IMAGES / 'parkbor-mark.png')
    # favicon (web)
    square(mark, 48, 0.92).save(MOBILE_IMAGES / 'favicon.png')


if __name__ == '__main__':
    main()
