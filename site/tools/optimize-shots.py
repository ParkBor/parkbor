"""Resize/convert screenshots for the guide.
Usage: python site/tools/optimize-shots.py <input_dir> [max_width=360]
Reads png/jpg/webp from <input_dir>, writes site/assets/guide/<same-name>.webp
(file names must be e.g. 01-install, crm-02-add-lot; see docs/SITE.md). EXIF/metadata is dropped.
Then run: node site/tools/build.mjs
"""
import sys
from pathlib import Path
from PIL import Image

src = Path(sys.argv[1])
max_w = int(sys.argv[2]) if len(sys.argv) > 2 else 360
out = Path(__file__).resolve().parent.parent / "assets" / "guide"
out.mkdir(parents=True, exist_ok=True)
for f in sorted(src.iterdir()):
    if f.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        continue
    im = Image.open(f).convert("RGB")  # new image object: no EXIF carried over
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    dest = out / (f.stem + ".webp")
    im.save(dest, "WEBP", quality=80, method=6)
    print(dest.name, im.size, dest.stat().st_size // 1024, "KB")
