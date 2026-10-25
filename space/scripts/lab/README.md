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
node scripts/lab/play.mjs --tool draw_ink --args '{"svg_path":"M 100 0 A 100 100 0 1 1 -100 0 A 100 100 0 1 1 100 0"}'
```

It calls `run_scene` (or any tool with `--tool`/`--args`) on the lab app and
records the board with the CDP screencast until the scene has played
(`duration_s` + 1 s, or `--seconds N`). The run folder gets `program.js`,
`result.json`, `video.mp4` (H.264, real speed, max 1280 px wide),
`filmstrip.png` (a frame at each step, by `scene.seek` when the dev hook has
it), `final.png` and `meta.json`. `--no-crop` keeps the whole window.

## Run a council

```sh
node scripts/lab/council.mjs --client codex --task sphere            # gpt-6.1-sol, effort medium
node scripts/lab/council.mjs --client claude --model opus --task fusion
node scripts/lab/council.mjs --client codex --effort low --task "Explain eclipses."
```

It starts a fresh app (`--name council`, MCP 47891, debug 9491), draws the
learner's strokes when the task has them, runs the agent headless with
`council/purpose.md` + the task, and records the board. Then it resumes the
same session with `council/interview.md` and saves the answer as
`feedback.md`. Tasks are in `council/tasks.json`. Codex uses its own scratch
`CODEX_HOME` (`/private/tmp/claude-501/ls-lab/codex-home`); its `auth.json`
is a symlink to the founder's login. Never read or print it.

## The gallery

Runs go to `space/.lab/runs/<YYYYMMDD-HHMMSS>-<slug>/` (not in git).
`play.mjs` and `council.mjs` rebuild `space/.lab/index.html`;
`node scripts/lab/gallery.mjs` does it by hand. Browsers can block video and
images on `file://` pages: serve the folder instead, for example
`python3 -m http.server 8765 --bind 127.0.0.1 -d space/.lab`. To share it,
zip `space/.lab/`.

Needs `/opt/homebrew/bin/ffmpeg` and Python 3 with Pillow (for the filmstrip
labels: this ffmpeg has no `drawtext`).
