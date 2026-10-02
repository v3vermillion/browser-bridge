#!/usr/bin/env python3
"""perceive.py - turn screenshots into visual measurements.

Humans describe what they see in words ("the colors feel bland", "the background doesn't blend into the
next section", "it feels cluttered"). This tool measures the pixels behind those impressions so an AI can
check them, describe them precisely, and judge changes consistently:

  palette     dominant colors with share of the image, hex and HSL
  harmony     how the main hues relate (analogous, complementary, triadic, ...)
  colorfulness  Hasler & Suesstrunk (2003) colorfulness metric with its standard verbal scale
  tonal range lightness spread (flat / low-contrast vs punchy)
  seams       where the page changes color abruptly between horizontal bands vs fades smoothly
  density     how busy (edge density) vs calm (uniform space) each vertical band of the page is

These are measurements, not verdicts. Bold sites can be deliberately saturated; calm sites deliberately
quiet. Use them to ground and check judgment, never to replace it.

Usage:
  python3 perceive.py analyze IMAGE [--json]
  python3 perceive.py compare BEFORE AFTER -o side_by_side.jpg [--labels "Before" "After"]

Requires numpy and Pillow (pip install numpy pillow).
"""
import argparse
import colorsys
import json
import sys

import numpy as np
from PIL import Image, ImageDraw


# ---------------------------------------------------------------------------- color math
def srgb_to_lab(rgb):
    """rgb: (..., 3) floats 0..255 -> CIE L*a*b* (D65)."""
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def hexof(rgb):
    return "#%02x%02x%02x" % tuple(int(round(v)) for v in rgb)


def hsl(rgb):
    h, l, s = colorsys.rgb_to_hls(*(np.asarray(rgb) / 255.0))
    return round(h * 360), round(s, 2), round(l, 2)


def kmeans(pixels, k=6, iters=12, seed=0):
    rng = np.random.default_rng(seed)
    centers = pixels[rng.choice(len(pixels), size=min(k, len(pixels)), replace=False)].astype(float)
    for _ in range(iters):
        d = ((pixels[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
        lab = d.argmin(1)
        new = np.array([pixels[lab == i].mean(0) if np.any(lab == i) else centers[i] for i in range(len(centers))])
        if np.allclose(new, centers, atol=0.5):
            break
        centers = new
    counts = np.bincount(lab, minlength=len(centers))
    order = np.argsort(-counts)
    return centers[order], counts[order] / counts.sum()


# ---------------------------------------------------------------------------- analyses
# Hasler & Suesstrunk (2003), seven perceptual categories.
COLORFULNESS_SCALE = [(15, "not colorful"), (33, "slightly colorful"), (45, "moderately colorful"),
                      (59, "averagely colorful"), (82, "quite colorful"), (109, "highly colorful"),
                      (1e9, "extremely colorful")]


def colorfulness(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    rg, yb = r - g, 0.5 * (r + g) - b
    m = float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2))
    label = next(name for limit, name in COLORFULNESS_SCALE if m < limit)
    return round(m, 1), label


def harmony(palette):
    chroma = [p for p in palette if p["saturation"] >= 0.25 and 0.12 <= p["lightness"] <= 0.88 and p["share"] >= 0.03]
    pairs = []
    for i in range(len(chroma)):
        for j in range(i + 1, len(chroma)):
            a, b = chroma[i], chroma[j]
            d = abs(a["hue"] - b["hue"]) % 360
            d = min(d, 360 - d)
            if d <= 30:
                rel = "analogous (neighbors on the color wheel; cohesive, low tension)"
            elif d <= 60:
                rel = "near-analogous (related but distinct)"
            elif d <= 105:
                rel = "unconventional interval (neither neighbors nor opposites; needs value/saturation contrast to read as intentional)"
            elif d <= 135:
                rel = "triadic-like (balanced, energetic)"
            elif d <= 150:
                rel = "split-complementary-like (contrast with some softness)"
            else:
                rel = "complementary (maximum hue contrast; vivid, can clash at equal strength)"
            pairs.append({"a": a["hex"], "b": b["hex"], "hue_difference": round(d), "relationship": rel})
    return {"chromatic_colors": [p["hex"] for p in chroma], "pairs": pairs,
            "note": "No strongly chromatic colors: palette is neutral/greyscale-led." if not chroma else None}


def tonal_range(lab):
    L = lab[..., 0].ravel()
    p5, p50, p95 = np.percentile(L, [5, 50, 95])
    spread = p95 - p5
    label = "very flat" if spread < 25 else "low contrast" if spread < 45 else "moderate" if spread < 70 else "high contrast"
    return {"lightness_p5": round(float(p5), 1), "lightness_median": round(float(p50), 1), "lightness_p95": round(float(p95), 1),
            "spread": round(float(spread), 1), "label": label}


def seams(lab, rgb, strip=6):
    """Find section-background transitions down the page.

    Measured on the outer margins (left/right ~5%), where section backgrounds show and content usually
    doesn't, so buttons and text blocks aren't mistaken for section edges. Full-bleed images do reach the
    margins; those transitions are real visual edges too.
    abrupt = color jumps between neighboring bands; fade = a long run of small steps (gradient / blend).
    """
    h = lab.shape[0] - lab.shape[0] % strip
    if h < strip * 3:
        return {"hard": [], "soft": []}
    w = lab.shape[1]
    m = max(2, int(w * 0.05))
    cols = np.r_[0:m, w - m:w]
    L = lab[:h, cols]
    R = rgb[:h, cols]
    bands = L.reshape(h // strip, strip, len(cols), 3).mean(axis=(1, 2))
    bands_rgb = R.reshape(h // strip, strip, len(cols), 3).mean(axis=(1, 2))
    de = np.linalg.norm(np.diff(bands, axis=0), axis=1)
    hard = []
    for i in np.where(de > 10)[0]:
        s = {"y": int((i + 1) * strip), "delta_e": round(float(de[i]), 1),
             "above": hexof(bands_rgb[max(i - 1, 0)]), "below": hexof(bands_rgb[min(i + 2, len(bands_rgb) - 1)])}
        if hard and s["y"] - hard[-1]["y"] <= strip * 2:
            if s["delta_e"] > hard[-1]["delta_e"]:
                hard[-1] = s
        else:
            hard.append(s)
    soft, i, n = [], 0, len(de)
    while i < n:
        if de[i] < 4:
            j = i
            while j < n and de[j] < 4:
                j += 1
            travel = float(np.linalg.norm(bands[j] - bands[i]))
            if travel > 15 and (j - i) >= 10:
                soft.append({"from_y": int(i * strip), "to_y": int(j * strip), "delta_e": round(travel, 1),
                             "from": hexof(bands_rgb[i]), "to": hexof(bands_rgb[j])})
            i = j
        else:
            i += 1
    return {"hard": hard[:40], "soft": soft[:20],
            "note": "measured on page margins. hard = abrupt change between neighboring bands (a visible seam); "
                    "soft = gradual blend over 60px+ (gradient or fade)"}


def density(rgb, lab, bands=10):
    gray = rgb.mean(-1)
    gy, gx = np.gradient(gray)
    edges = np.hypot(gx, gy)
    h = rgb.shape[0]
    out = []
    for k in range(bands):
        y0, y1 = int(k * h / bands), int((k + 1) * h / bands)
        e = float((edges[y0:y1] > 20).mean())
        block = lab[y0:y1].reshape(-1, 3)
        q = np.round(block / 4)
        vals, counts = np.unique(q, axis=0, return_counts=True)
        mode = vals[counts.argmax()] * 4
        uniform = float((np.linalg.norm(block - mode, axis=1) < 6).mean())
        label = "busy" if e > 0.12 else "moderate" if e > 0.05 else "calm"
        out.append({"from_y": y0, "to_y": y1, "edge_density": round(e, 3), "uniform_space": round(uniform, 2), "label": label})
    return out


def analyze(path, max_side=900):
    img = Image.open(path).convert("RGB")
    w0, h0 = img.size
    scale = min(1.0, max_side / max(w0, h0)) if max(w0, h0) > max_side else 1.0
    if scale < 1.0:
        img = img.resize((max(1, int(w0 * scale)), max(1, int(h0 * scale))), Image.LANCZOS)
    rgb = np.asarray(img, dtype=float)
    lab = srgb_to_lab(rgb)
    sample = rgb.reshape(-1, 3)
    if len(sample) > 40000:
        sample = sample[np.random.default_rng(0).choice(len(sample), 40000, replace=False)]
    centers, shares = kmeans(sample, k=6)
    palette = []
    for c, s in zip(centers, shares):
        h_, s_, l_ = hsl(c)
        palette.append({"hex": hexof(c), "share": round(float(s), 3), "hue": h_, "saturation": s_, "lightness": l_})
    cf, cf_label = colorfulness(rgb)
    sat = np.array([colorsys.rgb_to_hls(*(p / 255.0))[2] for p in sample[:: max(1, len(sample) // 5000)]])
    res = {
        "image": path, "size": [w0, h0], "analyzed_at_scale": round(scale, 3),
        "palette": palette,
        "harmony": harmony(palette),
        "colorfulness": {"score": cf, "label": cf_label, "scale": "Hasler & Suesstrunk 2003"},
        "saturation": {"mean": round(float(sat.mean()), 2), "share_vivid": round(float((sat > 0.5).mean()), 2)},
        "tonal_range": tonal_range(lab),
        "seams": seams(lab, rgb),
        "density": density(rgb, lab),
    }
    if scale < 1.0:  # report seam/density positions in original image pixels
        for s in res["seams"]["hard"]:
            s["y"] = int(s["y"] / scale)
        for s in res["seams"]["soft"]:
            s["from_y"], s["to_y"] = int(s["from_y"] / scale), int(s["to_y"] / scale)
        for d in res["density"]:
            d["from_y"], d["to_y"] = int(d["from_y"] / scale), int(d["to_y"] / scale)
    return res


def readout(r):
    L = [f"{r['image']} ({r['size'][0]}x{r['size'][1]})"]
    L.append("Palette: " + ", ".join(f"{p['hex']} {int(p['share'] * 100)}%" for p in r["palette"]))
    L.append(f"Colorfulness: {r['colorfulness']['score']} ({r['colorfulness']['label']}); mean saturation {r['saturation']['mean']}, vivid share {r['saturation']['share_vivid']}")
    t = r["tonal_range"]
    L.append(f"Tonal range: {t['label']} (lightness {t['lightness_p5']}-{t['lightness_p95']}, spread {t['spread']})")
    h = r["harmony"]
    if h["note"]:
        L.append(f"Harmony: {h['note']}")
    for p in h["pairs"][:6]:
        L.append(f"Harmony: {p['a']} + {p['b']}: {p['hue_difference']} deg apart -> {p['relationship']}")
    s = r["seams"]
    L.append(f"Seams: {len(s['hard'])} abrupt transitions, {len(s['soft'])} smooth fades")
    for x in s["hard"][:8]:
        L.append(f"  abrupt at y={x['y']}px: {x['above']} -> {x['below']} (dE {x['delta_e']})")
    for x in s["soft"][:5]:
        L.append(f"  fade y={x['from_y']}-{x['to_y']}px: {x['from']} -> {x['to']}")
    L.append("Density by band: " + " | ".join(d["label"] for d in r["density"]))
    return "\n".join(L)


def compare(before, after, out, labels=("Before", "After")):
    a, b = Image.open(before).convert("RGB"), Image.open(after).convert("RGB")
    h = max(a.height, b.height)
    pad, top = 24, 36
    canvas = Image.new("RGB", (a.width + b.width + pad * 3, h + top + pad), "white")
    canvas.paste(a, (pad, top))
    canvas.paste(b, (a.width + pad * 2, top))
    d = ImageDraw.Draw(canvas)
    d.text((pad, 10), labels[0], fill=(30, 30, 30))
    d.text((a.width + pad * 2, 10), labels[1], fill=(30, 30, 30))
    canvas.save(out, quality=88)
    ra, rb = analyze(before), analyze(after)
    delta = {
        "colorfulness": [ra["colorfulness"]["score"], rb["colorfulness"]["score"]],
        "tonal_spread": [ra["tonal_range"]["spread"], rb["tonal_range"]["spread"]],
        "abrupt_seams": [len(ra["seams"]["hard"]), len(rb["seams"]["hard"])],
        "smooth_fades": [len(ra["seams"]["soft"]), len(rb["seams"]["soft"])],
    }
    return out, delta


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("image")
    a.add_argument("--json", action="store_true")
    c = sub.add_parser("compare")
    c.add_argument("before")
    c.add_argument("after")
    c.add_argument("-o", "--out", default="compare.jpg")
    c.add_argument("--labels", nargs=2, default=["Before", "After"])
    args = ap.parse_args()
    if args.cmd == "analyze":
        r = analyze(args.image)
        print(json.dumps(r, indent=2) if args.json else readout(r))
    else:
        out, delta = compare(args.before, args.after, args.out, args.labels)
        print(f"saved {out}")
        for k, (x, y) in delta.items():
            print(f"  {k}: {x} -> {y}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:  # output piped into head/grep that closed early
        sys.stderr.close()
        sys.exit(0)
