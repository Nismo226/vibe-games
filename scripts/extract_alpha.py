#!/usr/bin/env python3
"""Extract approximate transparency from checkerboard-baked sprites.

These images are JPGs with a baked checkerboard background (common from generators).
We approximate alpha by keying out low-saturation grey background.

Outputs cleaned RGBA PNG, cropped to content with padding, resized to 1024x1024.
"""

import os
import sys
from PIL import Image, ImageFilter


def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def rgb_to_hsv(r, g, b):
    r, g, b = r / 255.0, g / 255.0, b / 255.0
    mx = max(r, g, b)
    mn = min(r, g, b)
    d = mx - mn
    if d == 0:
        h = 0
    elif mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = ((b - r) / d) + 2
    else:
        h = ((r - g) / d) + 4
    h /= 6.0
    s = 0 if mx == 0 else d / mx
    v = mx
    return h, s, v


def make_alpha(im: Image.Image) -> Image.Image:
    im = im.convert("RGB")
    w, h = im.size
    px = im.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    opx = out.load()

    # First pass: alpha from saturation + distance to neutral gray
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            _, s, v = rgb_to_hsv(r, g, b)
            # neutral-ness: how close channels are
            neutral = 1.0 - (abs(r - g) + abs(g - b) + abs(b - r)) / (3.0 * 255.0)

            # Background checkerboard is low saturation, high neutral.
            # Keep colorful pixels; suppress neutral low-sat.
            a = 0.0
            a = max(a, (s - 0.10) / 0.35)  # color
            a = max(a, (0.35 - neutral) / 0.35)  # non-neutral

            # Preserve bright highlights even if low saturation
            a = max(a, (v - 0.70) / 0.30 * (1.0 - neutral) * 1.2)

            a = clamp(a, 0.0, 1.0)
            opx[x, y] = (r, g, b, int(a * 255))

    # Feather edges slightly
    alpha = out.split()[-1]
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.8))
    out.putalpha(alpha)
    return out


def bbox_from_alpha(im: Image.Image, thresh=10):
    a = im.split()[-1]
    # getbbox on thresholded alpha
    bw = a.point(lambda p: 255 if p > thresh else 0)
    return bw.getbbox()


def crop_pad_resize(im: Image.Image, target=1024, pad_frac=0.14):
    bb = bbox_from_alpha(im)
    if not bb:
        return im.resize((target, target), Image.LANCZOS)
    x0, y0, x1, y1 = bb
    w = x1 - x0
    h = y1 - y0
    pad = int(max(w, h) * pad_frac)
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(im.width, x1 + pad)
    y1 = min(im.height, y1 + pad)
    im = im.crop((x0, y0, x1, y1))

    # letterbox to square
    side = max(im.width, im.height)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return sq.resize((target, target), Image.LANCZOS)


def main():
    if len(sys.argv) < 3:
        print("usage: extract_alpha.py <out_dir> <in1> [in2...]")
        sys.exit(2)

    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)

    for p in sys.argv[2:]:
        base = os.path.splitext(os.path.basename(p))[0]
        im = Image.open(p)
        rgba = make_alpha(im)
        final = crop_pad_resize(rgba)
        out_path = os.path.join(out_dir, base + ".png")
        final.save(out_path)
        print("wrote", out_path)


if __name__ == "__main__":
    main()
