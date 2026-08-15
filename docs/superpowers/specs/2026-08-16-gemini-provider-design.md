# Gemini as a second tutor provider — design

Date: 2026-08-16. Status: approved, ready for a plan.

## What this adds

Two new options in the settings window's **Tutor model** row: `gemini-3.7-flash`
and `gemini-3.5-flash-lite`, beside the three `gpt-5.6` routes. The learner picks
either family from the same menu, and the turn runs against whichever provider
that model belongs to.

It also makes the **Reasoning effort** row model-dependent, because the two
families do not offer the same levels.

No new settings row. No layout change. The picker rows already hold their options
behind a menu, so a menu that grows from three entries to five needs no board
edit. A new *row* would need one; more entries in an existing menu does not.

## Why

Two reasons, and only one of them is cost.

The first is that there is no way to compare providers on this workload today.
The tutor's hard part is not prose, it is calling `update_board` with a
twelve-arm union schema and getting the geometry right. No benchmark answers
whether another model family does that better. A picker answers it in one
session.

The second is cost, and it is narrower than it looks. Flash-Lite at $0.30/$2.50
is **more expensive than Luna** at $0.20/$1.20, which is the current default. So
neither new model saves anything on the tier that runs most turns.

The saving is against the expensive tiers. Flash at $0.75/$3.75 is about 3×
cheaper than Terra at $2.00/$12.00, and about 7× cheaper on input and 8× cheaper
on output than Sol at $5.00/$30.00. So the trade this picker offers is: when a
turn needs more than Luna, Flash is the cheaper way to get it. Gemini's 1M
context is the other reason to reach for it.

Anyone reading this later should not expect the bill to fall. Expect a second
opinion on board quality, and a cheaper deep-reasoning tier.

## Models and prices

| Model | Input | Output | Cached input | Cache storage |
|---|---|---|---|---|
| `gemini-3.7-flash` | $0.75 | $3.75 | $0.075 | $0.50 / 1M / hour |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 | $0.03 | $1.00 / 1M / hour |

Per 1M tokens. Read from `ai.google.dev/gemini-api/docs/pricing` on 2026-08-16,
and the price rows carry that date in a comment, matching how
`MODEL_PRICES_PER_1M` records its own verification.

**The Flash row has an expiry.** $0.75/$3.75 is an introductory rate that runs
through 2026-12-31. On 2027-01-01 it becomes $1.50/$7.50 — a doubling. The table
carries the introductory rate with the expiry date in the comment. Putting the
2027 price in early would quietly halve the effective daily cap on Gemini for
four months, which is a worse failure than a comment nobody reads: the cap
tripping early looks like a bug and gets raised.

Flash-Lite's price carries no expiry.

**Cache storage is not charged and not priced.** The storage fee applies to
explicit caching only. This design uses implicit caching, which has no storage
line. That is stated here so nobody adds explicit caching later without
revisiting the cap.

**Grounding with Google Search is not token-priced.** It bills 5,000 free search
requests per month, shared across all Gemini 3.x usage, then **$14 per 1,000
requests** — and one turn may run several search queries, each charged. At
$0.014 per search, one search costs about what 47,000 Flash-Lite input tokens
cost. A grounded turn priced on tokens alone would report a fraction of its real
cost, and `spend_today()` would leak straight under the daily cap. This is the
gap `MODEL_PRICES_PER_1M` exists to close, so the table grows a dimension for
it.

The free allowance is deliberately **not** modelled. Tracking it needs monthly
state the recorder does not have, and the allowance is shared with any other
Gemini 3.x usage on the same key, including usage outside this app. So the
recorded cost over-reports while inside the free tier. That errs toward the cap
tripping early, which is the safe direction for a spend guard.

## Architecture: the seam

A new package, `app/tutor/providers/`, with `openai.py` and `gemini.py` behind
one protocol. A provider does three things and nothing else:

1. **Open a round.** Build the request from neutral round state and return a
   stream.
2. **Classify one raw event** into a neutral event.
3. **Report usage** in the OpenAI-shaped dict the recorder already writes.

The split point is the important decision. Providers map **raw → neutral**. The
existing `EventTranslator` maps **neutral → ClientEvent**. So the phase latch,
the step labels, `TOOL_PHASES`, `TOOL_STEP_LABELS`, `parse_board_update` and
`lint_svg` stay single-copy and keep working for both families.

`EventTranslator.translate` therefore changes its input type: it takes a neutral
event instead of a raw provider dict. Its body loses the `kind == "response.…"`
string tests and keeps everything after them. The heartbeat keeps working
unchanged, because it fires on *any* incoming event and does not read the shape.

`loop.run_turn` keeps everything that is not provider-shaped: the round loop,
`MAX_TOOL_ROUNDS`, the memory per-call timeout and cumulative budget, the board
rendezvous, the download counter, and the usage merge. Every one of those
constants carries a comment naming a real failure it was tuned against. They
must not fork, which is the whole argument for this seam over a second
`run_turn`.

Payload building and event parsing move out of `loop.py`, so that file should
get shorter, not longer.

**The neutral event set** is what the loop already needs internally:

- `Created`
- `TextDelta(text)`
- `ThoughtDelta(text)`
- `ToolCallStarted(output_index, name, call_id)`
- `ToolArgsDelta(output_index)` — the existing step-label refinement needs to
  know a call is streaming, not what it is streaming
- `ToolArgsDone(output_index, arguments)` — `arguments` is a JSON **string** on
  both providers
- `HostedToolActivity(kind)` — `searching` or `computing`
- `Completed(usage, response_id, status)`

Two of those carry a decision worth stating.

`ToolArgsDone.arguments` is a string because both providers stream function
arguments as incremental JSON text — OpenAI as
`response.function_call_arguments.delta`, Gemini as an `arguments_delta` inside
`step.delta`. So `_workspace_from` and `_board_update_from`, which take a raw
string and parse it, work for Gemini without a change. Had Gemini delivered a
parsed object, the neutral event would have had to re-serialise it, and the board
parser's tolerance for malformed input would have been testing something
different from what production sends.

`Completed.status` exists because a Gemini tool round ends with status
`requires_action` rather than a plain completion. See Error handling.

**Model to provider** is an explicit table in `app.config`:

```python
PROVIDER_FOR_MODEL: dict[str, str]
```

Not a model-id prefix test. A prefix is a guess that breaks the first time a
model is named something unexpected, and this table gets the same boot guard the
price table has: an allowlisted model with no provider entry fails the boot.

Gemini calls go through `google-genai` (Python, v2.3.0 or newer) against the
Interactions API. Not the OpenAI compatibility layer: that serves
`/chat/completions` only, which has no `previous_interaction_id`, no
thought-summary stream in the shape `events.py` reads, and native tools only
through `extra_body`.

## Tool schema translation

`providers/gemini_schema.py` converts `TOOL_DEFINITIONS` once, at import.

Gemini function declarations accept exactly these schema keywords: `type`,
`nullable`, `required`, `format`, `description`, `properties`, `items`, `enum`,
`anyOf`, `$ref`, `$defs`. Everything else is dropped by the provider. So the
converter:

- **inlines every `$ref` and `$defs`.** They are documented as supported, and
  there are open reports of them being rejected in practice. `_board_element()`
  already builds the arms programmatically, so resolving the references at build
  time is mechanical. Inlining costs schema size and buys certainty.
- **drops `strict`, `additionalProperties`, `maxItems`, `maxLength`,
  `minItems`, `minimum`, `maximum`.**
- **rewrites `const: X` to `enum: [X]`**, which is what keeps each `anyOf` arm's
  `kind` discriminator intact. Losing the discriminator would make the union
  unparseable, so this one is load-bearing.
- **renames the hosted tools**: `{"type": "web_search"}` becomes
  `{"type": "google_search"}`, and
  `{"type": "code_interpreter", "container": {"type": "auto"}}` becomes
  `{"type": "code_execution"}`.
- **sets `generation_config.tool_choice = "validated"`**, which is Gemini's
  schema-adherence mode and the nearest equivalent of `strict`.

**Dropping the constraints is safe, and here is why.** `parse_board_update` and
`lint_svg` already re-validate every element after the call returns. The
constraints in the schema were telling the model what to produce; the parser is
what decides whether the board changes. So the check moves upstream to
downstream. It does not disappear.

**The guard is an invariant test, not a spot check.** Walk the entire produced
schema and assert that no unsupported keyword survives anywhere, that no `$ref`
survives anywhere, and that every arm of the `elements` union still carries its
`kind` as a single-value enum. A test that checks the top level only would pass
while a nested arm was malformed, and a malformed arm is a blank board band.

## Round chaining, parts, and the system prompt

| Responses API | Interactions API |
|---|---|
| `responses.create` | `interactions.create` |
| `previous_response_id` | `previous_interaction_id` |
| `store: True` | `store: True` |
| `reasoning: {effort, summary: "auto"}` | `generation_config: {thinking_level, thinking_summaries: "auto"}` |
| `{"role": "system"}` item in `input` | top-level `system_instruction` |
| `{"type": "input_text", "text"}` | `{"type": "text", "text"}` |
| `{"type": "input_image", "image_url": "data:…"}` | `{"type": "image", "mime_type", "data"}` |
| `{"type": "input_file"}` | `{"type": "document", "mime_type", "data"}` |
| `function_call_output` | `{"type": "function_result", "call_id", "name", "result", "is_error"}` |
| `response.created` | `interaction.created` |
| `response.output_text.delta` | `step.delta` carrying a TextDelta |
| `response.reasoning_summary_text.delta` | `step.delta` carrying a ThoughtSummaryDelta |
| `response.output_item.added` (function_call) | `step.start` on a `function_call` step |
| `response.function_call_arguments.delta` | `step.delta` carrying an `arguments_delta` |
| `response.function_call_arguments.done` | `step.stop` on a `function_call` step |
| `response.web_search_call.*` | `google_search_call` / `google_search_result` |
| `response.code_interpreter_call.*` | `code_execution_call` / `code_execution_result` |
| `response.completed` | `interaction.completed` |

The image part is the one that needs care: OpenAI takes one `data:` URL string,
Gemini takes the mime type and the raw base64 in separate fields.
`attachments/parts.py` already predicts this in its own docstring — *"A provider
that renames `input_file` touches only this"* — so the split belongs there and
in the Gemini adapter, not spread through the loop.

`previous_interaction_id` sits in exactly the position `previous_response_id`
sits in now, so the round loop's shape does not change: round one sends the
prompt, later rounds send the chaining id plus tool results only.

**Two comments need updating rather than copying.** The `store: True` comment
cites thirty-day provider retention as the point of storing. Gemini's paid
retention is 55 days. And Gemini has no `prompt_cache_key` equivalent — implicit
caching routes on the prefix by itself — so the cache-key branch is
OpenAI-only, and the comment should say so instead of reading as universal.

**Three parameters must not be sent.** Gemini 3.x rejects `temperature`,
`top_p` and `top_k`, and `thinking_level` replaces `thinking_budget`. The
adapter never sends any of them.

## The code-execution chart path gets simpler

OpenAI writes a chart into a container, and `loop` downloads it through
`client.containers.files.content` before writing it to the blob store. Gemini
returns the image inline, as base64, in the code-execution result. There is no
container and no download.

So `relay_file` gains an entry point that takes bytes rather than a container id
and a file id, and the Gemini adapter uses it. `FILE_RELAY_TIMEOUT_SECONDS` does
not apply to that path, because nothing goes on the wire.

The per-turn download counter still counts these. That bound is about how many
images one turn may produce, not about where the bytes came from, and a turn
that emits forty charts is the same problem whichever provider made them.

## Pricing and usage

`MODEL_PRICES_PER_1M` grows one optional key:

```python
"per_search": 0.014   # USD per grounding search request
```

`turn_cost_usd` adds `grounding_tool_count × per_search` to the token total.
OpenAI rows omit the key and read it as zero, so their arithmetic does not
change.

Usage maps to the shape the recorder already writes, so `recorder._apply_usage`
needs no change:

| Interactions usage | Recorder field |
|---|---|
| `total_input_tokens` | `input_tokens` |
| `total_output_tokens` | `output_tokens` |
| `total_cached_tokens` | `input_tokens_details.cached_tokens` |
| `total_thought_tokens` | `output_tokens_details.reasoning_tokens` |

`total_thought_tokens` is **not** priced separately. Gemini bills thinking inside
the output tokens, exactly as the existing table's comment says the OpenAI family
does, so a separate rate would double-charge.

`total_tool_use_tokens` is recorded and not priced, for the same reason: the
code-execution documentation describes those as intermediate tokens already
counted in input and output.

`cache_write_tokens` has no Interactions equivalent and stays NULL on Gemini
turns. A NULL is a visible gap someone can query for, which is the rule
`cache_tokens` already follows.

## Device

**`ModelChoice`** gains two cases beside the three that exist:

- `.flash = "gemini-3.7-flash"` — title "Flash", caption "Wide context"
- `.flashLite = "gemini-3.5-flash-lite"` — title "Flash-Lite", caption
  "Cheapest deep reasoning"

Captions state the honest trade rather than marketing, following
`VoiceModelChoice`'s "Cheaper, less reliable". Neither caption claims Gemini is
cheaper than Luna, because it is not.

**Effort options become model-dependent.** `ModelChoice.supportedEfforts:
[ReasoningEffort]` returns `low, medium, high, xhigh, max` for the `gpt-5.6`
cases and `low, medium, high` for the Gemini cases.
`SettingsOption.efforts(selected:)` becomes `efforts(for:selected:)`.

**`TutorStore.setModel` clamps.** Switching to a model that does not support the
session's stored effort moves the effort to the nearest supported level —
`xhigh` and `max` both become `high`. Without the clamp, a session sitting on
Max would send an effort the provider rejects, and the next turn would 422.

Gemini also offers a `minimal` thinking level. This increment does not wire it
up, because the client's nearest case is `.none`, and `.none` is the subject of a
separate open bug (see Coordination). Keeping them apart keeps each change
reviewable.

**No new row, so `SettingsWindowMetrics` is untouched.** The Tutor pane keeps
three rows at its current 760 × 560.

## Server

**`Settings.gemini_api_key: str | None = None`.** Optional, so the server still
boots with only an OpenAI key. A Gemini turn with no key configured fails loudly
at request time with a message naming the missing setting.

This deliberately does not follow the price table's fail-the-boot rule. That rule
exists because an unpriced model makes spend invisible, which is a money
problem. A missing key makes turns fail, which is a loud problem that fixes
itself when the key arrives.

**`EFFORTS_FOR_MODEL: dict[str, frozenset[str]]`** replaces the single
`REASONING_EFFORT_ALLOWLIST`, with the same boot guard: every allowlisted model
needs an effort set. `TurnRequest` validates the `(model, effort)` pair rather
than the effort alone.

The picker already prevents a bad pair, so this is defence in depth. It stays
because the existing comment gives the reason: effort multiplies reasoning
tokens, reasoning bills at the output rate, and a device free to name the effort
is a device free to choose the bill.

## Error handling

**`retry.classify` needs a per-provider classifier.** It reads OpenAI error
codes down to a list of terminal billing codes ported from
`OpenAITranscription.swift`. Gemini reports different codes —
`RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT`, and its own 429 and 503 shapes. Each
provider supplies a classifier; `_open_round`'s retry wrapper and
`RETRY_LIMIT` stay shared.

**`requires_action` is not an error.** It is how a normal tool round ends: the
model emits its `function_call` steps and the interaction completes with that
status, waiting for `function_result` blocks in the next `interactions.create`.
That is the round loop this service already runs. Treating it as a failure would
break every turn that calls a tool, which is most of them.

**The error states are `failed`, `cancelled`, `budget_exceeded` and
`incomplete`.** Each surfaces as an `ErrorEvent` on the stream.

None of those may end the turn quietly. A truncated answer that looks complete
is the same failure the board's blank-band bug produced: the learner gets
something that reads as finished and is not, and nothing in the record says so.

## Tests

Server:

- The schema converter's invariant test, per the Tool schema translation
  section: no unsupported keyword and no `$ref` anywhere in the output, and
  every union arm keeps its `kind` discriminator.
- A recorded Gemini stream fixture produces the **same `ClientEvent` sequence**
  as the OpenAI fixture for an equivalent turn — prose, one `update_board` call,
  a hosted search, and a completion. This is the test that makes "switch between
  them" mean something, and it is the one to write first.
- A Gemini round that ends with status `requires_action` runs another round
  rather than ending the turn, and a round that ends `budget_exceeded`,
  `incomplete`, `failed` or `cancelled` emits an `ErrorEvent`. The first half of
  that test is the one that would catch treating `requires_action` as a failure,
  which would silently break every turn that touches the board.
- `turn_cost_usd` prices a Gemini turn's tokens plus its
  `grounding_tool_count`, and an OpenAI row with no `per_search` key prices
  exactly as it does today.
- The usage mapping turns an Interactions usage object into the recorder's five
  numbers, with `cache_write_tokens` NULL.
- Every model in `MODEL_ALLOWLIST` has a provider entry, a price row, and an
  effort set. Three boot guards, one test.
- `TurnRequest` rejects `("gemini-3.7-flash", "max")` as a 422 and accepts
  `("gemini-3.7-flash", "high")`.
- A Gemini turn with no `gemini_api_key` configured fails with a message naming
  the setting, and records no cost row.

Device:

- `ModelChoice.supportedEfforts` covers all five cases, and
  `SettingsOption.efforts(for:selected:)` returns exactly that set with one
  marked.
- `TutorStore.setModel` clamps `xhigh` and `max` to `high` when switching to a
  Gemini model, and leaves a `medium` session alone.
- A `LearningSession` encoded and decoded keeps a Gemini model choice; a fixture
  naming an unknown model decodes to the default rather than failing.

Board fidelity:

- `tests/eval/run_probes.py` runs against both new models. This is the real gate
  on the twelve-arm schema, and it is a judgement call on the output, not an
  assertion.

Tests are written as part of the work and run by the repository owner.

## Risks

1. **Board schema fidelity is the top risk.** The `update_board` union loses
   `strict`, `additionalProperties`, and every numeric and length bound. The
   parser catches malformed output, but catching it means the board does not
   change, and a board that does not change is the failure the learner sees. The
   probes are the gate, and a bad result sends this design back rather than
   forward.
2. **`tool_choice: "validated"` is interaction-scoped, not per-tool.** It is the
   replacement for `strict`, and it applies to every tool in the request at
   once. Whether forcing adherence changes how readily the model reaches for
   `google_search` or `code_execution` is unknown. Measure it; do not assume it
   is free.
3. **Grounding cost.** One search costs what tens of thousands of Flash-Lite
   tokens cost. The per-search price row makes it visible. It does not make it
   small.
4. **The 2027-01-01 price cliff.** Flash doubles. The comment carries the date.
   Nothing enforces it, and this is the design's weakest point: a price table
   that is right today and silently wrong in four months.
5. **`google-genai` is a second provider SDK** with its own retry, timeout and
   streaming behaviour. The loop's four eventless-wait bounds were tuned against
   the OpenAI SDK's defaults. They need re-checking against this one rather than
   assuming they carry over.

## Coordination

A separate session is fixing a client/server mismatch on reasoning effort: the
settings pane offers a `None` effort that `REASONING_EFFORT_ALLOWLIST` rejects,
so selecting it 422s the turn.

That work touches `REASONING_EFFORT_ALLOWLIST` in `app/config.py`,
`ReasoningEffort` in `Domain/Models.swift`, and
`SettingsOptions.efforts(selected:)` — which is exactly what the Device and
Server sections above change.

Whichever lands first, the second one rebases onto it. If the effort fix lands
first, `EFFORTS_FOR_MODEL` must carry `none` forward for the `gpt-5.6` models
rather than dropping it. If this design lands first, the effort fix decides
`none` per model instead of globally, and Gemini's `minimal` becomes the obvious
home for it.

## Out of scope

- **Memory and embeddings stay on OpenAI.** `EXTRACTION_MODEL` keeps
  `gpt-5.6-luna` for extraction, profile synthesis and consolidation, and
  `EMBEDDING_MODEL` keeps `text-embedding-3-small` at 1024 dimensions. Moving
  the embedding model would need every stored atom re-embedded to stay
  comparable, which is not reversible by changing a picker.
- **Voice stays on OpenAI.** The realtime path, its allowlist and its price
  sheet are untouched. Gemini has live audio models; that is a separate design.
- **Dictation stays on OpenAI.**
- **Gemini's `minimal` thinking level**, per the Device section.
- **The `None` effort bug**, per Coordination.

## Design source

No board change. The Tutor pane keeps three rows at 760 × 560, and both changed
rows hold their options behind a menu, so more entries need no layout. A new row
or a changed row height would need Board 10 updated first, and this design needs
neither.
