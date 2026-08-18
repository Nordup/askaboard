# Math Tutor backend service

A FastAPI service that sits between the iPad app and OpenAI. It exists for
two reasons.

**It holds the single OpenAI key so the iPad app ships none.** The prototype
client-side path put an API key in the device's Keychain and sent it to OpenAI
directly — workable for a demo, not for anything that leaves one developer's
hands. That path is deleted: the app has no OpenAI credential and no setup
surface at all, and this service holds the only OpenAI key that exists
anywhere. The device authenticates to *this* service instead, with a bearer token
(`DEVICE_TOKEN`), never with a provider key. The token is compared with
`secrets.compare_digest` in [`app/auth.py`](app/auth.py) so a timing attack
can't recover it byte by byte.

**It is the recorder.** Every message, the full request envelope sent to
OpenAI, the raw provider event stream, board snapshots, and dictation
recordings are written to Postgres and a blob store as they happen — not
sampled, not summarised. See [`app/store/recorder.py`](app/store/recorder.py)
for the write path and [Retention](#retention) below.

**It streams turns in its own event vocabulary, not OpenAI's.** A turn is
`POST /v1/turn`, answered as Server-Sent Events using six event types this
service defines — `status`, `reasoning_delta`, `text_delta`, `workspace`,
`done`, `error` — translated in
[`app/tutor/events.py`](app/tutor/events.py) from whatever the Responses API
actually emits. The client never sees an OpenAI event name. That's what lets
the provider, the model, or the prompt change without an App Store release:
only this service needs to change, and the wire contract to the app stays
fixed.

## Setup

```sh
cd server
uv sync
cp .env.example .env   # then fill in real values — see below
uv run alembic upgrade head
```

**`alembic upgrade head` creates the tables; it does not fill the curriculum.**
The 480 Common Core standards and their 899 prerequisite/related edges come
from a checked-in JSON (`app/learner/seed/ccss_kcs.json`) and are written by
`app.learner.kcs.seed_curriculum`, which the service runs **on every startup**.
It is idempotent and keyed on the standard's code, so a re-run refreshes a
standard's wording and never its id — the ids are what observations and mastery
state point at. There is no manual seed step, and deliberately no seed inside a
migration: the JSON is regenerated from an upstream source by
`scripts/build_kc_seed.py`, and a migration carrying it would have to be
re-opened every time that happens (see `migrations/versions/0004_learner_model.py`).

Until it lands the learner model is inert rather than merely empty: the tutor's
`record_evidence` calls resolve their standard codes against `kcs`, an empty
table resolves none of them, and every call is answered "none of those codes
are in the curriculum". A successful boot logs `curriculum seeded | kcs=480`; a
failed one logs why and the service still comes up.

### Environment variables

| Variable | What it's for |
| --- | --- |
| `OPENAI_API_KEY` | The one OpenAI key. Never sent to the device. |
| `DATABASE_URL` | The Postgres (Neon) connection string the app writes to. |
| `DEVICE_TOKEN` | The bearer token the iPad app presents. Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. |
| `BLOB_DIR` | *Optional*, defaults to `./blobs`. Local directory for the blob store (board PNGs, ink, dictation audio, raw event logs). |
| `LOG_DIR` | *Optional*, defaults to `./logs`. Where the rotating `server.log` is written. See [When a turn goes wrong](#when-a-turn-goes-wrong). |
| `DAILY_SPEND_CAP_USD` | *Optional*, defaults to `5.0`. Turns are refused with `402` once today's recorded spend — turns plus reported voice usage, priced from the tables in [`app/config.py`](app/config.py) — reaches this. See [Known limitations](#known-limitations) for what the sum still misses. |
| `PERSIST_DICTATION_AUDIO` | *Optional*, defaults to **`true`**. Whether dictation recordings are written to the blob store. Leaving this unset does not mean recordings are skipped — it means they're kept, same as if you'd set it to `true` explicitly. Retention below applies whenever this is `true`. |
| `TEST_DATABASE_URL` | A **separate** database the test suite runs against. See the warning immediately below — do not skip it. |

The three marked *optional* have defaults in [`app/config.py`](app/config.py) and can be left out of `.env` entirely; the rest are required and the service will not start without them.

> **`TEST_DATABASE_URL` must point at a different Neon branch than
> `DATABASE_URL`.** Each test run creates its own Postgres schema
> (`test_<uuid>`) on whatever `TEST_DATABASE_URL` names, and drops that
> schema — never the rest of the branch — at the end of the run. If it's
> ever the same branch as `DATABASE_URL`, that schema still lives alongside
> real data on that branch, which is not where test data belongs. Use a
> dedicated Neon branch (e.g. a branch literally named `test`) and never
> point it at the branch the app itself uses.

`.env` holds real secrets and is gitignored. Never commit it, print it, or
paste a value from it into a README, a commit message, or a chat.

## Running it

```sh
scripts/run-server.sh
```

This starts `uvicorn` with `--reload` on port 8080, bound to `0.0.0.0`
rather than `127.0.0.1`. That's deliberate, not an oversight: the iOS
Simulator can reach `127.0.0.1`, but a physical iPad on the same Wi-Fi
network cannot — it needs the Mac's actual LAN address, which only resolves
if the server is listening on every interface. Don't "fix" this to
`127.0.0.1`; that quietly breaks the physical-device path described next.

**The tutor prompt ships from the backend, not from the app.** The production system prompt is [`app/tutor/prompt.py`](app/tutor/prompt.py); installing or rebuilding the iPad app does not update it. `scripts/run-server.sh` starts uvicorn with `--reload`, so a process started that way picks up `prompt.py` edits automatically. Any backend process started without `--reload` (for example the tailnet host) must be restarted before a prompt change takes effect. Verify against a real trace, not by reading code: run one `POST /v1/turn`, then `GET /v1/turns/{id}` with the same `DEVICE_TOKEN` and inspect `llm_calls[].request` — that endpoint records the exact request JSON the provider received.

### Reaching the service

- **iOS Simulator**: `http://localhost:8080`. Simulator and Mac share a
  network stack, so this works with no extra configuration.
- **Physical iPad**: point the app at the Mac's LAN address (e.g.
  `http://192.168.1.23:8080`) instead of `localhost`. Two things follow from
  that:
  - The connection is plain HTTP, so iOS's App Transport Security will
    refuse it unless the app's `Info.plist` carries an ATS exception for
    that host (or the whole local-network case) during development.
  - The Mac and the iPad have to actually be reachable from each other —
    same Wi-Fi network, or a tunnel (e.g. `ngrok`, `cloudflared`) if they
    aren't. A tunnel also sidesteps the ATS problem, since it terminates
    TLS for you.

## The event vocabulary

Every `POST /v1/turn` and `POST /v1/dictation` response is
`text/event-stream`, one JSON object per `data:` line, `type` discriminating
which of these it is:

| `type` | Meaning |
| --- | --- |
| `status` | The current phase: `thinking`, `looking` (an image is being uploaded, or the tutor is reading a region of the board), `searching` (a tool call is running), `drawing` (an `update_board` call's arguments are streaming), or `writing` (text has started). Repeats — see [Keeping the stream alive](#keeping-the-stream-alive). |
| `reasoning_delta` | An incremental chunk of the model's reasoning summary. |
| `text_delta` | An incremental chunk of the reply text. |
| `workspace` | A full replacement of the session's plan and exercise, arriving together — see below. |
| `board_update` | A validated batch of tutor-authored scene changes the iPad applies immediately: upserts by stable id (including raw SVG documents), deletes, or a replace-all flag. |
| `done` | The turn finished; carries `turn_id` and token counts. |
| `error` | The turn failed; carries a message and whether the client should retry. |

These are defined once, as Pydantic models, in
[`app/tutor/events.py`](app/tutor/events.py).

## When a turn goes wrong

Two turns once failed in a row, cost about twenty cents each, and left behind
a row saying `running` and nothing else. Reconstructing what happened took an
hour of reading source. These are the three places that now answer it directly.

**1. `logs/server.log`** — a rotating file, written whether or not anyone is
watching the terminal. `uvicorn --reload` writes to stdout, and stdout is gone
the moment that terminal scrolls; this is the copy that is still there
tomorrow. uvicorn's own loggers are captured into it too, so a server that
restarted mid-turn says so in the same file as the turn it interrupted.

Every turn writes a line when it starts and a line when it ends, failed or not:

```
turn started | turn_id=fab8b28c… session_id=4cf009a6… model=gpt-5.6-sol effort=high has_image=False has_board=True history=6
turn ok      | turn_id=fab8b28c… elapsed_ms=62659 ttft_ms=59563 events_sent=41 max_silence_ms=54120 provider_events=812 in=24294 out=4314 reasoning=467
```

**`max_silence_ms` is the one to watch.** It is the longest the connection went
without a single byte, and it is what killed those turns: the client abandons a
request after 60 s of silence. The last turn that *worked* before the two
failures sent nothing for 54 of its 62 seconds — the trend was visible one turn
ahead of the outage, if anything had been recording it.

**2. `turns.error`** — every failed turn now carries the same numbers in JSONB,
so the question can be asked in SQL instead of grep:

```sql
select id, started_at, error->>'message' as message,
       error->'diagnostics'->>'max_silence_ms' as silence_ms,
       input_tokens, output_tokens
from turns where status = 'error' order by started_at desc limit 20;
```

A disconnect after a long silence is a client timeout. A disconnect at a few
hundred milliseconds is someone closing the app. The row used to be unable to
tell you which.

**3. Token counts on failed turns.** `fail_turn` records `input_tokens` /
`output_tokens` / `reasoning_tokens`, not just `finish_turn`. A turn that dies
after the model has generated its answer has still been billed for it, and that
is precisely the case that used to record nothing at all.

**4. On the device.** The app logs the real error, which is the only place it
appears at all — the thread deliberately shows the same fixed copy whatever
happened. A `URLError` is logged with its numeric code, and that code is what
separates the cases that look identical on screen: −1001 timed out, −1005
connection dropped, −1009 no route to the Mac.

These are the iPad's logs, not the Mac's, so a plain `log show` will not find
them — it has to be aimed at the device, which must be connected and unlocked:

```sh
log stream --device-name "iPad" --predicate 'subsystem == "com.nordup.MathTutor"' --level info
```

After the fact instead of live:

```sh
log collect --device-name "iPad" --last 30m --output ipad.logarchive
log show ipad.logarchive --predicate 'subsystem == "com.nordup.MathTutor"' --info
```

Use the name `xcrun devicectl list devices` prints. In practice the server-side
account above is the faster one to reach for: a client that times out now shows
up as an errored turn with a large `max_silence_ms`, without touching the iPad
at all.

### "I couldn't load the selected board area"

This sentence comes from the server, not from the device. When `view_board`
gets no render within 20 s, the turn answers the model with `UNAVAILABLE_ACK`
([`app/tutor/loop.py`](app/tutor/loop.py)), and that ack instructs the model
to say it could not see the board and to ask the learner to try again.

The known cause is a dev-server reload during a live turn. `uvicorn --reload`
restarts the app on every file save. The graceful shutdown keeps the open SSE
stream alive, so the turn continues — but the dying process refuses new
connections, so the iPad cannot POST its render to `/v1/turn/{id}/board`. The
20 s rendezvous wait times out. The late POST then reaches the fresh process
and gets a 404, because the rendezvous futures live in-process — see
[`app/tutor/rendezvous.py`](app/tutor/rendezvous.py).

The signature in `logs/server.log`, observed on 2026-08-15, turn `98ec5c4f…`:

```
turn started | turn_id=98ec5c4f…
Shutting down                                    ← reload, 4 s into the turn
turn ok      | … max_silence_ms=21285            ← the 20 s view_board wait
Application startup complete.
"POST /v1/turn/98EC5C4F…/board HTTP/1.1" 404     ← 10 ms after startup
```

A `max_silence_ms` a little over 20 000, together with a restart inside the
turn window, is this failure — not a slow iPad and not a network drop. The
device's POST landed the instant a listener came back; before that it had
nowhere to connect.

**No restart in the window?** Then the device refused, and it says so in its
own line rather than leaving you to read timings:

```
board render refused by the device | turn_id=… call_id=… reason=…
view_board unanswered | call_id=… region=… waited=20.0s
```

The first line is the device answering `/v1/turn/{id}/board` with `error`
instead of an image — instant, so the turn loses no time. The second is the
20 s wait expiring with no answer of either kind, which now means the device
never received the request or never ran: the renderer itself always answers.
Before 2026-08-16 the device sent nothing at all when it could not draw, and
both cases looked identical from here — the only record was
`tool_calls.result` in the database:

```sql
select tc.arguments, tc.result from tool_calls tc
  join turns t on t.id = tc.turn_id
 where t.session_id = :session and tc.name = 'view_board';
```

The rule: do not save server files while a learner turn streams, or point
development work at a second server instance. The tutor's reply is the
designed fallback — it says it cannot see rather than describe a board it
never received. The learner only has to send the turn again.

### Keeping the stream alive

**`status` is not edge-triggered, and a client must not treat a repeat as a
transition.** The translator re-sends the current phase whenever nothing else
has reached the device for `HEARTBEAT_SECONDS`, so a long turn produces the
same `status` many times over. Assigning the phase on each one is the whole of
the correct handling.

This exists because of a failure that cost real turns. A `update_board` call's
arguments — a diagram's SVG — stream as provider events this service does not
forward, so the connection went completely silent for as long as the model took
to write the picture. `URLSession` abandons a request that receives nothing for
60 seconds, which meant a diagram that took longer than a minute ended the turn
*after* the model had generated it and the account had been billed for it, and
the learner saw only "I couldn't reach the tutor service just now."

Hanging the check on incoming provider events needs no timer and no second
task: argument deltas arrive continuously, and the one genuinely eventless wait
in a turn — the device rendering a board region — is already bounded by
`rendezvous.RENDER_TIMEOUT_SECONDS`. That the heartbeat also names *which* tool
is mid-flight is what gives the iPad something to say while it waits.

### The workspace replaces the old nullable envelope

The client-side prototype's planning response used two independently
nullable JSON fields (`plan`, `exercise`) that were supposed to be "both set
or both null" by convention, enforced nowhere. This service replaces that
with a `set_workspace` function tool
([`app/tutor/tools.py`](app/tutor/tools.py)) whose JSON Schema makes both
halves `required` inside a `strict: True` tool call — the model cannot call
it with only one half set, because there is no way to construct an argument
object that has one without the other. When the model calls it, the
translator turns the tool call into a single `workspace` event carrying both
the plan and the exercise. No caller anywhere has to remember to check that
they arrived together, because the schema doesn't allow them not to.

**A turn that calls it is two requests, not one.** A function call *ends* a
Responses API response — the model stops there, having written no prose — so
[`app/tutor/loop.py`](app/tutor/loop.py) hands the tool result back and asks
it to continue, up to `MAX_TOOL_ROUNDS`. Both legs stream into the same
client turn and are recorded as one `Turn`, with usage summed across them. A
single-request implementation looks like it works right up until the model
sets the workspace: the board changes and the thread stays empty.

### The tutor's semantic board scene

Learner handwriting remains PencilKit ink on the iPad and is never touched by
the server. What the tutor draws is a separate structured scene exposed through
the strict `update_board` function tool in
[`app/tutor/tools.py`](app/tutor/tools.py). The tool takes a discriminated
union of primitives — `text`, `line`, `arrow`, `rectangle`, `ellipse`,
`circle`, `polygon`, `polyline`, `freehand`, `arc`, `angle_marker`, `path`,
`math_text`, `ink_text`, `image`, and a raw
`svg` element — each with a stable id, exact board coordinates, and shared
style fields (role, stroke/fill colors, width, opacity, dash, rotation where
meaningful).

`ink_text` is the tutor's own handwriting: the model sends a string of prose and
a cap height, and the device draws it character by character as ink-look
strokes. It is a tutor object with an id like every other one — nothing it
writes enters the learner's `PKDrawing` — so a hint can sit in the margin in
ink without ever touching their drawing or their undo history. That makes the
scene the only thing on the board that says whose hand wrote what, which is why
the scene context names the tutor's ids as its own.

A call is parsed and validated in
[`app/tutor/board_scene.py`](app/tutor/board_scene.py): coordinates, element
counts, point counts, text length, font sizes, stroke widths, and opacity are
all clamped server-side for ordinary primitives, malformed JSON is dropped,
and the translator emits a typed `board_update` event carrying only the
validated payload. The `svg` element is deliberately opaque transport: the
server checks only that the complete raw SVG document is non-empty, at most
40,000 characters, and anchored at a clamped board point. The figure normally
carries no frame at all: `width` and `height` of 0 mean the document's own
`viewBox` is drawn one user unit to one board point with its top-left corner
at `(x, y)`, so a figure is sized once; a positive frame is the legacy path,
and scales the whole document into that box. It never parses,
whitelists, rewrites, or sanitizes the exact string; all interpretation happens
locally on the iPad. The tool loop answers `update_board` with its own
`applied` ack (or `rejected` for malformed arguments), never with the
`set_workspace` ack, and the model continues to prose on the same turn.
`replace_all` clears the scene before applying the batch; upsert mode is
idempotent by id.

The device also sends the current scene back on every turn in the
`board_scene` request field, and the context assembler
([`app/tutor/context.py`](app/tutor/context.py)) includes that exact string in
the prompt, labelled as quoted data, so the model can see and revise its own
previous output. The prompt tells the model when to draw, to write its own words
in `ink_text` and keep every piece of notation in `math_text`, to place
corrections beside learner ink without covering it, and to avoid gratuitous
drawing. The scene context also
contains the current viewport and the logical bounds represented by the board
overview; because `view_board` regions are percentages of that same overview,
the model can convert what it inspected back into exact coordinates for a
nearby label or correction. For a fresh standalone exercise, it additionally
supplies `recommended_tutor_rect`, an inset upper placement budget, and
`reserved_learner_work_rect`, a lower band the tutor must leave clear. Both use
logical `[left, top, right, bottom]` coordinates and are derived from the live
viewport, so a compact diagram and immediately usable scratch space stay on
screen together across iPad sizes and zoom levels.

## Read-back endpoints

This service is built to record everything about a session — that's the
whole point of the recorder. These routes are how any of it actually
gets read back out. **The four `GET`s are for the project owner and for agents
debugging a bad tutoring turn, not for the iPad app** — the app never calls
any of them; it only ever calls `POST /v1/turn`, `POST /v1/dictation`, and
`POST /v1/sessions/{id}/close`. The one `POST` in the table is the exception
and is meant for the device.
Like every other route in this service, they sit behind the same bearer
token (`Authorization: Bearer <DEVICE_TOKEN>`) — there's no separate,
unauthenticated path to a student's handwriting or voice. Defined in
[`app/api/sessions.py`](app/api/sessions.py).

| Route | Returns |
| --- | --- |
| `POST /v1/sessions/{id}/close` | `204`, immediately, reporting nothing about the work. The device saying it has left this session for good; it starts the memory pipeline for that session and then drains whatever else is waiting. **Call it on a session switch and on an explicit end, never on backgrounding** — a close freezes the transcript into the one `Episode` that session will ever get, so a close sent while the learner is coming back drops every turn after it, permanently. Safe to send twice. `404` for an unknown id, so a device with the wrong one finds out. See [Memory and the learner model](#memory-and-the-learner-model). |
| `GET /v1/sessions` | `{"sessions": [...]}` — session summaries (id, model, reasoning effort, current plan/exercise, timestamps), newest-started first. Paginated with `limit` (default 50, max 200) and `offset`. |
| `GET /v1/sessions/{id}` | One session's summary plus its full `messages` (ordered by `seq`) and `turns` (ordered by start time, summarised — status, timing, token counts, error if any). `404` if the id is unknown. |
| `GET /v1/turns/{id}` | The full trace of one turn: its summary plus `llm_calls` (each with the *exact* request and response JSON sent to and received from OpenAI, the raw-event blob key, and usage), `tool_calls`, and `attachments` (kind, blob key, sha256, size). This is what makes a bad turn diagnosable after the fact — everything the model was told and everything it did, not a summary of it. `404` if the id is unknown. |
| `GET /v1/blobs/{key}` | Streams the raw bytes back for a blob key referenced by an attachment or an `llm_call`'s `raw_events_blob` (board PNGs, ink, dictation audio, raw provider event logs) — `Content-Type` recovered from the matching attachment where one exists, `application/octet-stream` otherwise. `404` if the key is unknown. |

## Health

`GET /health` is the one route that takes no bearer token, and it answers two
questions rather than one:

```json
{"status": "ok",
 "memory": {"unextracted_episodes": 0, "oldest_unextracted_age_seconds": null}}
```

`status` is liveness. The `memory` block is the extraction backlog, and it is
here because a stalled backlog has no other symptom: nothing errors, no request
fails, and the tutor simply stops learning anything new. `run_extraction_backlog`
halts on the first failure rather than stepping over it — an episode extracted
out of order can let a March fact close a June one — so a poison episode blocks
everything behind it, and these two numbers are what make that visible before
someone notices the tutor has gone vague. A rising `unextracted_episodes` with
an `oldest_unextracted_age_seconds` that keeps growing is a stuck drain;
restarting the service retries it.

Both values are `null` when the count could not be read. `backlog_status` never
raises, deliberately: health is asked whether the process is alive, and
answering "no" because a memory counter was unavailable would turn a memory
problem into a failed liveness probe.

## Retention

Everything written to Postgres and the blob store is kept indefinitely. There
is no retention policy, no deletion job, and no time-based cleanup.

Every model call sets `store=True`, so OpenAI keeps the response for thirty
days. That is deliberate: it is what `previous_response_id` chains against in
`app/tutor/loop.py`, and the provider's dashboard is the only view of a turn
that does not come out of this service's own recorder. OpenAI does not train
on API content.

## Memory and the learner model

The service remembers across sessions. Both seams this README used to describe
as future work — everything the model is told, and the tools it is offered —
are now what memory is built through, so they are described here as they are
rather than as extension points.

**The offline pipeline.** A closed session becomes an `Episode` (the frozen
transcript), and the episode becomes a digest, a set of atoms, and a rebuilt
portrait. Five provider round trips, which is why none of it happens on the
request path. [`app/memory/jobs.py`](app/memory/jobs.py) owns the ordering, and
the recovery story is one nullable column: the episode is committed *before*
any model is called, with `extracted_at` NULL, so a provider error or a process
that goes away leaves a row saying "this happened and has not been read yet".

Four things start that pipeline, and only the first involves the device:

- `POST /v1/sessions/{id}/close`, on a session switch or an explicit end.
- `sweep_abandoned_sessions`, which records an episode for any session whose
  last message is older than `STALE_AFTER` (one hour). This is what covers the
  sessions nobody ever leaves on purpose — an app killed from the switcher, a
  crash, an iPad put down.
- **The periodic sweep.** `run_periodic_sweep` runs that same sweep and the
  backlog drain every `SWEEP_INTERVAL` (5 minutes), detached so boot never
  waits on a provider. This is the reliable no-restart answer: a session that
  crosses the one-hour threshold is recorded within five minutes of doing so,
  with no device close and no service restart.
- **Startup.** The lifespan also runs the sweep and drain once, detached, so a
  service that was down catches up immediately instead of waiting for the
  first tick. Startup and the periodic sweep are also what retry a failed
  extraction: the drain halts rather than stepping over a failure, and the
  next pass is the recovery step.

**What a fact is.** `memory_atoms` is bi-temporal and append-only. Six
categories (`preference`, `goal`, `context`, `skill_state`, `misconception`,
`episode_ref`), a `stated` flag recording whether the learner said it
themselves, and a validity interval. A fact that stops being true is
*superseded*, never rewritten: the old row keeps its text and gains a
`superseded_by` pointer, which is what makes "was stuck on negative exponents
in March, fluent by June" a trajectory a later pass can read.
[`app/memory/consolidate.py`](app/memory/consolidate.py) is where a model — not
a cosine threshold — decides ADD / SUPERSEDE / NOOP, because a sentence and its
negation are near-identical to every embedding model and a threshold over that
number merges a fact with its own opposite.

**`app/tutor/context.py`** — still the one module where everything the model is
told is assembled, and memory arrived through it exactly as predicted. It is
two functions rather than one now, because the prompt is append-only: the
learner portrait, saved notes, recent session digests and learner model go into
the frozen head `open_session_preamble` renders once, when the session opens,
and `assemble_session_context` serves that head byte for byte on every later
turn in front of the growing session log. Every recalled block is *fenced* —
each body line prefixed with `> ` — rather than merely labelled, because the
profile body is unbounded model prose and a body containing a blank line plus a
forged heading would otherwise render an attacker-controlled section of the
prompt.

**`app/tutor/tools.py`, `TOOL_DEFINITIONS`** — now `set_workspace`,
`view_board`, `update_board`, and four memory tools: `search_memory`,
`recent_sessions`, `remember`, and `record_evidence`. They are dispatched by
[`app/memory/dispatch.py`](app/memory/dispatch.py) through the
`handle_memory` handler `run_turn` is given, which opens its own database
session per call rather than pinning a pooled connection for a multi-minute
turn. Each call is bounded by `MEMORY_TIMEOUT_SECONDS`, and the whole turn by
`MEMORY_BUDGET_SECONDS` — a per-call bound alone does not stop one response
issuing seven memory calls and blowing past the client's 120s stream timeout
inside a single round.

**Three more things the tutor can do, and none of them are hypothetical.**
They sit in the same `TOOL_DEFINITIONS` list, on every request, whether or not
a given turn can serve them — the tool set never varies per request, because
tool definitions sit at the top of the provider's cache-invalidation hierarchy
and a set that changes re-bills the whole prompt prefix. `loop._answer` is
where a tool this turn cannot serve is turned down.

- **`fetch_image`** — a function tool, ours, and the only thing in this
  service that opens a socket to a host the *model* named.
  [`app/tutor/fetch_image.py`](app/tutor/fetch_image.py) is written as a
  server-side request forgery surface first and a downloader second: `https`
  only, every resolved address must be public, no redirects, a content-type
  allowlist checked against the header and again against the bytes, a 10 MB
  cap enforced while reading, a pixel cap, and one total 10s deadline over
  DNS, connect, TLS, headers and body. What survives is written to the blob
  store, and the model is handed the blob id plus the picture itself — labelled
  as third-party data, because a caption rendered into an image is an
  instruction nobody sanitised. The blob id is what an `image` board element
  places.
- **`web_search`** — hosted. A type and nothing else of ours: the provider owns
  the name, the schema and the execution, so no call of it ever reaches
  `loop._answer`. It reports itself through `response.web_search_call.*`, which
  [`app/tutor/events.py`](app/tutor/events.py) already reads as the `searching`
  phase, so the learner sees it happening.
- **The code interpreter** — hosted, with `{"type": "auto"}` for its container,
  which asks the provider for a fresh sandbox per response. A named container
  id would pin every learner in the deployment to one machine and one
  filesystem, and let one turn's scratch files be read by the next learner's
  script. It differs from every other tool in what it leaves behind: a script
  that draws a chart writes a *file*, and that file dies with the container.
  `providers.openai._container_citations` finds those files on the message
  annotations, `loop.FileRelay` copies the bytes into this service's blob
  store, and the round that hands the model their blob ids is its only chance
  to put the chart on the learner's board.

Both downloaders spend one budget, per turn rather than per round:
`TURN_DOWNLOAD_LIMIT` (8 downloads) and `TURN_DOWNLOAD_BYTE_LIMIT` (40 MB),
counted across `fetch_image` calls and container-file relays together, because
the cost is the same wherever the bytes came from. Each is bounded in time as
well — `IMAGE_FETCH_TIMEOUT_SECONDS` and `FILE_RELAY_TIMEOUT_SECONDS`, both
15s — for the reason the memory tools are: no provider event passes through a
download, so nothing puts a byte on the wire while one runs.

**The learner model** is separate from memory and coarser.
[`app/learner/`](app/learner) holds the Common Core concept graph (see
[Setup](#setup) for the seed), an Elo-style ability estimate per concept, and
the write path the `record_evidence` tool feeds it through — each observation
weighted by how reliable the channel that produced it is, from a verified
answer down to a glance at a diagram. Reliability scales the *step* and not
the target, so an unreliable channel moves the estimate less rather than
dragging it toward chance — an LLM grader reading a child's maths is right
about 86% of the time when the student is correct and 69% when they are wrong,
and taking that at face value drifts the estimate confidently upward.

**Still seams.** `TOOL_DEFINITIONS` remains the whole of what it takes to add
a tool, and web search is the proof rather than the example: adding it was
`{"type": "web_search"}` appended to that list, and it has been in the list
since. File search would be `{"type": "file_search", "vector_store_ids": [...]}`
in the same place, and a domain-specific function is a new definition in the
same shape. The event
translator ([`app/tutor/events.py`](app/tutor/events.py)) already correlates a
tool call's name with its arguments through
`response.output_item.added` / `response.function_call_arguments.done`, so a
new tool either reuses that path (if the client needs to see the result as an
event) or is handled purely server-side.

## Known limitations

**The daily spend cap covers turns and voice, not everything.** Every turn
is priced when it finishes or fails — `turns.cost_usd`, computed from the
recorded token counts and the per-model price table in
[`app/config.py`](app/config.py) (`MODEL_PRICES_PER_1M`), so a price change
is a one-line edit there. The realtime voice path bills through the same
cap: the device reports each voice response's token counts to
`POST /v1/realtime/usage` (the call runs WebRTC device↔OpenAI, so the
device is the only party that sees the usage events), the row is priced
from `REALTIME_PRICES_PER_1M`, and `Recorder.spend_today()` sums both
tables. What the sum still misses: server-side memory jobs (extraction,
embedding, summarization) create no turn and are not priced; a voice
response whose report never leaves the device (app killed mid-call) is not
counted; and the `402` refusal itself applies to `POST /v1/turn` only — an
over-cap day does not refuse new *voice calls*, it refuses the turns around
them.

**The model allowlist is still the other half of the ceiling.**
`MODEL_ALLOWLIST` in [`app/config.py`](app/config.py) rejects any
`model` outside `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` with a `422`
before any provider call. It bounds *which* models can be called; the spend
cap bounds *how much* a day of them may cost. Config refuses to boot if an
allowlisted model has no price row, so the two lists cannot drift apart
silently.

**Database tests can now run concurrently.** Each test *run* (one `pytest`
process) creates its own Postgres schema (`test_<uuid>`) on
`TEST_DATABASE_URL`, via `schema_translate_map`, and drops only that schema
at session teardown — see `server/tests/conftest.py`. Two runs against the
same Neon branch at the same time no longer share tables to drop out from
under each other. Individual tests within one run still get a clean slate
via `TRUNCATE` rather than `DROP`/`CREATE`, which was also the leading
suspect for a prepared-statement-cache/PgBouncer interaction that produced
one spurious 404 in an earlier run.

**Semantic board objects are structured, not OCR.** The server stores and
streams the tutor's scene as structured geometry and text, plus opaque raw SVG
documents that the iPad interprets locally; the learner's handwriting remains
a raster understood by the model through images. There is no OCR claim
anywhere in the pipeline.

## Testing

```sh
cd server
uv run pytest -v
```

Tests that need a real database are decorated to skip automatically when
`TEST_DATABASE_URL` is unset. **A green run with `TEST_DATABASE_URL` unset
is not the same thing as a green run that exercised the database tests** —
it's a green run that quietly skipped all of them. Check the test output
for `SKIPPED` lines, or set `TEST_DATABASE_URL` (per the warning above), if
you need to know the database-backed paths actually ran.

### Live smoke test

`server/tests/test_live_smoke.py` makes one real call to the OpenAI API
through this service and asserts a real `text_delta` event comes back. It's
opt-in and skipped by default:

```sh
# Skipped, fast, calls nothing:
uv run pytest tests/test_live_smoke.py -v

# Actually calls OpenAI, costs real money, needs a real DEVICE_TOKEN and
# OPENAI_API_KEY in the environment:
MATHTUTOR_LIVE_TESTS=1 uv run pytest tests/test_live_smoke.py -v
```

It is excluded from the default `uv run pytest -v` run's meaningful work
(it collects but skips) precisely so that CI, or anyone running the suite
day to day, never accidentally spends money or depends on network access.

### Memory probes

`server/tests/eval/run_probes.py` is the end-to-end check on whether the tutor
actually remembers. It is a plain script and not a test module, so `pytest`
cannot collect it — `testpaths = ["tests"]` only picks up `test_*.py`.

```sh
cd server
uv run python tests/eval/run_probes.py            # ~$0.035, ~6 minutes
uv run python tests/eval/run_probes.py --list     # names only, spends nothing
uv run python tests/eval/run_probes.py --only supersedes_stale_skill_state
uv run python tests/eval/run_probes.py --control  # ~$0.016
```

**It costs real money — about $0.035 a full run** (36 model calls), and the run
prints what it spent. It needs `TEST_DATABASE_URL` (it creates and drops a
throwaway schema on that branch) and `OPENAI_API_KEY`, both read from
`server/.env`.

Each probe starts from an empty schema, replays raw transcripts through the
real `app.memory.jobs.run_session_close` — digest, extract, consolidate,
rebuild the portrait — and then asks a live question through the real
`app.tutor.loop.run_turn`. Both halves are the point: "the fact is in the
store" and "the tutor uses it" are different failures, and only the second is
what a learner experiences. A miss is reported as extraction losing the fact,
synthesis dropping it, or the tutor ignoring it, rather than collapsed into one
red line.

**`--control` skips the transcripts and requires every probe to *fail* against
an empty store.** A probe that passes with nothing in memory is a free pass
sitting in a green suite, and this suite shipped one: a probe asking "am I
ready to move on from factoring" accepted "ready" in the reply, which "no, you
are not ready" also satisfies. Run it after changing a probe's wording.

This suite is not decoration — it found the bug that made supersession
impossible. `FLOOR` in `consolidate.py` had been calibrated for
`text-embedding-ada-002` and carried through a move to
`text-embedding-3-small`, where the same sentences score fifteen points lower;
the candidate query returned nothing, the adjudicator was never called, and
every reversal in a learner's state was written as a coexisting fact. Every
unit test passed throughout, because they build their vectors by construction.
