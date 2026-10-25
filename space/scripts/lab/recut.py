"""Make the watch video of a lab recording: idle stretches cut short and marked.

Called by common.mjs (encodeWatchVideo) with one argument, a JSON file:
  {
    "frames": [{"file": "...jpg", "t": <wall ms>}],   # screencast frames, sorted by t
    "from": <ms>, "to": <ms>,                          # the recorded span
    "crop": [x, y, w, h] | null,                       # in frame pixels
    "labels": [{"from": <ms>, "to": <ms>, "label": "model writing run_scene"}],
    "playing": [{"from": <ms>, "to": <ms>}],           # when scenes played (never cut by label)
    "idle_ms": 1500, "cut_ms": 600, "fps": 30,
    "out": "video.mp4", "ffmpeg": "/opt/homebrew/bin/ffmpeg"
  }
A stretch with no visible change for longer than idle_ms plays in cut_ms of
video: the frame stays, a label says how long the real wait was and what
happened in it, and the real-time clock in the corner runs fast. A stretch
where the model works (labels "session starting", "model writing …",
"model thinking", "model answering") and no scene plays is cut the same way
even when the picture moves (a live item that keeps running).
Prints JSON: {"watch_s", "real_s", "cuts": [{"at_s", "real_s", "video_at_s", "label"}]}.

Speed (a 10-minute recording of a moving 3D item took 40 minutes before):
the change test decodes each JPEG at 1/8 size (draft mode) in worker
processes, and ffmpeg does all the full-size work in one pass: it reads the
frames through a concat list (each frame once, with its duration on the
watch timeline) and lays a second concat list of small overlay PNGs (the
clock and the cut labels, one per state) over them.
"""
import json
import os
import subprocess
import sys
import tempfile
from multiprocessing import Pool

from PIL import Image, ImageChops, ImageDraw, ImageFont

THUMB_W = 192
LEAD_MS = 200
AGENT_LABELS = ("session starting", "model ")


def thumb(job):
    """A small grey picture of the frame's crop, decoded at reduced size."""
    file, crop = job
    image = Image.open(file)
    full_w, full_h = image.size
    try:
        image.draft("L", (max(1, full_w // 8), max(1, full_h // 8)))
    except Exception:
        pass
    image = image.convert("L")
    k = image.width / full_w
    if crop:
        x, y, w, h = crop
        image = image.crop((round(x * k), round(y * k), round((x + w) * k), round((y + h) * k)))
    return image.resize((THUMB_W, max(1, round(THUMB_W * image.height / max(1, image.width)))), Image.BILINEAR).tobytes(), image.size


def changed(a, b, size):
    ia = Image.frombytes("L", (THUMB_W, len(a) // THUMB_W), a)
    ib = Image.frombytes("L", (THUMB_W, len(b) // THUMB_W), b)
    if ia.size != ib.size:
        return True
    diff = ImageChops.difference(ia, ib).point(lambda v: 255 if v > 10 else 0)
    return diff.histogram()[255] >= 4


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


def subtract(spans, holes):
    """spans minus holes, both lists of (a, b)."""
    out = []
    for a, b in spans:
        pieces = [(a, b)]
        for ha, hb in holes:
            next_pieces = []
            for pa, pb in pieces:
                if hb <= pa or ha >= pb:
                    next_pieces.append((pa, pb))
                    continue
                if ha > pa:
                    next_pieces.append((pa, ha))
                if hb < pb:
                    next_pieces.append((hb, pb))
            pieces = next_pieces
        out.extend(p for p in pieces if p[1] > p[0])
    return out


def main():
    spec = json.load(open(sys.argv[1]))
    frames = [f for f in spec["frames"] if f["t"] <= spec["to"]]
    t_from, t_to = spec["from"], spec["to"]
    idle, cut = spec.get("idle_ms", 1500), spec.get("cut_ms", 600)
    fps = spec.get("fps", 30)
    crop = spec.get("crop")
    labels = spec.get("labels", [])
    playing = [(p["from"], p["to"]) for p in spec.get("playing", [])]
    ffmpeg = spec.get("ffmpeg", "ffmpeg")
    if not frames:
        sys.exit("No frames were recorded.")

    # ---------- Frames in the span, with their visible changes ----------

    start = 0
    for i, f in enumerate(frames):
        if f["t"] <= t_from:
            start = i
    used = frames[start:]
    used[0] = {**used[0], "t": max(t_from, used[0]["t"])}

    with Pool(max(1, min(8, os.cpu_count() or 1))) as pool:
        thumbs = pool.map(thumb, [(f["file"], crop) for f in used], chunksize=64)

    changes = [used[0]["t"]]
    for i in range(1, len(used)):
        if changed(thumbs[i][0], thumbs[i - 1][0], thumbs[i][1]):
            changes.append(used[i]["t"])

    # The model's own time with no scene playing: cut even when a live item moves.
    agent = [(e["from"], e["to"]) for e in labels if e["label"].startswith(AGENT_LABELS)]
    merged = []
    for a, b in sorted(subtract(agent, playing)):
        if merged and a - merged[-1][1] <= 2 * LEAD_MS:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    quiet = [(a, b) for a, b in merged if b - a > idle]
    if quiet:
        inside = lambda t: any(a < t < b for a, b in quiet)
        changes = [t for t in changes if not inside(t)] + [a for a, _ in quiet] + [b for _, b in quiet]
    changes = sorted(set(t for t in changes if t_from <= t <= t_to) | {used[0]["t"], t_to})

    # ---------- The timeline: real segments and cuts ----------
    # Each segment: (video_start_s, video_len_s, real_start_ms, real_len_ms, label or None)

    segments = []
    video = [0.0]

    def add(real_start, real_len, video_len, label):
        if real_len <= 0:
            return
        segments.append((video[0], video_len, real_start, real_len, label))
        video[0] += video_len

    def label_for(a, b):
        """What happened in [a, b] (ms): the labels that fill a real share of it, in time order (at most 3, the longest)."""
        parts = []
        for entry in labels:
            overlap = min(b, entry["to"]) - max(a, entry["from"])
            if overlap >= max(1000, 0.1 * (b - a)):
                parts.append((max(a, entry["from"]), overlap, entry["label"]))
        parts = sorted(sorted(parts, key=lambda p: -p[1])[:3])
        names = []
        for _, _, name in parts:
            if not names or names[-1] != name:
                names.append(name)
        return " → ".join(names) or None

    cuts = []
    for a, b in zip(changes, changes[1:]):
        gap = b - a
        if gap > idle:
            add(a, LEAD_MS, LEAD_MS / 1000, None)
            what = label_for(a + LEAD_MS, b - LEAD_MS) or "no change"
            cuts.append({"at_s": round((a + LEAD_MS - t_from) / 1000, 2), "real_s": round((gap - 2 * LEAD_MS) / 1000, 1), "video_at_s": round(video[0], 2), "label": what})
            add(a + LEAD_MS, gap - 2 * LEAD_MS, cut / 1000, what)
            add(b - LEAD_MS, LEAD_MS, LEAD_MS / 1000, None)
        else:
            add(a, gap, gap / 1000, None)
    total_s = video[0]

    # ---------- Output size ----------

    with Image.open(used[0]["file"]) as first:
        src_w, src_h = first.size
    cw, ch = (crop[2], crop[3]) if crop else (src_w, src_h)
    scale = min(1.0, 1280 / cw)
    out_w = max(2, int(cw * scale) // 2 * 2)
    out_h = max(2, int(ch * scale) // 2 * 2)
    k = out_w / 1000

    work = tempfile.mkdtemp(prefix="recut-", dir=os.path.dirname(os.path.abspath(spec["out"])))
    try:
        # ---------- The frames: one concat list on the watch timeline ----------

        times = [f["t"] for f in used]

        def index_at(t):
            lo, hi = 0, len(times) - 1
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if times[mid] <= t:
                    lo = mid
                else:
                    hi = mid - 1
            return lo

        lines = []
        last_file = used[0]["file"]

        def show(file, seconds):
            nonlocal last_file
            if seconds <= 0:
                return
            lines.append(f"file '{file}'")
            lines.append(f"duration {seconds:.4f}")
            last_file = file

        for v0, vlen, r0, rlen, label in segments:
            if label:
                show(used[index_at(r0)]["file"], vlen)
                continue
            i = index_at(r0)
            t = r0
            end = r0 + rlen
            while t < end:
                nxt = times[i + 1] if i + 1 < len(times) else end
                stop = min(end, max(nxt, t))
                show(used[i]["file"], (stop - t) / 1000)
                t = stop
                i += 1
                if i >= len(times):
                    show(used[-1]["file"], (end - t) / 1000)
                    break
        lines.append(f"file '{last_file}'")
        frames_list = os.path.join(work, "frames.txt")
        with open(frames_list, "w") as handle:
            handle.write("\n".join(lines) + "\n")

        # ---------- The overlays: the clock and the cut labels, one PNG per state ----------

        small = font(max(11, round(15 * k)))
        big = font(max(13, round(20 * k)))
        panel, text, dim = (18, 18, 20, 215), (236, 236, 240, 255), (160, 160, 170, 255)

        def clock(ms):
            s = max(0, int(ms // 1000))
            return f"{s // 60}:{s % 60:02d}"

        pngs = {}

        def overlay(stamp, label, wait_s):
            key = (stamp, label, round(wait_s) if label else 0)
            if key in pngs:
                return pngs[key]
            layer = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
            d = ImageDraw.Draw(layer)
            pad = round(8 * k) + 4
            words = f"real {stamp}"
            box = d.textbbox((0, 0), words, font=small)
            w, h = box[2] - box[0], box[3] - box[1]
            x, y = out_w - w - 3 * pad, out_h - h - 3 * pad
            d.rounded_rectangle([x - pad, y - pad, x + w + pad, y + h + pad], radius=pad, fill=panel)
            d.text((x - box[0], y - box[1]), words, font=small, fill=dim)
            if label:
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
            path = os.path.join(work, f"o{len(pngs)}.png")
            layer.save(path, compress_level=1)
            pngs[key] = path
            return path

        olines = []
        last_png = None

        def hold(path, seconds):
            nonlocal last_png
            if seconds <= 0:
                return
            if olines and olines[-2] == f"file '{path}'":
                prev = float(olines[-1].split()[1])
                olines[-1] = f"duration {prev + seconds:.4f}"
            else:
                olines.append(f"file '{path}'")
                olines.append(f"duration {seconds:.4f}")
            last_png = path

        for v0, vlen, r0, rlen, label in segments:
            if label:
                # The clock runs fast through the cut: ten states.
                n = 10
                for j in range(n):
                    hold(overlay(clock(r0 + rlen * j / n - t_from), label, rlen / 1000), vlen / n)
                continue
            t = r0
            end = r0 + rlen
            while t < end:
                next_second = t_from + (int((t - t_from) // 1000) + 1) * 1000
                stop = min(end, next_second)
                hold(overlay(clock(t - t_from), None, 0), (stop - t) / 1000)
                t = stop
        olines.append(f"file '{last_png}'")
        overlay_list = os.path.join(work, "overlay.txt")
        with open(overlay_list, "w") as handle:
            handle.write("\n".join(olines) + "\n")

        # ---------- One ffmpeg pass ----------

        crop_filter = f"crop={crop[2]}:{crop[3]}:{crop[0]}:{crop[1]}," if crop else ""
        graph = (
            f"[0:v]{crop_filter}scale={out_w}:{out_h}:out_range=tv,setsar=1,fps={fps}[v];"
            f"[1:v]format=rgba,fps={fps}[o];"
            f"[v][o]overlay=0:0:eof_action=repeat,format=yuv420p[out]"
        )
        subprocess.run(
            [
                ffmpeg, "-y", "-v", "error",
                "-f", "concat", "-safe", "0", "-i", frames_list,
                "-f", "concat", "-safe", "0", "-i", overlay_list,
                "-filter_complex", graph, "-map", "[out]",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-color_range", "tv",
                "-profile:v", "high", "-level", "4.1", "-movflags", "+faststart",
                "-t", f"{total_s:.3f}", spec["out"],
            ],
            check=True,
        )
    finally:
        for name in os.listdir(work):
            os.remove(os.path.join(work, name))
        os.rmdir(work)
    print(json.dumps({"watch_s": round(total_s, 1), "real_s": round((t_to - t_from) / 1000, 1), "cuts": cuts}))


if __name__ == "__main__":
    main()
