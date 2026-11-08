"""Make a filmstrip PNG: a grid of frames, each with a label under it.

Called by common.mjs with one argument, a JSON file:
  {"tiles": [{"file": "...", "label": "1.2 s  slices"}], "out": "...png", "columns": 4, "width": 480}
Needs Pillow (the Homebrew ffmpeg has no drawtext filter).
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

spec = json.load(open(sys.argv[1]))
tiles = spec["tiles"]
cols = max(1, min(spec.get("columns", 4), len(tiles)))
width = spec.get("width", 480)
rows = (len(tiles) + cols - 1) // cols
gap, label_h = 12, 34
bg, fg, dim = (18, 18, 20), (236, 236, 240), (150, 150, 160)

images = [Image.open(t["file"]).convert("RGB") for t in tiles]
height = max(1, round(width * images[0].height / images[0].width))
try:
    font = ImageFont.load_default(size=20)
except TypeError:
    font = ImageFont.load_default()

sheet = Image.new("RGB", (cols * width + (cols + 1) * gap, rows * (height + label_h) + (rows + 1) * gap), bg)
draw = ImageDraw.Draw(sheet)
for i, (tile, image) in enumerate(zip(tiles, images)):
    x = gap + (i % cols) * (width + gap)
    y = gap + (i // cols) * (height + label_h + gap)
    sheet.paste(image.resize((width, height), Image.LANCZOS), (x, y))
    draw.rectangle([x, y, x + width - 1, y + height - 1], outline=(60, 60, 66))
    draw.text((x + 2, y + height + 6), tile.get("label", ""), fill=fg, font=font)
sheet.save(spec["out"])
