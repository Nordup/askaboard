# Backend Service — Design

**Date:** 2026-08-07
**Status:** Approved, ready for implementation planning

## Problem

The app talks to OpenAI directly. `TutorServiceRouter` reads a key from the
Keychain and hands it to `OpenAITutorService`, which posts to `/v1/responses`;
`OpenAIDictationService` posts to `/v1/audio/transcriptions` with the same key.
Session state is a single local file — `SessionPersistence` writes
`session.json` into Application Support and reads it back on launch.

The README already calls this prototype-only, and for the right reason: a
client-side key is extractable from the IPA, it is *your* key against *your*
billing, and there is no place to put a rate limit or a spend cap. But the
key is only the visible half of the problem. The prompt (`TutorPromptPolicy`),
the model choice, and the strict response schema all live in the app binary,
so every prompt correction is an App Store release. And the three capabilities
this app is heading toward — memory across sessions, retrieval over a
curriculum, web search — are server-side concepts with nowhere to live.

There is also no record. When a tutoring turn goes wrong, the only evidence is
whatever is still on screen. There is no way to ask what exactly was sent, what
the model actually emitted, what the board looked like at that moment, or how
the behaviour changed over a month.

## Approach

A thin FastAPI service that holds the one OpenAI key, sits in the request path
for every tutor turn and every dictation, streams results back over SSE, and
records everything that passes through it into Postgres and a blob store.

**Provisioning means the server provisions a credential to the device, not a
key to the user.** The alternative reading — minting per-user ephemeral OpenAI
keys — was rejected: that mechanism exists only for the Realtime API's client
secrets, it does not apply to the Responses API, and it would hand the client
back the ability to burn the quota, which is the thing being fixed.

**The proxy is the recorder.** Because every turn already passes through the
service by definition, the full record — messages, images, request envelopes,
raw model events, timings, token counts, cost — accumulates for free. No sync
protocol is needed to get session data onto the server.

That resolves the client/server state question along the line the industry
already draws. ChatGPT is server-authoritative for conversations: history lives
on the account and opening an old chat fetches from source, which works because
the conversation is server-generated content with nothing to lose offline.
Drawing apps are local-first: Notes, Freeform and GoodNotes keep ink on device
and sync it, and `PKDrawing` is `Codable` precisely so it can be persisted
locally. This app is both products at once, so each half keeps its own
convention — **conversation, turns and traces are server-authoritative; ink
stays local-first**, with the board snapshot the tutor looks at uploaded per
turn as evidence.

The rejected alternative was making the app a thin client over server state.
It is the right long-term answer for multi-device, but it means building sync,
conflict resolution and an offline story for a child's Apple Pencil ink in
exchange for capability nobody has asked for yet. One user, one device.

## Design

### 1. Shape

A Python service in `server/` in this repo, run locally for now. Python
because the retrieval and evaluation tooling this is heading toward lives
there; same repo because the client and its backend change together, and an
agent debugging a session should be able to read both.

```
server/app/
  main.py              FastAPI app, lifespan, SSE plumbing
  config.py            settings from env
  auth.py              bearer token check
  api/turn.py          POST /v1/turn         SSE
  api/dictation.py     POST /v1/dictation    SSE
  api/sessions.py      GET  /v1/sessions…    read-back
  tutor/context.py     SEAM 1 — assemble_context()
  tutor/tools.py       SEAM 2 — tool registry
  tutor/loop.py        model ⇄ tools, until final
  tutor/events.py      OpenAI events → our event vocabulary
  tutor/prompt.py      TutorPromptPolicy, ported from Swift
  store/db.py          engine and session management
  store/models.py      tables
  store/recorder.py    write-behind persistence
  store/blobs.py       BlobStore protocol + LocalBlobStore
server/migrations/
server/tests/
```

`context.py` and `tools.py` are the seams that make the later work additive.
Today `assemble_context()` returns the tutor policy, the message history and
the current workspace; memory and retrieval are additional returns from that
one function. Today the registry holds a single tool; web search, file search
and domain functions are additional entries. Neither changes the request path.

### 2. Storage split

| Data | Where | Why |
|---|---|---|
| Sessions, messages, turns, tool calls, usage, cost | Neon Postgres | Relational and queryable; this is what Postgres is for |
| Exact request/response envelopes | Neon, `JSONB` | A bad turn has to replay verbatim, and still be queryable |
| Board PNG, ink, dictation audio, raw event logs | Blob store, key in Postgres | Blobs in Postgres wreck backups, bloat rows and cost more |
| Memory facts and retrieval embeddings (later) | Neon, `pgvector` | Same database, one connection string |

The consensus for a project this size is unambiguous: start on pgvector and
move to a dedicated vector database only when a specific bottleneck forces it,
which is somewhere past tens of millions of vectors. Neon was the right call
before and remains it. The mistake to avoid is not choosing Postgres, it is
putting the media in Postgres too.

`BlobStore` is a protocol with a `LocalBlobStore` implementation writing under
a configured directory. S3/R2 is a config swap, not a rewrite. **Named
tradeoff:** with the service on a laptop, blobs sit on local disk while the
database is remote, so losing the machine keeps the text and loses the images.
Accepted for now.

### 3. Data model

| Table | Columns of note |
|---|---|
| `sessions` | `model`, `reasoning_effort`, `plan` jsonb, `exercise` jsonb, timestamps |
| `messages` | `session_id`, `seq`, `role`, `text`, `signal`, `created_at` |
| `turns` | `status`, `ttft_ms`, `latency_ms`, input/output/reasoning tokens, `cost_usd`, `error` jsonb |
| `llm_calls` | `turn_id`, `seq`, `model`, `request` jsonb, `response` jsonb, `raw_events_blob`, `usage` jsonb |
| `tool_calls` | `turn_id`, `llm_call_id`, `name`, `arguments` jsonb, `result` jsonb, timing, `error` |
| `attachments` | `turn_id`, `kind`, `blob_key`, `sha256`, `bytes`, `width`, `height`, `content_type` |

A turn maps to several `llm_calls` once tools loop, which is why the two are
separate tables rather than one.

`llm_calls.request` stores the real body with base64 image data replaced by
`{"blob": "sha256:…"}`, so rows stay small and a board snapshot that did not
change between turns is stored once. Deduplication happens server-side on
write; the client always sends. Conditional upload — client offers a hash,
server says whether it needs the bytes — is a later optimisation that trades a
round trip for bandwidth and is not worth it over a LAN.

The raw SSE event log is written as a `.jsonl` blob per call. That is what lets
an agent reconstruct exactly what the model emitted — reasoning summaries,
partial tool arguments, ordering — rather than only the final text.

Retention is indefinite for everything, including board snapshots and dictation
audio.

**Storing dictation audio directly contradicts a shipped privacy
declaration.** `NSMicrophoneUsageDescription` in `project.yml` ends with the
sentence *"Math Tutor keeps no copy of the recording."* README line 54 makes
the same promise in prose: *"Nothing logs or persists the audio or the
transcript."* That purpose string is the only explanation a parent ever gets
and it went through App Store review. Keeping audio indefinitely requires
rewriting it — and the README with it — in the same change, not afterwards.

If that rewrite is unwelcome, the cheaper resolution is to exclude dictation
audio alone from the keep-everything rule: persist the transcript, which is
what debugging a bad turn actually needs, and drop the waveform. That is a
decision for the client-migration plan, and it is called out there rather than
silently settled here.

The initial migration enables the `vector` extension — one line, and it proves
the extension is available on Neon before anything depends on it. It does not
create memory or chunk tables; those arrive with the feature that needs them.

### 4. Wire protocol

`POST /v1/turn`, bearer token, request carries a client-generated `turn_id`
(UUID) for idempotency, plus `session_id`, message text, optional signal,
optional board PNG and its region description, model and reasoning effort.
Response is `text/event-stream`.

The service emits its own event vocabulary rather than forwarding OpenAI's.
That indirection is the seam that allows adding tools, changing prompts or
swapping providers without the iPad app knowing.

| Event | Payload |
|---|---|
| `status` | `phase` ∈ {`thinking`, `looking`, `searching`, `writing`}, optional detail |
| `reasoning_delta` | text fragment for a collapsible thinking strip |
| `text_delta` | reply prose fragment |
| `workspace` | `{plan, exercise}` — fires only when the model calls `set_workspace` |
| `done` | `turn_id`, usage, finish reason |
| `error` | message, `retryable` flag |

These map from the Responses API's semantic events: `response.created`,
`response.reasoning_summary_text.delta`, the tool lifecycle events, and
`response.output_text.delta`, terminating at `response.completed`. Two
implementation notes. The published references disagree on the delimiter for
some event names (`response.output_item.added` versus
`response.output_item_added`), so exact names get pinned against the API
reference during implementation rather than trusted from prose. And reasoning
summaries require `reasoning: {effort, summary: "auto"}` and may not be
available on every model or account tier — when they are absent, `status`
degrades to deterministic phases the service knows on its own (an image was
attached, so `looking`; text has started, so `writing`), and
`reasoning_delta` simply never fires.

`POST /v1/dictation` proxies the transcription endpoint and preserves the
existing contract exactly: `gpt-transcribe` for its `keywords` support,
`transcript.text.delta` events appended and `transcript.text.done` treated as
authoritative, `<`/`>`/CR/LF sanitised out of keywords and prompt before the
body is built, two silent retries on 429 and 503 honouring `Retry-After`,
never on billing 429s, a stream that ends without `.done` treated as a failure
rather than a short transcript, and short boilerplate results treated as
silence. That logic is correct today and moves rather than gets rewritten.

`GET /v1/sessions`, `/v1/sessions/{id}`, `/v1/turns/{id}` are read-back for
you and for agents, not for the app.

### 5. Response schema change

Today `reply`, `plan` and `exercise` arrive as one strict JSON object, which is
why `TutorReply.coherentPair` exists — it defensively discards a plan that
arrives without its exercise.

Streaming makes that shape untenable: streamed strict JSON is partial JSON, and
rendering it means a tolerant incremental parser with ugly failure modes. So
the contract splits the way ChatGPT splits it — prose streams as prose, and
structured side-effects arrive as tool calls. `reply` becomes streamed text.
`plan` and `exercise` become a `set_workspace` function tool the model calls
only when it intends to replace the workspace.

This is a simplification, not a tax. The tool either fires with both halves or
does not fire. The both-or-neither invariant stops being a runtime check and
becomes structurally impossible to violate, and `coherentPair` is deleted.

### 6. A turn, end to end

Authenticate → reject a duplicate `turn_id` → write the board snapshot to the
blob store and its `attachments` row → `assemble_context()` → run the agent
loop against OpenAI with `stream=True`, `reasoning={effort, summary:"auto"}`
and the tool registry → translate events and push SSE → emit `done`.

**Persistence is write-behind.** Neon is a remote round trip and nothing
belongs on the token path but the token path. Events buffer in memory and flush
once after `response.completed`, or on error.

### 7. Reliability

- **Connect-time 429 and 5xx:** exponential backoff with jitter, honour
  `Retry-After`, at most two retries. Billing 429s
  (`credit_balance_exhausted`, spend-limit codes) are never retried.
  `OpenAITranscription.swift` already classifies these correctly; that logic is
  ported, not reinvented.
- **Mid-stream failure:** never a silent retry. The learner has already seen
  partial text, and a restart that duplicates half a sentence is worse than a
  visible, retryable error. The partial output and the failure are both
  persisted.
- **Client disconnect:** the model call runs to completion and persists anyway.
  It was paid for and it is evidence.
- **Spend cap:** a hard daily USD ceiling computed from `sum(turns.cost_usd)`,
  checked before the call. This is the control a client-side key structurally
  cannot have, and it is a large part of why the service exists.
- **Idempotency:** the client-generated `turn_id` is unique. A retry after a
  dropped connection cannot double-charge.

### 8. Auth and configuration

One user, one device: a single long-lived bearer token, generated once and
stored in the device Keychain in place of the OpenAI key. No accounts, no
OAuth.

The base URL is a setting. A local service is reachable from the Simulator at
`localhost`, but a physical iPad needs the LAN address plus an ATS exception,
or a tunnel. Making the URL configurable keeps that a setting rather than a
code change.

### 9. Client changes

`TutorService` becomes streaming — `AsyncThrowingStream<TutorEvent>` — which is
the one breaking protocol change. `BackendTutorService` implements it.
`OpenAITutorService`, `OpenAIDictationService` and `OpenAITranscription` are
deleted, because leaving them behind leaves the key in the binary and defeats
the exercise. `KeychainStore` holds the backend token. `TutorPromptPolicy`
moves to the server. `SessionPersistence` is untouched — ink stays local-first.

`DemoTutorService` and its tests survive, which is what makes the migration
safe: the deterministic path stays available throughout.

The Settings and README copy about the API key has to change with it. The
current text is carefully honest about the key leaving the device; the
replacement has to be equally honest that the student's work and voice now go
to your server and are kept there indefinitely.

## Testing

Fixture-driven and offline. Recorded OpenAI SSE streams are replayed through
the event translator, asserting both the emitted event sequence and the rows
written. Unit coverage on context assembly, tool argument validation, and the
retry classifier — particularly that a billing 429 is not retried. One live
smoke test, opt-in behind an environment variable. No network in CI.

## Out of scope

Memory extraction, retrieval, web search and any tool beyond `set_workspace`.
Multi-user, multi-device and sync. Deployment beyond running locally. These are
what the two seams exist for; none is built now.

## Decomposition

Two implementation plans from this one spec:

1. **The service.** Buildable and fully testable against fixtures with the iPad
   app untouched.
2. **The client migration.** The streaming protocol change, deletion of the
   direct OpenAI services, and the copy changes in Settings, README and the
   dictation contract.
