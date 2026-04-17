#!/usr/bin/env python3
"""Renders a quotecard PNG from a JSON spec on stdin.

Input JSON:
  {
    "quote": "text",
    "attribution": "optional source",
    "niche": "ai" | "finance" | "make-money-with-ai",
    "template": "default",
    "out_path": "/path/to/card.png"
  }
"""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1080
BG = (15, 23, 42)
FG = (245, 245, 250)
MUTED = (148, 163, 184)
PAD = 100
MAX_W = W - 2 * PAD

def wrap(draw, text, font, max_w):
    words = text.split()
    lines, cur = [], []
    for w in words:
        cur.append(w)
        bbox = draw.textbbox((0, 0), " ".join(cur), font=font)
        if bbox[2] - bbox[0] > max_w:
            cur.pop()
            if cur: lines.append(" ".join(cur))
            cur = [w]
    if cur: lines.append(" ".join(cur))
    return lines

def pick_font(size):
    candidates = [
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/Library/Fonts/Georgia.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def render(spec):
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    quote = spec["quote"].strip()
    if not quote.startswith('"'): quote = f'"{quote}"'

    size = 56
    font = pick_font(size)
    lines = wrap(draw, quote, font, MAX_W)
    while len(lines) > 9 and size > 28:
        size -= 4
        font = pick_font(size)
        lines = wrap(draw, quote, font, MAX_W)

    line_h = int(size * 1.35)
    total_h = line_h * len(lines)
    y = (H - total_h) // 2 - 20
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        w = bbox[2] - bbox[0]
        draw.text(((W - w) // 2, y), line, font=font, fill=FG)
        y += line_h

    attribution = spec.get("attribution", "").strip()
    if attribution:
        small = pick_font(24)
        draw.text((PAD, H - PAD - 28), attribution, font=small, fill=MUTED)

    niche = spec.get("niche", "")
    if niche:
        small = pick_font(22)
        bbox = draw.textbbox((0, 0), niche, font=small)
        w = bbox[2] - bbox[0]
        draw.text((W - PAD - w, H - PAD - 28), niche, font=small, fill=MUTED)

    out_path = spec["out_path"]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path, "PNG")
    return out_path

if __name__ == "__main__":
    spec = json.load(sys.stdin)
    path = render(spec)
    print(path)
