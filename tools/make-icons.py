from PIL import Image, ImageDraw, ImageFilter
import math

def gear_badge(im, S, k):
    # tandwiel rechtsonder, op een lichte ronde plaat
    cx, cy, R = S / 2 + (S * 0.30) * k, S / 2 + (S * 0.30) * k, S * 0.19 * k
    d = ImageDraw.Draw(im)
    d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=(255, 255, 255, 255))
    gold, plate = (214, 150, 20, 255), (255, 255, 255, 255)
    teeth, ro, ri = 8, R * 0.78, R * 0.56
    for i in range(teeth):
        a = 2 * math.pi * i / teeth
        c, sn = math.cos(a), math.sin(a)
        w = R * 0.17
        pts = [(cx + c * ri - sn * w, cy + sn * ri + c * w), (cx + c * ro - sn * w, cy + sn * ro + c * w),
               (cx + c * ro + sn * w, cy + sn * ro - c * w), (cx + c * ri + sn * w, cy + sn * ri - c * w)]
        d.polygon(pts, fill=gold)
    d.ellipse((cx - ri, cy - ri, cx + ri, cy + ri), fill=gold)
    d.ellipse((cx - R * 0.26, cy - R * 0.26, cx + R * 0.26, cy + R * 0.26), fill=plate)
    return im

def lantern(size, maskable=False, admin=False):
    S = 1024
    # beheer: dezelfde lantaarn op een donkerblauwe achtergrond, met een tandwiel als herkenningsteken
    bg = (36, 52, 86, 255) if admin else (31, 111, 74, 255)
    im = Image.new('RGBA', (S, S), bg if maskable else (0, 0, 0, 0))
    if not maskable:
        m = Image.new('L', (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, S, S), radius=int(S * 0.22), fill=255)
        base = Image.new('RGBA', (S, S), bg)
        im.paste(base, (0, 0), m)
    k = 0.78 if maskable else 1.0
    cx, cy = S / 2, S * 0.56
    def P(x, y):  # schaal rond het midden
        return (S / 2 + (x - S / 2) * k, S / 2 + (y - S / 2) * k)
    def box(x0, y0, x1, y1):
        a, b = P(x0, y0); c, d = P(x1, y1); return (a, b, c, d)

    # gloed
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(box(cx - 400, cy - 400, cx + 400, cy + 400), fill=(255, 214, 90, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    im = Image.alpha_composite(im, glow)
    d = ImageDraw.Draw(im)

    rx, ry = 215, 245
    # lichaam met verloop (geel midden -> oranje rand)
    steps = 40
    for i in range(steps):
        t = i / (steps - 1)
        r = 1 - t
        col = (int(255), int(150 + 90 * t), int(30 + 90 * t * t), 255)
        d.ellipse(box(cx - rx * r, cy - ry * r, cx + rx * r, cy + ry * r), fill=col)
    # randlijn
    d.ellipse(box(cx - rx, cy - ry, cx + rx, cy + ry), outline=(176, 84, 14, 255), width=int(12 * k))
    # ribben
    for f in (0.62, 0.3):
        d.ellipse(box(cx - rx * f, cy - ry, cx + rx * f, cy + ry), outline=(190, 92, 16, 255), width=int(8 * k))
    d.line([P(cx, cy - ry), P(cx, cy + ry)], fill=(190, 92, 16, 255), width=int(8 * k))
    # dwarsband
    for yy in (cy - ry * 0.45, cy + ry * 0.45):
        w = rx * math.sqrt(1 - ((yy - cy) / ry) ** 2)
        d.line([P(cx - w, yy), P(cx + w, yy)], fill=(176, 84, 14, 255), width=int(8 * k))
    # kappen
    cap = (92, 52, 28, 255)
    d.rounded_rectangle(box(cx - 110, cy - ry - 40, cx + 110, cy - ry + 28), radius=int(26 * k), fill=cap)
    d.rounded_rectangle(box(cx - 90, cy + ry - 24, cx + 90, cy + ry + 36), radius=int(26 * k), fill=cap)
    # draagstok met haak
    stick = (255, 255, 255, 255)
    top = cy - ry - 40
    d.line([P(cx, top), P(cx, 170)], fill=stick, width=int(26 * k))
    d.arc(box(cx - 6, 110, cx + 190, 250), 180, 360 + 40, fill=stick, width=int(26 * k))
    # sterretje (lantaarnlicht)
    for dx, dy, r in ((cx - 300, 250, 22), (cx + 310, 330, 16), (cx + 250, 190, 12)):
        px, py = P(dx, dy)
        d.polygon([(px, py - r * 1.6), (px + r * .4, py - r * .4), (px + r * 1.6, py), (px + r * .4, py + r * .4),
                   (px, py + r * 1.6), (px - r * .4, py + r * .4), (px - r * 1.6, py), (px - r * .4, py - r * .4)],
                  fill=(255, 236, 160, 255))
    if admin:
        im = gear_badge(im, S, k)
    return im.resize((size, size), Image.LANCZOS)

if __name__ == '__main__':
    out = 'public/icons/'
    lantern(192).save(out + 'icon-192.png')
    lantern(512).save(out + 'icon-512.png')
    lantern(512, True).save(out + 'maskable-512.png')
    lantern(180).save(out + 'apple-touch-icon.png')
    lantern(32).save(out + 'favicon-32.png')
    # beheer
    lantern(192, admin=True).save(out + 'admin-192.png')
    lantern(512, admin=True).save(out + 'admin-512.png')
    lantern(512, True, admin=True).save(out + 'admin-maskable-512.png')
    lantern(180, admin=True).save(out + 'admin-apple-touch-icon.png')
    lantern(32, admin=True).save(out + 'admin-favicon-32.png')
