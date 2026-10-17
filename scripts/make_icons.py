#!/usr/bin/env python3
"""Generate the PNG icons (gift card with a % sign on dark green).

Run once; the PNGs are committed. Needs Pillow:  python3 scripts/make_icons.py
"""
import os
from PIL import Image, ImageDraw

GREEN = (11, 74, 37)        # #0b4a25
CARD = (244, 248, 241)
STRIPE = (31, 157, 85)
PERCENT = (11, 74, 37)

BASE = 1024                 # design grid
SS = 4                      # supersampling factor
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "icons")


def artwork():
    """Gift card with %, transparent background, on a BASE x BASE grid (supersampled)."""
    s = SS
    size = BASE * s
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # card body (drawn on its own layer so the stripe is clipped to the rounded corners)
    x0, y0, x1, y1 = 132, 252, 892, 772
    card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([x0 * s, y0 * s, x1 * s, y1 * s], radius=68 * s, fill=CARD)
    cd.rectangle([x0 * s, (y0 + 24) * s, x1 * s, (y0 + 108) * s], fill=STRIPE)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([x0 * s, y0 * s, x1 * s, y1 * s], radius=68 * s, fill=255)
    layer.paste(card, (0, 0), mask)

    d = ImageDraw.Draw(layer)
    # % sign, centred in the area below the stripe
    cx, cy = 512, 586
    ring_r, ring_w = 82, 46
    dx, dy = 104, 92
    for (ox, oy) in ((-dx, -dy), (dx, dy)):
        c = ((cx + ox) * s, (cy + oy) * s)
        d.ellipse([c[0] - ring_r * s, c[1] - ring_r * s, c[0] + ring_r * s, c[1] + ring_r * s], fill=PERCENT)
        r2 = (ring_r - ring_w) * s
        d.ellipse([c[0] - r2, c[1] - r2, c[0] + r2, c[1] + r2], fill=CARD)
    # slash
    w = 48
    a = ((cx + 124) * s, (cy - 146) * s)
    b = ((cx - 124) * s, (cy + 146) * s)
    d.line([a, b], fill=PERCENT, width=w * s)
    for p in (a, b):
        d.ellipse([p[0] - w * s / 2, p[1] - w * s / 2, p[0] + w * s / 2, p[1] + w * s / 2], fill=PERCENT)
    return layer


def render(px, content_scale=1.0):
    art = artwork()
    if content_scale != 1.0:
        n = int(art.width * content_scale)
        small = art.resize((n, n), Image.LANCZOS)
        art = Image.new("RGBA", art.size, (0, 0, 0, 0))
        off = (art.width - n) // 2
        art.paste(small, (off, off))
    bg = Image.new("RGBA", art.size, GREEN + (255,))
    bg.alpha_composite(art)
    return bg.convert("RGB").resize((px, px), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    targets = [
        ("apple-touch-icon.png", 180, 1.0),   # iOS rounds the corners itself: full bleed, no alpha
        ("icon-192.png", 192, 1.0),
        ("icon-512.png", 512, 1.0),
        ("icon-maskable-192.png", 192, 0.82),  # content kept inside the 80% safe zone
        ("icon-maskable-512.png", 512, 0.82),
        ("favicon-32.png", 32, 1.0),
    ]
    for name, px, scale in targets:
        render(px, scale).save(os.path.join(OUT, name), optimize=True)
        print("wrote", name, px)


if __name__ == "__main__":
    main()
