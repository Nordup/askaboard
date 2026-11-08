# The live-drawing lab

Experiments for the live-drawing expedition
(`docs/history/live-drawing-plan.md`). Run everything from `apps/desktop/`.
These are experiments, not tests.

## Start the lab app

```sh
node scripts/lab/lab.mjs start            # dev renderer (electron-vite dev); --built for `electron .` on out/
node scripts/lab/lab.mjs status
node scripts/lab/lab.mjs stop             # stops only the PIDs in its state file
```

The app gets a scratch HOME, user-data-dir, traces and a learning folder with
one board under `/tmp/claude-<uid>/ls-lab/<name>/` (on the Mac `/private/tmp/claude-501/…`; `LS_SCRATCH_ROOT` sets another root; `--name`, default
`lab`; `--fresh` starts from an empty board). Ports: MCP 47890, debug 9490
(`--mcp-port`, `--debug-port`). Never 47821 (the founder's app).

## Play a program

```sh
node scripts/lab/play.mjs scripts/lab/programs/sphere-sketch.js [--name sphere] [--title "Sphere"]
node scripts/lab/play.mjs --tool get_screenshot --args '{"target":"content"}'
```

It calls `write_scene` and then `play_scene` start (or any tool with `--tool`/`--args`) on the lab app and
records the board with the CDP screencast until the scene has played: it
follows the scene through the dev hook and resumes each pause step with
play_scene resume after `--pause-hold S` seconds (default 2); `--seconds N` is a
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
node scripts/lab/council.mjs --client claude --task stddev --brief-only --brief ../../docs/history/drafts/brief-v18.md
```

Flags: `--brief-only` (the task alone, as in a real session), `--no-code` and
`--no-html` (hide worlds or HTML from the agent), `--brief <file>` (serve
a draft brief), `--no-web`, `--interview`. See the script header.

`--learner-board council/learners/ladder.js` opens the board with the
learner's own work: a scene program (`write()`, `stroke()`) that
`learner-board.mjs` turns into the learner's ink with the app's own scene
library and hand (D17). A task in `tasks.json` can name one as `"learner"`.
`--file <path>` puts a learner's file (a spreadsheet) in the learning folder.

It starts a fresh app (`--name council`, MCP 47891, debug 9491) with the
learner's work when the run has it, runs the agent headless with
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
`CODEX_HOME` (`/tmp/claude-<uid>/ls-lab/codex-home`); its `auth.json`
is a symlink to the founder's login. Never read or print it.

## Videos

`video.mp4` is the watch video: a stretch with no visible change for more
than 1.5 s plays in 0.6 s. During the cut a label shows the real wait and
what happened, from the trace ("38 s  model writing write_scene", "model
thinking", "get_screenshot running", "session starting", "model
answering"), and a clock in the corner shows real time. `video-real.mp4`
keeps real time. `recut.py` (Pillow, frames piped to ffmpeg) makes the watch
video; `meta.json` has `numbers.watch_s`, `numbers.recorded_s` and `cuts`.

## Record a board video (fixed clock)

```sh
npm run build
node scripts/lab/record.mjs job.json [--copies 12] [--frames 0-299] [--keep-frames] [--no-audio]
```

Not for the website: its use cases play the scene in the browser with
JavaScript (`export-scene.mjs`, D16, D17). For a video file of an existing
scene (a launch video): frame k shows scene time t0 + k/fps
exactly, however long a frame takes. The job file names the scene, its
sources, the camera, fps and size (see the script header). The script starts
`--copies` built lab apps (on Linux with no display, each in its own headless
mutter) and gives each a slice of the frames. For each frame it calls the dev
hook `scene.frameAt(t)` (the scene held at t, every world drawn at exactly t,
the page painted) and takes one screenshot. Then ffmpeg makes the H.264 video
with the voice lines at their scene times, and a poster. `<work>/report.json`
lists the repeated frames, the frames per second and the CPU use. It stops
the exact PIDs it started.

## The gallery

Runs go to `apps/desktop/.lab/runs/<YYYYMMDD-HHMMSS>-<slug>/` (not in git).
`play.mjs` and `council.mjs` rebuild `apps/desktop/.lab/index.html`;
`node scripts/lab/gallery.mjs` does it by hand. Browsers can block video and
images on `file://` pages: serve the folder instead, for example
`python3 -m http.server 8765 --bind 127.0.0.1 -d apps/desktop/.lab`. To share it,
zip `apps/desktop/.lab/`.

Needs ffmpeg (`/opt/homebrew/bin/ffmpeg` on the Mac, else `ffmpeg` on PATH)
and Python 3 with Pillow (for the filmstrip labels: the Homebrew ffmpeg has no
`drawtext`).
