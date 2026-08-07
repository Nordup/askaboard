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
for the write path and [Retention](#retention) below for what that means in
practice.

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

### Environment variables

| Variable | What it's for |
| --- | --- |
| `OPENAI_API_KEY` | The one OpenAI key. Never sent to the device. |
| `DATABASE_URL` | The Postgres (Neon) connection string the app writes to. |
| `DEVICE_TOKEN` | The bearer token the iPad app presents. Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. |
| `BLOB_DIR` | *Optional*, defaults to `./blobs`. Local directory for the blob store (board PNGs, ink, dictation audio, raw event logs). |
| `DAILY_SPEND_CAP_USD` | *Optional*, defaults to `5.0`. Turns are refused with `402` once today's recorded spend reaches this. See [Known limitations](#known-limitations) — today this never trips. |
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
| `status` | A phase change: `thinking`, `looking` (an image is being uploaded), `searching` (a tool call is running), or `writing` (text has started). |
| `reasoning_delta` | An incremental chunk of the model's reasoning summary. |
| `text_delta` | An incremental chunk of the reply text. |
| `workspace` | A full replacement of the session's plan and exercise, arriving together — see below. |
| `done` | The turn finished; carries `turn_id` and token counts. |
| `error` | The turn failed; carries a message and whether the client should retry. |

These are defined once, as Pydantic models, in
[`app/tutor/events.py`](app/tutor/events.py).

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

## Read-back endpoints

This service is built to record everything about a session — that's the
whole point of the recorder. These four routes are how any of it actually
gets read back out. **They're for the project owner and for agents
debugging a bad tutoring turn, not for the iPad app** — the app never calls
any of them; it only ever calls `POST /v1/turn` and `POST /v1/dictation`.
Like every other route in this service, they sit behind the same bearer
token (`Authorization: Bearer <DEVICE_TOKEN>`) — there's no separate,
unauthenticated path to a student's handwriting or voice. Defined in
[`app/api/sessions.py`](app/api/sessions.py).

| Route | Returns |
| --- | --- |
| `GET /v1/sessions` | `{"sessions": [...]}` — session summaries (id, model, reasoning effort, current plan/exercise, timestamps), newest-started first. Paginated with `limit` (default 50, max 200) and `offset`. |
| `GET /v1/sessions/{id}` | One session's summary plus its full `messages` (ordered by `seq`) and `turns` (ordered by start time, summarised — status, timing, token counts, error if any). `404` if the id is unknown. |
| `GET /v1/turns/{id}` | The full trace of one turn: its summary plus `llm_calls` (each with the *exact* request and response JSON sent to and received from OpenAI, the raw-event blob key, and usage), `tool_calls`, and `attachments` (kind, blob key, sha256, size). This is what makes a bad turn diagnosable after the fact — everything the model was told and everything it did, not a summary of it. `404` if the id is unknown. |
| `GET /v1/blobs/{key}` | Streams the raw bytes back for a blob key referenced by an attachment or an `llm_call`'s `raw_events_blob` (board PNGs, ink, dictation audio, raw provider event logs) — `Content-Type` recovered from the matching attachment where one exists, `application/octet-stream` otherwise. `404` if the key is unknown. |

## Retention

**Everything is kept indefinitely. Nothing expires.** This includes board
snapshots of a student's handwriting and dictation audio recordings of a
child's voice, not just message text and metadata. There is no retention
policy, no deletion job, and no time-based cleanup anywhere in this service
— what's written to Postgres and the blob store stays there.

This is worth being direct about because it's easy to assume otherwise. The
iPad app's current microphone permission string
(`MathTutor/Info.plist`, `NSMicrophoneUsageDescription`) says *"Math Tutor
keeps no copy of the recording."* That was true of the prototype, which sent
audio straight to OpenAI and kept nothing itself. It stops being true the
moment the app is pointed at this service, since `PERSIST_DICTATION_AUDIO`
being on (the default) means a permanent copy is written here. **The
client-migration plan must correct that permission string before the app
talks to this service** — shipping the old string alongside this service's
actual behavior would be telling a parent something false about where their
child's voice goes.

## The two seams

Two places in this codebase are deliberately built as extension points
rather than as finished features, because the plan that produced this
service scoped memory/retrieval and additional tools out of this pass.

**`app/tutor/context.py`, `assemble_context`** — everything the model is
told, assembled in one function. Today it composes the system prompt, the
conversation history, and the optional board image. Adding memory or
retrieval means: look up whatever facts or prior-session summaries apply to
this student, format them as additional sections of the user prompt (or as
extra `input` entries), and append them here. No other file needs to
change — every caller already goes through this one function, so a caller
never has to be taught that memory exists.

**`app/tutor/tools.py`, `TOOL_DEFINITIONS`** — the list of tools offered to
the model on every turn. Today it holds exactly one, `SET_WORKSPACE_TOOL`.
Adding web search means appending `{"type": "web_search"}`; adding file
search means appending `{"type": "file_search", "vector_store_ids": [...]}`;
adding a domain-specific function (e.g. "grade this step") means writing a
new tool definition in the same function-call shape as `set_workspace` and
appending it. The event translator
([`app/tutor/events.py`](app/tutor/events.py)) already has a
`response.output_item.added` / `response.function_call_arguments.done`
path that correlates a tool call's name with its arguments; a new tool
either reuses that path (if the client needs to see the result as an event)
or is handled purely server-side, depending on what it's for.

## Known limitations

**The daily spend cap never trips.** `DAILY_SPEND_CAP_USD` is compared
against `Recorder.spend_today()`, which sums `turns.cost_usd` — but nothing
in this service ever writes a value into `turns.cost_usd`. It stays `NULL`
on every turn, `spend_today()` sums to `0.0`, and `0.0` never reaches any
cap. This is a real gap, not a subtle one: as shipped, the spend cap
provides no protection at all. Fixing it needs a per-model pricing table
(input/output/reasoning token cost by model) so a dollar figure can be
computed from `usage` and written when a turn finishes or fails.

**The daily spend cap's only real backstop is the model allowlist.**
`MODEL_ALLOWLIST` in [`app/config.py`](app/config.py) rejects any
`model` outside `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` with a `422`
before any provider call — that's a real ceiling today, independent of the
non-functional spend cap above. It bounds *which* models can be called, not
*how much* they cost to run, so it doesn't substitute for a real pricing
table; it just closes the "any model at any price" gap the missing spend
cap otherwise leaves wide open.

**Database tests can now run concurrently.** Each test *run* (one `pytest`
process) creates its own Postgres schema (`test_<uuid>`) on
`TEST_DATABASE_URL`, via `schema_translate_map`, and drops only that schema
at session teardown — see `server/tests/conftest.py`. Two runs against the
same Neon branch at the same time no longer share tables to drop out from
under each other. Individual tests within one run still get a clean slate
via `TRUNCATE` rather than `DROP`/`CREATE`, which was also the leading
suspect for a prepared-statement-cache/PgBouncer interaction that produced
one spurious 404 in an earlier run.

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
