"""
Generate favicon.png — the String Metaverse swirl/alloy-wheel logo
(white pinwheel on an orange rounded square). Run once:

    python make_favicon.py
"""
import math

from PIL import Image, ImageDraw

ORANGE = (244, 99, 30, 255)
WHITE = (255, 255, 255, 255)


def make_favicon(path="favicon.png", px=128, blades=8, swirl_deg=38):
    scale = 4
    S = px * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.18), fill=ORANGE)

    cx = cy = S / 2
    inner, outer = 0.14 * S, 0.46 * S
    width = int(S * 0.034)
    dot = S * 0.05

    for i in range(blades):
        a0 = math.radians(i * 360 / blades)
        pts = []
        for s in range(13):
            t = s / 12
            r = inner + (outer - inner) * t
            ang = a0 + math.radians(swirl_deg) * t
            pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
        d.line(pts, fill=WHITE, width=width, joint="curve")
        ex, ey = pts[-1]
        d.ellipse([ex - dot, ey - dot, ex + dot, ey + dot], fill=WHITE)

    hub = S * 0.032
    d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=WHITE)

    img.resize((px, px), Image.LANCZOS).save(path)
    print(f"wrote {path}")


if __name__ == "__main__":
    make_favicon()
