# The live-drawing lab

Experiments for the live-drawing expedition
(`docs/learning-space/live-drawing-plan.md`). Run everything from `space/`.
These are experiments, not tests.

## Start the lab app

```sh
node scripts/lab/lab.mjs start            # dev renderer (electron-vite dev); --built for `electron .` on out/
node scripts/lab/lab.mjs status
node scripts/lab/lab.mjs stop             # stops only the PIDs in its state file
```

The app gets a scratch HOME, user-data-dir, traces and a learning folder with
one board under `/private/tmp/claude-501/ls-lab/<name>/` (`--name`, default
`lab`; `--fresh` starts from an empty board). Ports: MCP 47890, debug 9490
(`--mcp-port`, `--debug-port`). Never 47821 (the founder's app).

## Play a program

```sh
node scripts/lab/play.mjs scripts/lab/programs/sphere-sketch.js [--name sphere] [--title "Sphere"]
node scripts/lab/play.mjs --tool get_screenshot --args '{"target":"content"}'
```

It calls `run_scene` (or any tool with `--tool`/`--args`) on the lab app and
records the board with the CDP screencast until the scene has played: it
follows the scene through the dev hook and resumes each pause step with
scene_control after `--pause-hold S` seconds (default 2); `--seconds N` is a
minimum. The run folder gets `program.js`, `result.json`, `video.mp4` (H.264,
max 1280 px wide; see "Videos" below), `video-real.mp4` (real speed, from the
scene's start to its end), `filmstrip.png` (the screencast frame when the
scene reached each step, and the end), `final.png` and `meta.json`.
`--no-crop` keeps the whole window.

## Run a council

```sh
node scripts/lab/council.mjs --client codex --task sphere            # gpt-6.1-sol, effort medium
node scripts/lab/council.mjs --client claude --model opus --task fusion
node scripts/lab/council.mjs --client codex --effort low --task "Explain eclipses."
node scripts/lab/council.mjs --client claude --task stddev --brief-only --brief ../docs/learning-space/drafts/brief-v18.md
```

Flags: `--brief-only` (the task alone, as in a real session), `--no-code` and
`--no-html` (hide code items or HTML from the agent), `--brief <file>` (serve
a draft brief), `--no-web`, `--interview`. See the script header.

It starts a fresh app (`--name council`, MCP 47891, debug 9491), draws the
learner's strokes when the task has them, runs the agent headless with
`council/purpose.md` + the task (only the task with `--brief-only`), and
records the board. Tasks are in `council/tasks.json`.

The run ends when the board is done: the agent has finished and the last
scene has played, plus 1 s. The script takes `final.png` and `board.png`
from the live app and stops the app at once. Then it writes the filmstrip,
`calls.json` and `meta.json`, and `media.mjs` makes the two videos in the
background (log: `media.log` in the run folder), so the next run can start.
`meta.json` has `media: "pending"` until the videos are made; the gallery
card shows `final.png` until then. `--wait-media` waits for the videos
before the script exits. Two video jobs can run at once.

`--interview` adds phase 2: before the app stops, the script resumes the
same session with `council/interview.md` and saves the answer as
`feedback.md` (about 1 min). It is off by default. Without it, the gallery
card has no feedback section. Codex uses its own scratch
`CODEX_HOME` (`/private/tmp/claude-501/ls-lab/codex-home`); its `auth.json`
is a symlink to the founder's login. Never read or print it.

## Videos

`video.mp4` is the watch video: a stretch with no visible change for more
than 1.5 s plays in 0.6 s. During the cut a label shows the real wait and
what happened, from the trace ("38 s  model writing run_scene", "model
thinking", "get_screenshot running", "session starting", "model
answering"), and a clock in the corner shows real time. `video-real.mp4`
keeps real time. `recut.py` (Pillow, frames piped to ffmpeg) makes the watch
video; `meta.json` has `numbers.watch_s`, `numbers.recorded_s` and `cuts`.

## Live pixel items

```sh
node scripts/lab/live.mjs --port 9490 examples                 # the four programs in programs/live/
node scripts/lab/live.mjs --port 9490 add programs/live/ripples.glsl --at 0,0 --param k=80
node scripts/lab/live.mjs --port 9490 list                     # state and frame count of each item
node scripts/lab/live.mjs --port 9490 validate my-shader.glsl  # compile log or "ok"
node scripts/lab/mcp-call.mjs --port 47890 get_screenshot '{"target":"content"}' --out shot.png
```

`live.mjs` uses the dev hook `window.__spaceDev.live` (no scene API needed).
A `.glsl` file is a shader (`mainImage`, Shadertoy style); a `.js` file is
the body of `function (ctx, t, w, h, params, dt)`. The first line can set
defaults: `// live: shader  size: 600x340  params: k=16 omega=3`.

## The gallery

Runs go to `space/.lab/runs/<YYYYMMDD-HHMMSS>-<slug>/` (not in git).
`play.mjs` and `council.mjs` rebuild `space/.lab/index.html`;
`node scripts/lab/gallery.mjs` does it by hand. Browsers can block video and
images on `file://` pages: serve the folder instead, for example
`python3 -m http.server 8765 --bind 127.0.0.1 -d space/.lab`. To share it,
zip `space/.lab/`.

Needs `/opt/homebrew/bin/ffmpeg` and Python 3 with Pillow (for the filmstrip
labels: this ffmpeg has no `drawtext`).
