# LangSmith observability and probe evals: implemented; LangGraph migration: planned

Status: **Phases 0-2 implemented and verified locally and against LangSmith.** The
LangSmith bootstrap and trace contract (Phase 0), runtime instrumentation
(Phase 1), and deterministic dataset/evaluator/CI layer (Phase 2) are in the
shared worktree. LangGraph migration is still a plan: nothing in the tutor loop
has moved onto a LangGraph graph yet, and the current request path still runs
the custom provider seam, open-ended round loop, translator and recorder
described below.

This document is the engineering companion to that decision: what was adopted
and why, the current pipeline step by step, the implemented trace
hierarchy/metadata, the dataset/evaluator/CI contracts and their acceptance
tests, the later LangGraph mapping and compatibility points, and official
references. Current-state claims below describe the implementation as it is
now; anything that is still a proposal is labelled as such.

## What exists today

### The wire contract

The iPad app talks only to the FastAPI service (`server/app/api/turn.py`). A
turn is `POST /v1/turn`, answered as Server-Sent Events in the service's own
vocabulary, defined as Pydantic models in `server/app/tutor/events.py`:

| Event | Meaning |
|---|---|
| `status` | Phase: `thinking`, `looking`, `searching`, `writing`, `drawing`, `computing`; repeats as heartbeat |
| `reasoning_delta` / `text_delta` | Incremental chunks of reasoning summary / reply |
| `workspace` | Full plan + exercise replacement |
| `board_update` | Validated batch of tutor-authored scene changes |
| `board_request` | Downstream ask to the iPad: render `x/y/width/height` percent region |
| `search_sources`, `step`, `done`, `error` | Evidence cards, activity rows, completion, failure |

`server/app/sse.py` formats one JSON object per `data:` line. The translator
(`EventTranslator` in `events.py`) turns provider events into these and emits a
heartbeat `status` whenever nothing has reached the device for
`HEARTBEAT_SECONDS`.

### The turn loop

`run_turn` (`server/app/tutor/loop.py`) is a hand-rolled **open-ended round
loop**, not a fixed pipeline:

1. `assemble_session_context` builds a three-message prompt: frozen system
   prompt, append-only context (frozen session preamble + growing transcript
   ledger), and the live turn message with board overview, uploads and scene.
2. `provider.build_round` builds the first-round payload; later rounds send the
   provider-specific continuation id (`previous_response_id` for OpenAI or
   `previous_interaction_id` for Gemini) plus tool outputs.
3. Round streams; `provider.normalise` maps raw SDK events to neutral
   `ProviderEvent`s; `EventTranslator.translate` emits client events.
4. On `Completed`: merge usage, record tool calls; if terminal error status,
   end failed.
5. If calls or kept container files exist, answer every call (`_answer`),
   await board render / memory `/` fetch `/` search as needed, append outputs +
   attachments to the outbox, and loop back. Otherwise end cleanly. Relevant
   waits and gate decisions carry LangSmith tool/gate spans, and the round span
   is closed once the provider stream exhausts (see Phase 1).

Pertinent limbs: only the first round sends the prompt; tool call ends a
response and buys extra rounds; usage is merged across rounds (`_merge_usage`);
`TurnResult` accumulates raw events, text, workspace, response ids and tool
calls so failure and success share one recording path.

### Provider seam

`Provider` (`server/app/tutor/providers/__init__.py`) is a runtime-checkable
Protocol with: `build_round`, `open_round`, `normalise`, `tool_output`,
`image_item`, `rendered_items`, `relay_item`, `classify`, `open_failure`.
`OpenAIProvider` (Responses API) and `GeminiProvider` (Interactions API)
implement it; `app/api/turn.py:_provider` picks by `PROVIDER_FOR_MODEL`.
The seam carries model family knowledge (payloads, raw event names, input item
shapes, retry classification) out of `loop.run_turn`, which stays family
neutral. `run_turn` also accepts injected handlers: `fetch_board`,
`fetch_image`, `relay_file`, `handle_memory`, `handle_web_search`.

### The board

The iPad holds the `PKDrawing`; the server never receives full-resolution ink.
`view_board` (`server/app/tutor/tools.py`) asks the device for a percentage
region via `BoardRequestEvent`; `server/app/tutor/rendezvous.py` parks an
`asyncio.Future` keyed by `(turn_id, call_id)` and in-process dict; the
device POSTs the PNG to `/v1/turn/{turn_id}/board`; `deliver` resolves it;
`await_render` waits 20 s then raises `BoardUnavailable`. Constraints: the
future lives in the process serving the SSE stream, so multi-worker deploys
need sticky routing or a shared broker; dev reload mid-turn loses the future.

`_BoardGate` (`loop.py`) enforces three causal rules on `update_board` /
`draw_board_svg`:

1. Never two draws on one look: a mutation requires a fresh delivered render;
   landing consumes it.
2. Never stack material: new framed blocks are refused
   (`must_reposition`) if they overlap existing tutor objects or learner ink
   past `OVERLAP_THRESHOLD` (annotation kinds, same-id edits and `replace_all`
   are exempt).
3. Draw then review: a landed mutation arms `pending_review`; the next round
   is forced to `view_board` exactly (`_post_review_tool_choice`) and a
   delivered full-board render clears it. Prose may not close a turn while a
   review is pending.

Board geometry helpers live in `server/app/tutor/board_geometry.py`; scene
validation/clamps in `server/app/tutor/board_scene.py`.

### Ordered tools

`TOOL_DEFINITIONS` (`server/app/tutor/tools.py`) is a single fixed list on
every request, because tool definitions sit at the top of prompt-cache
invalidation and a varying set re-bills the prompt prefix:

`set_workspace`, `view_board`, `draw_board_svg`, `update_board`,
`fetch_image`, `remember`, `forget`, `search_memory`, `search_sessions`,
`search_history`, `get_session`, `list_sessions`, `record_evidence`,
`web_search`, and hosted `{"type": "code_interpreter",
"container": {"type": "auto"}}`.

All schemas are strict; `set_workspace` structurally requires both `plan` and
`exercise`. `loop._answer` decides per call: ack for `set_workspace`; parse and
validate board mutations; `view_board` becomes a rendezvous; memory tools run
through `handle_memory` with per-call and per-turn budgets; `fetch_image` and
`web_search` go through injected handlers with shared download budgets.

### Recorder

`Recorder` (`server/app/store/recorder.py`) writes: `turns` (status, usage,
cost, timing, error JSONB), `messages`, `llm_calls` (exact request envelope,
response id/text, raw provider event blob in application/jsonl, usage),
`tool_calls` (name, arguments, result), `attachments` (blob key, sha256,
bytes), background memory rows, and realtime voice usage. `finish_turn` and
`fail_turn` share `_build_llm_call`; failures record partial output and token
usage plus diagnostics (`max_silence_ms` etc.), and write a `REPLY_LOST_TEXT`
placeholder.

Read-back endpoints: `GET /v1/turns/{id}` (full trace), `GET /v1/sessions`,
`GET /v1/sessions/{id}`, `GET /v1/blobs/{key}`.

### Test and eval assets

- Unit/integration tests live in `server/tests/` (`test_loop.py`,
  `test_turn_endpoint.py`, `test_events.py`, `test_tools.py`, `test_recorder.py`,
  `test_providers.py`, `test_board*.py`, `test_langsmith_observability.py`,
  `test_langsmith_evals.py`, etc.).
- Database-backed tests skip unless `TEST_DATABASE_URL` is set; conftest
  creates a throwaway schema per run.
- `server/tests/eval/probes.yaml` + `run_probes.py` are the end-to-end memory
  eval: rebuild memory from transcripts on an empty schema, then ask a live
  question through real `run_turn`; `--control` requires probes to fail with
  nothing stored.
- `server/tests/test_live_smoke.py` is an opt-in real API smoke test
  (`MATHTUTOR_LIVE_TESTS=1`).

## Verdict: LangSmith first, then LangGraph — yes, net positive

The strongest, lowest-risk immediate win is observability and test-backed
iteration, which is exactly LangSmith's product. The current system records
into its own Postgres and blobs for forensics, but has no structured way to:

- see every LLM call of a turn with prompt/response/usage in one timeline (it
  currently reconstructs a similar view via `GET /v1/turns/{id}`, but without
  per-call latency, token-cost aggregation, or comparison across sessions);
- replay recorded turns against dataset evaluators and catch regressions when
  prompts, tools, or the gate change;
- reason about the *agent behavior* (which tool followed which event, which
  gate decision happened when) without hand-written grep pipelines;
- compare candidate changes (prompt edits, gate thresholds, model/effort)
  against a fixed corpus.

LangSmith is observability-first and can wrap the existing code almost without
behavior change. LangGraph, by contrast, would be replacing the *control flow*,
which is riskier and benefits exactly from the evidence LangSmith provides.
The sequencing conclusion was: instrument with LangSmith while the custom
round loop still runs the show, build deterministic datasets from the checked-in
probe suite, add evaluators and CI gates, and only then migrate the loop to a
StateGraph behind the same provider seam and SSE contract.

### How customizable is LangGraph compared with the current solution?

LangGraph's StateGraph gives: explicit nodes and edges, conditional branching,
shared typed state, checkpointing (durable state snapshots per
thread/checkpoint), streaming (values/updates/messages/custom events), and
interrupts/time-travel. The current loop is fully custom so it can express
anything, but it does so as one big imperative generator; each new limb
(post-review forcing, budgets, gate) becomes another branch in one function.

The natural mapping keeps the hard parts local:

| Current custom piece | LangGraph counterpart |
|---|---|
| first round vs continuation rounds | same node type (a "model round" node), state keeps `previous_id`, `outbox` |
| `_BoardGate` decisions | gate logic stays as-is, either inside a `board_action` node or a conditional edge choosing `view_board` / `update_board` / `prose` |
| `EventTranslator` + heartbeat | a `translate` node remains responsible for emitting client events; `stream_mode="custom"` can emit internal updates |
| board rendezvous | keep the existing future outside the graph first; a later `interrupt` requires a checkpoint/resume adapter and duplicate-event safeguards |
| provider seam | reused unchanged: LangGraph nodes call `Provider`, or `langchain-openai` / Gemini integrations wrapped by the same seam |
| `Recorder` | dedicated terminal persistence nodes plus an outer cancellation fallback preserve the same rows and exactly-once rules |
| memory budgets, download budgets | graph state fields decremented by the same helper |

The genuinely hard compatibility points are listed later. LangGraph is highly
customizable, but the customization is structural (you decide nodes, edge
conditions, state, checkpointing, streaming), which is different from the
current "write arbitrary Python in a generator". It should become easier to
reason about after state is explicit and parity is proven, but the dual-engine
migration period will temporarily be less manageable because both control
paths must exist and agree. No current functionality needs to be dropped if
the first graph keeps the live board rendezvous outside persistence; replacing
that rendezvous with durable interrupts is a later protocol/runtime project,
not a mechanical refactor.

## Phase 0: LangSmith bootstrap (implemented)

### 0.1 Environment, project name, and pinned dependency

`server/pyproject.toml` pins `langsmith==0.11.2` (also locked in
`server/uv.lock`). Settings in `server/app/config.py` default to:

- `LANGSMITH_TRACING=false` (tracing off by default);
- `LANGSMITH_API_KEY` empty (tracing also stays inactive when the key is empty);
- `LANGSMITH_PROJECT=math-tutor` (project receiving runtime turn traces, not
  `math-tutor-prototype`);
- `LANGSMITH_ENDPOINT=https://api.smith.langchain.com`;
- `LANGSMITH_WORKSPACE_ID` optional workspace selector.

These are documented in `server/.env.example` and the server README. The
existing Postgres recorder remains the durable application record; LangSmith
adds a searchable execution timeline and experiment comparison.

### 0.2 Implemented trace hierarchy and metadata

`server/app/observability/__init__.py` owns the narrow, fail-open tracer:
stable span-name constants, a `ClientHandle`/`Span` surface, `TraceConfig`
read from settings, lazy SDK import, bounded outputs, and a NullSpan no-op
path. The Python package is `app.observability` (imported as
`app.observability`), not `app.observability.langsmith`. Exact implemented
span names (tests pin these, so rename with intent):

```
tutor.turn                      root, one per streamed turn (chain)
  ├─ tutor.context              context assembly (chain)
  ├─ llm.round                  one per provider round (llm)
  ├─ tutor.board_gate           per valid board mutation decision (chain)
  ├─ tool.fetch_image           per executed image-fetch wait (tool)
  ├─ tool.web_search            per executed web-search wait (tool)
  ├─ tool.memory                per executed memory-tool wait (tool)
  ├─ tool.view_board            per board render wait (tool)
  ├─ tool.file_relay            per executed container-file relay (tool)
  └─ tutor.persist_finish / tutor.persist_failure
                                 recorder write, depending on outcome (chain)
```

There is no separate "stream events" or "tool answers" child under `llm.round`:
the round span covers the whole provider request (payload summary, streaming,
usage, response id, tool names), and the tool spans are siblings under the
root because they run after the round stream ends. Parenting is explicit (each
child names its parent's run), so concurrent turns cannot cross-wire.

Root inputs (`app/api/turn.py`) are `turn_id`, `session_id`, `model`,
`provider`, `reasoning_effort`, `has_image`, `has_board`, `has_board_scene`,
`upload_count`, `history_count`, `prologue_ms`, `orchestration_version`, and
`trace_schema_version`. Root metadata repeats the correlation ids and provider
and adds the project; tracing-context metadata carries the same operational
correlation fields. Round inputs include a bounded `_payload_summary`: prompt
preview and tail, message boundaries, input kinds, binary part sizes, tool
count/names, continuation state, and tool choice. Round outputs include status,
usage, response id, tool names, and bounded text/reasoning previews and tails.
Root outputs on every finish path include `outcome`, `elapsed_s`, `ttft_ms`,
`events_sent`, `max_silence_ms`, `provider_events`, and `retryable`; once a
result exists they also include `token_usage`, `response_id`, `tool_names`,
`tool_count`, `text_chars`, and a bounded answer/tail. LangSmith also receives
its conventional span `status`. Payloads never embed raw images or blobs:
media appears only as sizes/counts, and strings/collections are bounded.

### 0.3 Phase 0 acceptance (implemented and locally verified)

- `tests/test_langsmith_observability.py` covers the fail-open contract:
  disabled config is a true no-op, span enter/exit/end are idempotent, failed
  parent enter cannot create an orphan root, tracing-context exits once,
  concurrent parents stay isolated, flush/close fail open, and root metadata
  carries session correlation.

## Phase 1: Runtime instrumentation (implemented)

### 1.1 Where the hooks live

- `server/app/main.py` lifespan builds the client from `TraceConfig` and
  stores it on `app.state.observability`; shutdown is a bounded best-effort
  flush then `close(timeout=0)`.
- `server/app/api/turn.py` enters a per-task tracing context, opens the
  `tutor.turn` root inside the stream task, opens `tutor.context` around
  context assembly, and opens `tutor.persist_finish` / calls
  `tutor.persist_failure` around recorder writes. `end_root` closes the root
  from every exit path, including the shielded `finally`, and exits the
  tracing context in the same task that entered it.
- `server/app/tutor/loop.py` accepts `observability`/`root_span` and opens
  `llm.round` (wrapped by `_RoundSpannedStream` so it closes exactly once on
  exhaustion, exception, or cancellation), `tutor.board_gate` for recorded
  mutation decisions, `tool.fetch_image`, `tool.web_search`, `tool.memory`,
  `tool.view_board`, and `tool.file_relay`. Tool spans are parented to the
  root, not to the closed round span.

### 1.2 Streaming compatibility rules (implemented)

- The SSE path never awaits LangSmith: span setup/teardown is synchronous
  SDK context handling and posting happens on the SDK's background batcher;
  the shutdown flush runs in a worker thread, time-boxed, fail-open. The
  heartbeat and client timeout behavior are unchanged, and the disabled path
  performs no LangSmith SDK work.
- Blob-heavy payloads are never duplicated: only bounded summaries and sizes
  go to LangSmith (`bounded_outputs`, `_payload_summary`).
- Span names are stable constants pinned by tests; renames are treated as
  breaking changes.

### 1.3 Phase 1 acceptance (implemented and locally verified)

- `tests/test_turn_endpoint.py` injects a fake handle through `app.state` and
  verifies: tracing leaves the SSE event vocabulary, ordering, and usage
  behavior unchanged; a happy text turn records `tutor.turn`, `tutor.context`,
  and one `llm.round`; an in-stream failure marks root failed and records
  `tutor.persist_failure`; cancellation closes the root exactly once in the
  shielded finally; and a tool-call turn produces two `llm.round` children
  with distinct round indexes.
- `tests/test_loop.py` pins round-span failure/terminal handling, the
  `_payload_summary` shapes for OpenAI and Gemini payloads, and that a raised
  tool handler closes both the tool span and round span failed. It also covers
  round-open cancellation, incomplete streams, and stream-context entry
  failure without leaking or double-ending the round span.

## Phase 2: Deterministic dataset, evaluators, CI (implemented)

### 2.1 Dataset: the checked-in probes.yaml manifest

`server/tests/eval/langsmith_eval.py` (package path
`tests.eval.langsmith_eval`, run as
`python -m tests.eval.langsmith_eval ...`) owns the dataset. The canonical
dataset is the **same checked-in `server/tests/eval/probes.yaml`** that
`run_probes.py` validates and replays; nothing here re-implements the probe
rules. There is no separate "export from Postgres turns" script or board-gate
dataset: the Phase 2 dataset is `langsmith-memory-probes` with six examples,
one per probe:

`recalls_a_stated_preference`, `recalls_a_goal_with_a_deadline`,
`supersedes_stale_skill_state`, `does_not_invent_memories`,
`recalls_what_we_did_last_time`, `recalls_an_older_fact_after_a_later_session`.

Dataset contract (LangSmith 0.11.2):

- `inputs`: `{"name", "sessions", "question"}`; raw probe specs are stored
  with placeholders unresolved so the manifest is clock-independent.
- `outputs`: only the expectation keys present on the probe
  (`answer_any`, `answer_none`, `prompt_any`, `expect_supersession`); absent
  expectations are omitted and evaluated as neutral/passing.
- `id`: stable UUID5 over `(dataset namespace, probe name)`; reordering
  probes never changes identity or aggregate fingerprint.
- `metadata`: `example_id` (probe name), `schema_version` (currently `"1"`),
  and a stable sha256 `content_fingerprint` over the probe content.

### 2.2 Idempotent sync and explicit `--prune`

`sync` is idempotent by explicit stable ids: it reads the remote ids, creates
missing examples with `create_examples`, and updates matches with
`update_examples`, so repeated syncs update the same six examples without a
duplicate-id conflict.
Remote deletion only happens with the explicit `--prune` flag
(`sync --prune` deletes examples no longer present in `probes.yaml`);
`sync` alone keeps stale remote examples untouched. Dry-run is deterministic
and requires no key, network, database, or provider call; it prints the
fingerprint manifest and evaluator payloads. Dataset schema bumps require an
explicit re-sync with `--prune` so stale examples stop being evaluated.

### 2.3 Four deterministic evaluators

Four local, deterministic evaluators are registered (no hosted LLM judges):

| Evaluator key | Pass condition |
|---|---|
| `answer_any` | the answer contains at least one required term |
| `answer_none` | the answer contains none of the forbidden terms |
| `prompt_any` | at least one expected term reached the actual prompt |
| `expect_supersession` | the probe expected supersession and at least one atom closed |

They mirror `run_probes.py` matching (typographic-folded, word-boundary-aware)
and score the compact probe result (answer, actual prompt shown, superseded
count), not the store snapshot. The experiment registers all four evaluators
regardless of probe; absent reference expectations score neutral/passing.

### 2.4 Sequential experiment

The dataset experiment is deliberately sequential: `MAX_CONCURRENCY = 1`
(pinned by a test). Each example opens its own throwaway schema and replays
transcripts through the real `run_probe`/`run_turn` pipeline, so concurrent
examples would clobber one shared store. `run_experiment` calls LangSmith
`client.aevaluate` with the deterministic evaluators,
`experiment_prefix="math-tutor-memory-probes"`, `blocking=True`, and
`max_concurrency=1`. Date placeholders are resolved at experiment run time
against the experiment clock, and the evaluator references are resolved with
the same clock so they match the target.

### 2.5 CI: normal vs manual

`.github/workflows/langsmith-evals.yml`:

- `validate-and-test` runs on every push to `main` and on pull requests:
  `uv sync --frozen`, `python -m tests.eval.langsmith_eval dry-run`, and the
  deterministic eval, observability, and loop regression suites. No provider
  key, LangSmith key, network trace, or database is involved.
- `live-sync-and-evaluate` runs only on `workflow_dispatch` with the
  `run_live` input enabled: it syncs the deterministic dataset, then runs the
  sequential live experiment (`python -m tests.eval.langsmith_eval evaluate`)
  with `LANGSMITH_*`, `TEST_DATABASE_URL`, and `OPENAI_API_KEY` from the
  `langsmith-evals` environment, and finally asserts dry-run still passes in
  the live job. Normal CI never initiates a paid provider run.

### 2.6 Phase 2 acceptance (implemented and locally verified)

- `tests/test_langsmith_evals.py` covers manifest stability, order
  independence, UUID5 identity, content fingerprints, clock independence,
  example contract, upsert payload, idempotent sync, stale-example
  preservation without `--prune`, explicit prune, evaluator scoring, dry-run with no keys,
  sequential concurrency, environment loading, upfront command requirements,
  and experiment pass/fail accounting.
- The dry-run command exits 0 without keys and prints the six-probe manifest
  with stable aggregate fingerprint
  `1c4d939dcb5d4822d673efaed49e3512398cd8bdebffc81dbad13a28530f2e93`.
- The live experiment is not part of normal CI. It was run manually against
  the configured `math-tutor` project: all six examples uploaded and completed,
  and all evaluator results were recorded. One existing tutor-quality
  expectation failed (`recalls_a_stated_preference` omitted the expected
  visual/diagram language); the experiment infrastructure itself completed
  successfully.

### 2.7 Validation record

- `uv run pytest tests/test_langsmith_evals.py
  tests/test_langsmith_observability.py tests/test_loop.py -q`: **187 passed**.
- `uv run pytest tests/test_turn_endpoint.py -k langsmith -q`: **5 passed**.
- `uv run pytest -q`: **1,198 passed, 1 opt-in test skipped**. The first full
  run exposed an unrelated fixed-date test; its handler clock is now pinned to
  the fixture date, and the complete current-tree rerun is green.
- The installed `langsmith==0.11.2` test exercises the real `trace` and
  `tracing_context` implementations with a network-free client double and
  verifies root/child trace ids and exactly two create/update calls.
- A live iPad turn produced a successful `tutor.turn` root with successful
  `tutor.context`, `llm.round`, and `tutor.persist_finish` children in the
  `math-tutor` project. The six-example dataset synced repeatedly without
  duplicate ids after splitting missing examples into `create_examples` and
  existing examples into `update_examples`.
- `uv sync --frozen`, `uv lock --check`, Python compilation, workflow parsing,
  `git diff --check`, and deterministic dry-runs in both the normal and
  stripped environments pass. Both dry-runs produce six examples and aggregate
  fingerprint
  `1c4d939dcb5d4822d673efaed49e3512398cd8bdebffc81dbad13a28530f2e93`.

## LangGraph migration (later phases)

### 3.1 Target graph

For the first parity phase, compile without a checkpointer and keep the graph
inside one request task. Before enabling persistence, split durable state from
live dependencies. A durable shape should contain only stable, serializable
values and blob/reference ids:

```python
class TutorState(TypedDict):
    model: str
    effort: str
    request_body_ref: str | None
    prompt_state: dict  # ordered text plus blob/reference ids
    board_gate_state: dict
    previous_id: str | None
    outbox: list[dict]
    calls: list[dict]
    attachment_refs: list[dict]
    file_refs: list[dict]
    result: dict
    memory_budget: float
    downloads: int
    downloaded_bytes: int
    relayed_ids: list[list[str]]
    fetched_urls: list[str]

@dataclass
class TutorRuntime:
    provider: Provider
    translator: EventTranslator
    observability: ClientHandle
    root_span: Span | NullSpan
    fetch_board: BoardFetcher | None
    fetch_image: ImageFetcher | None
    relay_file: FileRelay | None
    handle_memory: MemoryHandler | None
    handle_web_search: WebSearchHandler | None
```

`TutorRuntime` belongs in LangGraph runtime context, not checkpointed state.
For a cross-process resume, a live LangSmith `RunTree`/span cannot be restored;
open a new trace linked by `turn_id`, graph `thread_id`, and checkpoint id. The
stateful parts of `_BoardGate` must be represented in `board_gate_state`; a
node can rehydrate a short-lived helper, apply a decision, and write the new
gate state back rather than treating the Python object itself as durable state.

Nodes:

```
start -> route_round
route_round: if board_gate.pending_review -> force_review_round
             else -> build_round
build_round -> stream_round -> translate_events -> decide_round
decide_round: terminal error/failure -> end_failed
              calls or files -> answer_tools -> relay_files -> route_round
              else -> end_success
answer_tools: per call, branch to board_rendezvous / memory_tool / fetch_image /
              web_search / ack_only, then back to answer_tools until done
end_success/end_failed -> recorder_write -> stop
```

The graph is layered inside the existing `run_turn` generator first: keep
`run_turn`'s signature, run the graph with `astream` or `astream_events`, and
yield `ClientEvent`s out of a final node / custom events. The endpoint already
passes `observability` and `root_span` into `run_turn`, so the graph nodes
receive the same LangSmith handle and parent and continue the implemented span
names above. The SSE endpoint must remain wire-compatible: the same event
vocabulary, payload shapes, ordering, heartbeat behavior, and terminal rules.

### 3.2 Hard compatibility points

1. **Causal gate timing.** `_BoardGate` decisions must be made exactly when a
   mutation event would be born, because the device applies `board_update`
   from the stream before the ack round returns. If the graph delays gate
   decisions until after event emission, the device can receive a mutation that
   should have been refused. In practice, the translator should keep
   consulting the gate during `translate_events`; the graph only orchestrates.
2. **Rendezvous identity across graph steps.** `(turn_id, call_id)` futures
   live in-process. The parity migration should keep that wait outside graph
   persistence. A later LangGraph `interrupt()` stops the graph and requires a
   resume invocation; resumption reruns its node from the beginning. The device
   flow therefore needs an adapter from the board POST to graph resume, stable
   interrupt ordering, and an idempotency guard so `board_request`, recorder
   writes, and tool outputs are not emitted twice. Timeouts must still map to
   `BoardUnavailable` and record the unanswered region in `turns.error`.
3. **Streaming/heartbeat.** No graph checkpointing may pause the SSE generator
   such that `max_silence_ms` exceeds client tolerance. Custom stream events can
   carry the existing client vocabulary, but checkpoint only completed rounds,
   not individual deltas inside a model node. A failed/resumed streaming node
   otherwise reruns from its beginning and can duplicate provider cost and
   already-emitted deltas.
4. **Message/round chaining.** The provider-specific continuation id
   (`previous_response_id` or `previous_interaction_id`) must reflect the last
   *completed* round, and the first-round payload must still be recorded
   verbatim into `request_body` for the recorder. LangGraph state must not
   re-serialize or reorder outbox items.
5. **Failure vs success recording.** `recorder.finish_turn` / `fail_turn`
   invariants (partial raw events, tool calls with answers, placeholder
   message, usage-on-failure) must be identical; a graph node or
   `astream_events` hook must call the recorder exactly once.
6. **Budgets.** Memory budget, download count/bytes, relayed ids, fetched URL
   dedupe all need to be state fields with identical arithmetic, including
   timeout charges and "refused without waiting" paths.
7. **Post-review forcing.** `_post_review_tool_choice` must be applied only to
   the *next* round and cleared once a full-board render is delivered; graph
   state must encode `pending_review` explicitly.
8. **Provider family differences.** Gemini's `requires_action` completion and
   in-stream failures must map to the same `TERMINAL_ERROR_STATUSES` logic in
   the graph's `decide_round` node.
9. **Serializable state vs runtime dependencies.** Provider clients,
   translators, handlers, database/session objects, and live trace spans do not
   belong in durable state. Pass them through runtime context; checkpoint only
   stable state. Rebuild helpers from that state on resume and start a linked
   trace when the original request task no longer exists.
10. **Sequential tool semantics.** Multiple normal outgoing edges can execute
    in parallel, but the current loop answers tool calls in provider order and
    mutates shared time/download budgets between them. Keep one sequential
    `answer_tools` path until a parity test proves a particular tool set can run
    concurrently without changing output order or budget decisions.
11. **Open-ended loop ceiling.** The current Python loop has no round-count
    limit. LangGraph enforces a recursion/super-step limit, so configure and
    monitor it deliberately and translate exhaustion through the existing
    failure recorder instead of exposing a new unhandled graph error.

### 3.3 Future phases

- Phase 3: bootstrapped parity harness. Run old `run_turn` against a new
  `run_turn_graph` on the same captured inputs; assert identical event
  sequences/decisions for a fixture corpus (board gate scenarios, memory
  probes, fetch/relay cases). The parity harness should reuse the existing
  fake per-step observability spans and the deterministic probe dataset.
- Phase 4: cut over the request path to the graph behind a flag
  (`TUTOR_ENGINE=graph`), LangSmith traces then include node names and
  custom events; the existing `llm.round`/`tool.*`/`tutor.persist_*` span
  names should remain unchanged so dashboards and evaluators keep working.
- Phase 5: split serializable state from runtime context, then adopt a
  persistent checkpointer for resumability/time-travel if needed. Replace the
  in-process board rendezvous only after a device-to-graph resume adapter and
  idempotency tests prove that interrupt replay cannot duplicate stream events
  or recorder side effects.
- Phase 6: ratchet datasets/evaluators to lock in prompt and gate behavior;
  gate LangGraph migrations on dataset pass thresholds; extend the
  `langsmith-memory-probes` dataset with board-gate and tool-loop examples
  only after the parity harness shows identical behavior.

## What the migration gains

- Implemented now: per-step `tutor.*` / `llm.round` / `tool.*` visibility,
  replay, and experiment comparison in LangSmith, with the four deterministic
  probe evaluators as the first regression gate.
- Later, from LangGraph: a cleaner structural home for the open-ended round
  loop, with rounds, budgets, and gates explicit in state instead of threads
  through one growing generator.
- Optional future capabilities: checkpointing, time-travel, durable
  multi-worker rendezvous, and a graph you can inspect/step in LangSmith.

## Landmarks and file references

- Pipeline: `server/app/api/turn.py` (`stream`, `_provider`, error ladder);
  `server/app/tutor/loop.py` (`run_turn`, `_BoardGate`, `_answer`); `server/app/tutor/events.py`
  (`EventTranslator`, SSE vocabulary); `server/app/tutor/context.py`;
  `server/app/tutor/tools.py` (`TOOL_DEFINITIONS`).
- Instrumentation: `server/app/observability/__init__.py` (span-name
  constants, `TraceConfig`, `ClientHandle`, `Span`, fail-open NullSpan);
  `server/app/main.py` (startup build + bounded shutdown flush);
  `server/app/api/turn.py` (root/context/persist spans);
  `server/app/tutor/loop.py` (round/tool spans).
- Providers: `server/app/tutor/providers/__init__.py` (Protocol + events);
  `server/app/tutor/providers/openai.py`; `server/app/tutor/providers/gemini.py`;
  `server/app/tutor/providers/gemini_schema.py`.
- Board: `server/app/tutor/rendezvous.py`; `server/app/tutor/board_scene.py`;
  `server/app/tutor/board_geometry.py`; `server/app/tutor/board.py`.
- Recorder: `server/app/store/recorder.py`; `server/app/store/models.py`.
- Tests/eval: `server/tests/`; `server/tests/eval/probes.yaml`;
  `server/tests/eval/langsmith_eval.py`; `server/tests/eval/run_probes.py`;
  `server/tests/test_langsmith_observability.py`;
  `server/tests/test_langsmith_evals.py`; `server/tests/test_live_smoke.py`.
- CI: `.github/workflows/langsmith-evals.yml`.
- Config: `server/app/config.py`; `server/.env.example`;
  `server/pyproject.toml`; `server/uv.lock`.

Official references (LangChain docs, Python).

- LangSmith Observability (tracing):
  https://docs.langchain.com/langsmith/observability
- LangSmith Datasets:
  https://docs.langchain.com/langsmith/manage-datasets-programmatically
- LangSmith Evaluation (evaluators and experiments):
  https://docs.langchain.com/langsmith/evaluation
- LangGraph overview: https://docs.langchain.com/oss/python/langgraph/overview
- LangGraph Graph API: https://docs.langchain.com/oss/python/langgraph/graph-api
- LangGraph persistence/checkpointers:
  https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph event streaming:
  https://docs.langchain.com/oss/python/langgraph/streaming
- LangGraph interrupts:
  https://docs.langchain.com/oss/python/langgraph/interrupts

Package versions: `langsmith==0.11.2` is implemented and locked. LangGraph
was not added as a dependency and is not installed; no LangGraph version is
referenced in code.
