"""Make the watch video of a lab recording: idle stretches cut short and marked.

Called by common.mjs (encodeWatchVideo) with one argument, a JSON file:
  {
    "frames": [{"file": "...jpg", "t": <wall ms>}],   # screencast frames, sorted by t
    "from": <ms>, "to": <ms>,                          # the recorded span
    "crop": [x, y, w, h] | null,                       # in frame pixels
    "labels": [{"from": <ms>, "to": <ms>, "label": "model writing run_scene"}],
    "idle_ms": 1500, "cut_ms": 600, "fps": 30,
    "out": "video.mp4", "ffmpeg": "/opt/homebrew/bin/ffmpeg"
  }
A stretch with no visible change for longer than idle_ms plays in cut_ms of
video: the frame stays, a label says how long the real wait was and what
happened in it, and the real-time clock in the corner runs fast. Frames go
to ffmpeg as raw RGB through a pipe (this ffmpeg has no drawtext filter).
Prints JSON: {"watch_s", "real_s", "cuts": [{"at_s", "real_s", "video_at_s", "label"}]}.
"""
import json
import subprocess
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

spec = json.load(open(sys.argv[1]))
frames = [f for f in spec["frames"] if f["t"] <= spec["to"]]
t_from, t_to = spec["from"], spec["to"]
idle, cut = spec.get("idle_ms", 1500), spec.get("cut_ms", 600)
fps = spec.get("fps", 30)
crop = spec.get("crop")
labels = spec.get("labels", [])
if not frames:
    sys.exit("No frames were recorded.")

# ---------- Frames in the span, with their visible changes ----------

start = 0
for i, f in enumerate(frames):
    if f["t"] <= t_from:
        start = i
used = frames[start:]
used[0] = {**used[0], "t": max(t_from, used[0]["t"])}


def load(file):
    image = Image.open(file).convert("RGB")
    if crop:
        x, y, w, h = crop
        image = image.crop((x, y, x + w, y + h))
    return image


def thumb(image):
    return image.convert("L").resize((192, max(1, round(192 * image.height / image.width))), Image.BILINEAR)


# A frame is a visible change when enough thumbnail pixels differ from the frame before it.
changes = [used[0]["t"]]
previous = thumb(load(used[0]["file"]))
for f in used[1:]:
    current = thumb(load(f["file"]))
    diff = ImageChops.difference(current, previous).point(lambda v: 255 if v > 10 else 0)
    if diff.histogram()[255] >= 4:
        changes.append(f["t"])
    previous = current
changes.append(t_to)

# ---------- The timeline: real segments and cuts ----------
# Each segment: (video_start_s, video_len_s, real_start_ms, real_len_ms, label or None)

segments = []
video = 0.0


def add(real_start, real_len, video_len, label):
    global video
    if real_len <= 0:
        return
    segments.append((video, video_len, real_start, real_len, label))
    video += video_len


def label_for(a, b):
    """The label that covers most of [a, b] (ms)."""
    best, best_overlap = None, 0
    for entry in labels:
        overlap = min(b, entry["to"]) - max(a, entry["from"])
        if overlap > best_overlap:
            best, best_overlap = entry["label"], overlap
    return best if best_overlap >= 0.3 * (b - a) else None


cuts = []
for a, b in zip(changes, changes[1:]):
    gap = b - a
    if gap > idle:
        # A short real lead-in after the change, then the cut, then the moment before the next change.
        lead = 200
        add(a, lead, lead / 1000, None)
        what = label_for(a + lead, b - lead) or "no change"
        cuts.append({"at_s": round((a + lead - t_from) / 1000, 2), "real_s": round((gap - 2 * lead) / 1000, 1), "video_at_s": round(video, 2), "label": what})
        add(a + lead, gap - 2 * lead, cut / 1000, what)
        add(b - lead, lead, lead / 1000, None)
    else:
        add(a, gap, gap / 1000, None)

# ---------- Drawing ----------

first = load(used[0]["file"])
scale = min(1.0, 1280 / first.width)
out_w = max(2, int(first.width * scale) // 2 * 2)
out_h = max(2, int(first.height * scale) // 2 * 2)
k = out_w / 1000  # overlay sizes follow the video width


def font(size):
    for path in ("/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


small = font(max(11, round(15 * k)))
big = font(max(13, round(20 * k)))
panel, text, dim = (18, 18, 20, 215), (236, 236, 240, 255), (160, 160, 170, 255)


def clock(ms):
    s = max(0, int(ms // 1000))
    return f"{s // 60}:{s % 60:02d}"


def overlay(image, real_ms, label, wait_s):
    canvas = image.convert("RGBA")
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pad = round(8 * k) + 4
    # The real-time clock, bottom right.
    stamp = f"real {clock(real_ms - t_from)}"
    box = d.textbbox((0, 0), stamp, font=small)
    w, h = box[2] - box[0], box[3] - box[1]
    x, y = out_w - w - 3 * pad, out_h - h - 3 * pad
    d.rounded_rectangle([x - pad, y - pad, x + w + pad, y + h + pad], radius=pad, fill=panel)
    d.text((x - box[0], y - box[1]), stamp, font=small, fill=dim)
    if label:
        # The cut: a pause sign, the real wait and what happened.
        words = f"{wait_s:.0f} s  {label}" if wait_s >= 1 else label
        box = d.textbbox((0, 0), words, font=big)
        w, h = box[2] - box[0], box[3] - box[1]
        icon = round(h * 0.9)
        x, y = 3 * pad, 3 * pad
        d.rounded_rectangle([x - pad, y - pad, x + icon + pad + w + pad, y + h + pad], radius=pad, fill=panel)
        bar = max(2, icon // 3)
        d.rectangle([x, y, x + bar, y + h], fill=text)
        d.rectangle([x + icon - bar, y, x + icon, y + h], fill=text)
        d.text((x + icon + pad - box[0], y - box[1]), words, font=big, fill=text)
    return Image.alpha_composite(canvas, layer).convert("RGB")


cache = {}


def picture(file):
    if file not in cache:
        cache.clear()
        image = load(file)
        cache[file] = image.resize((out_w, out_h), Image.LANCZOS) if image.size != (out_w, out_h) else image
    return cache[file]


times = [f["t"] for f in used]


def frame_at(t):
    lo, hi = 0, len(times) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if times[mid] <= t:
            lo = mid
        else:
            hi = mid - 1
    return used[lo]["file"]


encoder = subprocess.Popen(
    [
        spec.get("ffmpeg", "ffmpeg"), "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}", "-r", str(fps), "-i", "-",
        "-vf", "scale=out_range=tv,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-color_range", "tv",
        "-profile:v", "high", "-level", "4.1", "-movflags", "+faststart", spec["out"],
    ],
    stdin=subprocess.PIPE,
)
total = max(1, round(video * fps))
index = 0
for n in range(total):
    tau = n / fps
    while index + 1 < len(segments) and segments[index + 1][0] <= tau:
        index += 1
    v0, vlen, r0, rlen, label = segments[index]
    share = min(1.0, max(0.0, (tau - v0) / vlen)) if vlen > 0 else 0.0
    real = r0 + share * rlen
    source = frame_at(r0 if label else real)
    encoder.stdin.write(overlay(picture(source), real, label, rlen / 1000).tobytes())
encoder.stdin.close()
if encoder.wait() != 0:
    sys.exit("ffmpeg failed")
print(json.dumps({"watch_s": round(video, 1), "real_s": round((t_to - t_from) / 1000, 1), "cuts": cuts}))
