#!/usr/bin/env python3
"""Extract approximate transparency from checkerboard-baked sprites.

These images are JPGs with a baked checkerboard background (common from generators).
We approximate alpha by keying out low-saturation grey background.

Outputs cleaned RGBA PNG, cropped to content with padding, resized to 1024x1024.
"""

import os
import sys
from PIL import Image, ImageFilter, ImageChops


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

    # Estimate checkerboard background colors by sampling low-sat pixels
    px = im.load()
    samples = []
    step = max(4, min(w, h) // 64)
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px[x, y]
            _, s, v = rgb_to_hsv(r, g, b)
            neutral = 1.0 - (abs(r - g) + abs(g - b) + abs(b - r)) / (3.0 * 255.0)
            if s < 0.10 and neutral > 0.75 and v > 0.15:
                samples.append((r, g, b))

    # Fallback to corners if needed
    if len(samples) < 50:
        corners = [im.getpixel((2, 2)), im.getpixel((w - 3, 2)), im.getpixel((2, h - 3)), im.getpixel((w - 3, h - 3))]
        samples = corners * 40

    # crude 2-means clustering
    c1 = samples[0]
    c2 = samples[len(samples) // 2]
    for _ in range(8):
        a1 = [0, 0, 0, 0]
        a2 = [0, 0, 0, 0]
        for r, g, b in samples:
            d1 = (r - c1[0]) ** 2 + (g - c1[1]) ** 2 + (b - c1[2]) ** 2
            d2 = (r - c2[0]) ** 2 + (g - c2[1]) ** 2 + (b - c2[2]) ** 2
            if d1 <= d2:
                a1[0] += r; a1[1] += g; a1[2] += b; a1[3] += 1
            else:
                a2[0] += r; a2[1] += g; a2[2] += b; a2[3] += 1
        if a1[3] > 0:
            c1 = (a1[0] // a1[3], a1[1] // a1[3], a1[2] // a1[3])
        if a2[3] > 0:
            c2 = (a2[0] // a2[3], a2[1] // a2[3], a2[2] // a2[3])

    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    opx = out.load()

    # Alpha from: saturation + distance from either checker color + non-neutral bias
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            _, s, v = rgb_to_hsv(r, g, b)
            neutral = 1.0 - (abs(r - g) + abs(g - b) + abs(b - r)) / (3.0 * 255.0)

            d1 = (((r - c1[0]) / 255.0) ** 2 + ((g - c1[1]) / 255.0) ** 2 + ((b - c1[2]) / 255.0) ** 2) ** 0.5
            d2 = (((r - c2[0]) / 255.0) ** 2 + ((g - c2[1]) / 255.0) ** 2 + ((b - c2[2]) / 255.0) ** 2) ** 0.5
            dist = d1 if d1 < d2 else d2

            a = 0.0
            a = max(a, (dist - 0.05) / 0.18)              # foreground vs bg
            a = max(a, (s - 0.08) / 0.30)                 # keep color
            a = max(a, (0.30 - neutral) / 0.30)           # non-neutral
            a = max(a, (v - 0.80) / 0.20 * 0.9)           # keep bright highlights

            a = clamp(a, 0.0, 1.0)
            opx[x, y] = (r, g, b, int(a * 255))

    # Clean / sharpen alpha edges
    alpha = out.split()[-1]
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.6))
    out.putalpha(alpha)

    # Unsharp mask to counter resize blur
    out = out.filter(ImageFilter.UnsharpMask(radius=1.6, percent=120, threshold=3))
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
