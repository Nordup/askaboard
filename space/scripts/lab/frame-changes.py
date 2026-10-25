"""When the board changed, from screencast frames (beats.mjs).

Input: a JSON file {frames: [{file, t}], rect: {x, y, width, height} | null, cssW}.
It compares each frame with the one before over the canvas (without its top
8 % and bottom 15 %: the top bar and the caption band), downscaled to 320 px
wide in grey. A frame "changes" when at least 3 pixels differ by more than 24
levels. Prints JSON: first_change_ms, last_change_ms, changes (times),
stills (gaps between changes, from the first change to the last) and
longest_still_ms. Times are in ms from the run's start.
"""
import json
import sys

from PIL import Image, ImageChops

spec = json.load(open(sys.argv[1]))
frames = spec["frames"]
rect = spec.get("rect")
css_w = spec.get("cssW")

prev = None
changes = []
for f in frames:
    try:
        img = Image.open(f["file"]).convert("L")
    except Exception:
        continue
    w, h = img.size
    if rect and css_w:
        k = w / css_w
        x0, y0 = rect["x"] * k, rect["y"] * k
        x1, y1 = x0 + rect["width"] * k, y0 + rect["height"] * k
    else:
        x0, y0, x1, y1 = 0, 0, w, h
    hh = y1 - y0
    box = (int(x0), int(y0 + hh * 0.08), int(x1), int(y1 - hh * 0.15))
    img = img.crop(box)
    scale = 320 / max(1, img.size[0])
    img = img.resize((320, max(1, int(img.size[1] * scale))))
    if prev is not None and prev.size == img.size:
        diff = ImageChops.difference(img, prev).point(lambda v: 255 if v > 24 else 0)
        count = diff.histogram()[255]
        if count >= 3:
            changes.append(f["t"])
    prev = img

stills = []
for a, b in zip(changes, changes[1:]):
    if b - a > 250:
        stills.append({"from_ms": round(a), "to_ms": round(b), "ms": round(b - a)})
print(
    json.dumps(
        {
            "first_change_ms": round(changes[0]) if changes else None,
            "last_change_ms": round(changes[-1]) if changes else None,
            "changes": [round(t) for t in changes],
            "stills": stills,
            "longest_still_ms": max((s["ms"] for s in stills), default=0),
        }
    )
)
