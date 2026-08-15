# Gemini Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gemini-3.7-flash` and `gemini-3.5-flash-lite` to the Tutor model picker beside the three `gpt-5.6` routes, so one session can switch families and the turn runs against whichever provider the chosen model belongs to.

**Architecture:** A provider protocol in `server/app/tutor/providers/`. Each provider opens a round, classifies one raw stream event into a neutral event, and reports usage in the shape the recorder already writes. `loop.run_turn` keeps the round loop, the tool-round bound, the memory budget, the download budget and the board rendezvous, so those tuned constants stay single-copy. Task 1 is a pure refactor that must leave every existing test green; Gemini arrives only from Task 4.

**Tech Stack:** Python 3.12, FastAPI, `openai>=2.8`, new `google-genai>=2.3.0`, pytest with `asyncio_mode = "auto"`, `respx` for HTTP fakes. Swift 6 / SwiftUI on the client.

**Spec:** `docs/superpowers/specs/2026-08-16-gemini-provider-design.md`

## Global Constraints

- **Work in place on `main`.** Do not create a branch or a worktree. This overrides the worktree step in any skill invoked while executing this plan.
- **Never run the full test suite.** `xcodebuild test` and full `pytest` runs are the repository owner's job. Run only the specific test named in each step.
- **Do not `git checkout` any file.** The working tree carries the owner's concurrent edits and there are no snapshots. Undo your own temporary edits with an explicit edit.
- **Re-read a file immediately before editing it.** The owner edits and builds during the session.
- **Commit only the files each task names.** Never `git add -A`.
- **New Swift files require `xcodegen generate`** before they compile. No duplicate basenames in the target.
- **`google-genai>=2.3.0`** — the Interactions API needs this floor.
- **Never send `temperature`, `top_p` or `top_k` to Gemini 3.x.** They are rejected. `thinking_level` replaces `thinking_budget`.
- **Gemini thinking levels are `low`, `medium`, `high` in this work.** `minimal` is out of scope.
- **Prices are per 1M tokens, verified 2026-08-16.** `gemini-3.7-flash` $0.75 / $3.75 / $0.075 cached. `gemini-3.5-flash-lite` $0.30 / $2.50 / $0.03 cached. Grounding is $14 per 1,000 searches.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `server/app/tutor/providers/__init__.py` | Neutral event types and the `Provider` protocol. No provider code. |
| `server/app/tutor/providers/openai.py` | The existing behaviour, moved. Payload building, raw→neutral, tool-result items, retry classification. |
| `server/app/tutor/providers/gemini.py` | The same surface against the Interactions API. |
| `server/app/tutor/providers/gemini_schema.py` | `TOOL_DEFINITIONS` → Gemini function declarations. |
| `server/tests/fixtures/interactions.py` | Recorded Gemini stream fixtures, mirroring `fixtures/sse.py`. |
| `server/tests/test_providers.py` | Protocol conformance and the cross-provider parity test. |
| `server/tests/test_gemini_schema.py` | The schema converter's invariant test. |
| `server/scripts/record_interaction.py` | One real call, raw events to stdout. Feeds `fixtures/interactions.py`. |

**Modify:**

| Path | Change |
|---|---|
| `server/app/config.py` | Two price rows, `per_search`, `PROVIDER_FOR_MODEL`, `EFFORTS_FOR_MODEL`, `gemini_api_key`. |
| `server/app/pricing.py` | Price `grounding_tool_count`. |
| `server/app/tutor/loop.py` | Take a `Provider`. Payload building and event classification move out. |
| `server/app/tutor/events.py` | `translate` takes a neutral event, not a raw dict. |
| `server/app/tutor/retry.py` | `classify` becomes the OpenAI classifier behind a shared shape. |
| `server/app/api/turn.py` | Resolve the provider from the model. Validate the `(model, effort)` pair. |
| `MathTutor/Domain/Models.swift` | Two `ModelChoice` cases, `supportedEfforts`, clamp helper. |
| `MathTutor/Features/Settings/SettingsOptions.swift` | `efforts(for:selected:)`. |
| `MathTutor/Features/Settings/SettingsPanes.swift` | Pass the model to the effort row. |
| `MathTutor/TutorStore.swift` | `setModel` clamps the stored effort. |

---

### Task 1: Neutral vocabulary, and the OpenAI provider as a pure refactor

This task adds no capability. Its whole value is that every existing test still passes afterwards, which is what proves the seam did not change behaviour. Do not start Gemini work until this is green.

**Files:**
- Create: `server/app/tutor/providers/__init__.py`
- Create: `server/app/tutor/providers/openai.py`
- Modify: `server/app/tutor/events.py` (`translate`, `_translate`, `_phase_of`, `_heartbeat`)
- Modify: `server/app/tutor/loop.py` (`run_turn`, `_open_round`)
- Modify: `server/app/api/turn.py` (construct and pass the provider)
- Test: `server/tests/test_providers.py`

**Interfaces:**
- Consumes: nothing.
- Produces: everything below is relied on by Tasks 3–9.

```python
# server/app/tutor/providers/__init__.py
from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class ToolCall:
    """One function call a round ended on."""
    name: str
    call_id: str
    #: A JSON string on both providers. OpenAI streams it as
    #: `response.function_call_arguments.delta`; Gemini as an `arguments_delta`
    #: inside `step.delta`. Kept as text so `_workspace_from` and
    #: `_board_update_from` parse exactly what production sent.
    arguments: str


@dataclass(frozen=True)
class ProducedFile:
    """A file a hosted code tool made, and how to get its bytes.

    `key` is what `run_turn` de-duplicates on, so a model that re-cites its
    chart in a later round does not buy a second round to hand over the same
    picture. OpenAI keys on (container_id, file_id); Gemini keys on the step id
    and an index, because its bytes arrive inline and have no ids.
    """
    key: tuple[str, ...]
    filename: str
    read: Callable[[], Awaitable[bytes]]


@dataclass(frozen=True)
class Created:
    pass


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ThoughtDelta:
    text: str


@dataclass(frozen=True)
class ToolCallStarted:
    output_index: int
    name: str
    call_id: str


@dataclass(frozen=True)
class ToolArgsDelta:
    """A call is mid-flight. Carries no content this service forwards.

    It exists so `EventTranslator._phase_of` can keep saying which tool is
    streaming, which is the stretch the learner used to spend staring at
    nothing.
    """
    output_index: int


@dataclass(frozen=True)
class ToolArgsDone:
    output_index: int
    arguments: str


@dataclass(frozen=True)
class HostedToolActivity:
    #: "searching" or "computing".
    phase: str


@dataclass(frozen=True)
class HostedToolStarted:
    """A hosted call is its own output item and has no call_id.

    `item_id` is what the device keys the step row on. A row filed under the
    empty string is one the next call silently overwrites, so a provider that
    cannot supply an id must not emit this.
    """
    item_id: str
    tool: str


@dataclass(frozen=True)
class Completed:
    usage: dict | None
    response_id: str | None
    #: Gemini ends a tool round with "requires_action" rather than a plain
    #: completion. `run_turn` never branches on this — it branches on whether
    #: `calls` is empty, as it already did — but the recorder stores it and the
    #: error branch reads it. See `TERMINAL_ERROR_STATUSES`.
    status: str
    calls: list[ToolCall] = field(default_factory=list)
    files: list[ProducedFile] = field(default_factory=list)


@dataclass(frozen=True)
class Failed:
    message: str
    status: str


#: Every neutral event a provider may emit.
ProviderEvent = (
    Created | TextDelta | ThoughtDelta | ToolCallStarted | ToolArgsDelta
    | ToolArgsDone | HostedToolActivity | HostedToolStarted | Completed | Failed
)

#: Interaction statuses that end a turn badly. `requires_action` is deliberately
#: absent: it is how a normal tool round ends, and treating it as a failure would
#: break every turn that touches the board.
TERMINAL_ERROR_STATUSES: frozenset[str] = frozenset({
    "failed", "cancelled", "budget_exceeded", "incomplete",
})


@dataclass(frozen=True)
class RetryDecision:
    retry: bool
    reason: str


class Provider(Protocol):
    """One model family, reduced to what `run_turn` needs of it."""

    name: str

    def build_round(
        self,
        *,
        model: str,
        effort: str,
        outbox: list[dict],
        previous_id: str | None,
        cache_key: str | None,
    ) -> dict:
        """The request body for one round."""

    async def open_round(self, payload: dict) -> Any:
        """An async context manager yielding raw stream events."""

    def normalise(self, raw: Any) -> tuple[dict, ProviderEvent | None]:
        """One raw event as (recordable dict, neutral event or None).

        The dict is what `TurnResult.raw_events` stores, so it must stay
        JSON-serialisable. `None` for an event this service does not read: the
        heartbeat still fires on it, which is why it is returned rather than
        dropped.
        """

    def tool_output(self, *, call_id: str, name: str, output: str) -> dict:
        """One tool's answer, as an input item for the next round."""

    def image_item(self, png: bytes, caption: str) -> dict:
        """A picture to show the model, as an input item."""

    def classify(self, status_code: int, body: dict | None) -> RetryDecision:
        """Whether a failed open is worth retrying."""
```

- [ ] **Step 1: Write the failing conformance test**

```python
# server/tests/test_providers.py
"""The seam both model families are reached through.

The parity test at the bottom of this file is the point of the whole package:
two providers, one `ClientEvent` sequence. A change that makes one family
behave differently from the other should fail here before anyone notices it on
a board.
"""

from app.tutor.providers import Provider, TERMINAL_ERROR_STATUSES
from app.tutor.providers.openai import OpenAIProvider


def test_requires_action_is_not_a_terminal_error():
    """It is how a normal tool round ends. Treating it as a failure would
    break every turn that calls a tool, which is most of them."""
    assert "requires_action" not in TERMINAL_ERROR_STATUSES


def test_the_openai_provider_satisfies_the_protocol():
    assert isinstance(OpenAIProvider(client=None), Provider)


def test_the_openai_provider_names_itself():
    assert OpenAIProvider(client=None).name == "openai"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && uv run pytest tests/test_providers.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.tutor.providers'`

- [ ] **Step 3: Create the neutral vocabulary**

Write `server/app/tutor/providers/__init__.py` exactly as given in the Interfaces block above. Add `@runtime_checkable` to the `Provider` protocol import list and decorator so `isinstance` works:

```python
from typing import Any, Protocol, runtime_checkable

@runtime_checkable
class Provider(Protocol):
    ...
```

- [ ] **Step 4: Move the OpenAI payload and event code into the provider**

Create `server/app/tutor/providers/openai.py`. Move, do not rewrite:

- `build_round` takes the payload dict currently built inline in `loop.run_turn` at `loop.py:1021-1046`. Copy it verbatim, including every comment. The `prompt_cache_key` branch stays here, and its comment gains a sentence saying it is OpenAI-only because Gemini's implicit caching routes on the prefix by itself.
- `open_round` takes the body of `loop._open_round` at `loop.py:321-355`, minus the retry loop. The retry loop stays in `loop.py` because `RETRY_LIMIT` is shared.
- `normalise` takes the `kind == "response.…"` tests out of `events._translate` and out of the stream loop at `loop.py:1069-1072`, and returns the neutral events. `response.output_text.delta` becomes `TextDelta`; `response.reasoning_summary_text.delta` becomes `ThoughtDelta`; `response.output_item.added` with a `function_call` item becomes `ToolCallStarted`, and with a `code_interpreter_call` item becomes `HostedToolStarted`; `response.function_call_arguments.delta` becomes `ToolArgsDelta`; `response.function_call_arguments.done` becomes `ToolArgsDone`; the `file_search_call.`/`web_search_call.` prefixes become `HostedToolActivity("searching")`; the `code_interpreter_call.` prefix becomes `HostedToolActivity("computing")`; `response.completed` becomes `Completed`, reading `calls` from the `function_call` items and `files` from `_container_citations`.
- `tool_output` returns `{"type": "function_call_output", "call_id": call_id, "output": output}`. The `name` argument is unused here and is in the signature because Gemini's `function_result` requires it.
- `image_item` returns what `loop._image_item` returns today.
- `classify` delegates to `retry.classify`.

`Completed.status` is `"completed"` for this provider. The Responses API has no analogue, and a constant is honest about that.

- [ ] **Step 5: Make `EventTranslator` take neutral events**

In `events.py`, change `translate(self, event: dict)` to `translate(self, event: ProviderEvent | None)`. Replace the `kind` string tests in `_translate` with `isinstance` tests against the neutral types, keeping every branch body unchanged — the phase latch, `TOOL_PHASES`, `TOOL_STEP_LABELS`, `_workspace_from`, `_board_update_from` and `_refined_step` are all untouched.

`_phase_of` becomes:

```python
    def _phase_of(self, event: ProviderEvent | None) -> PhaseName | None:
        """The phase an *untranslatable* event still tells us we are in.

        Argument deltas are the whole point: they carry no content this service
        forwards, but they do say which tool is mid-flight, and that is exactly
        the stretch the learner used to spend staring at nothing.
        """
        if not isinstance(event, ToolArgsDelta):
            return None
        name = self._tool_names.get(event.output_index, "")
        return TOOL_PHASES.get(name)
```

`_heartbeat` keeps working unchanged: it fires on any incoming event and reads only `_phase_of`.

- [ ] **Step 6: Make `run_turn` take a provider**

Add `provider: Provider` as a required keyword argument to `run_turn` and drop `client: AsyncOpenAI`. Replace the inline payload build with `provider.build_round(...)`, the `_open_round(client, payload)` call with a retry loop around `provider.open_round(payload)` using `provider.classify`, and the stream body with:

```python
        async with stream:
            async for raw in stream:
                event, neutral = provider.normalise(raw)
                result.raw_events.append(event)

                if isinstance(neutral, TextDelta):
                    result.text += neutral.text
                elif isinstance(neutral, Completed):
                    result.usage = _merge_usage(result.usage, neutral.usage)
                    result.response_id = neutral.response_id
                    calls = list(neutral.calls)
                    files = list(neutral.files)
                elif isinstance(neutral, Failed):
                    yield ErrorEvent(message=neutral.message), result
                    return

                for client_event in translator.translate(neutral):
                    if isinstance(client_event, WorkspaceEvent):
                        result.workspace = client_event.model_dump(mode="json")
                    yield client_event, result
```

`calls` and `files` replace `output_items`, so the `citations = [...]` comprehension below becomes a filter over `files` against `relayed_ids` using `file.key`. `download_container_file` moves behind `ProducedFile.read`, so the relay path calls `await file.read()` and no longer knows about containers.

Everything else in `run_turn` — `MAX_TOOL_ROUNDS`, the memory budget, the download budget, the rendezvous, `_answer` — is untouched.

- [ ] **Step 7: Wire the provider in `turn.py`**

At `turn.py:103-118`, keep `_client()` and add a `_provider(model: str) -> Provider` that returns `OpenAIProvider(client=_client())`. Pass it to `run_turn`. Task 2 makes this a lookup; for now it returns the OpenAI provider for every model.

- [ ] **Step 8: Run the conformance test**

Run: `cd server && uv run pytest tests/test_providers.py -v`
Expected: PASS

- [ ] **Step 9: Run the tests that prove nothing changed**

Run: `cd server && uv run pytest tests/test_loop.py tests/test_turn_endpoint.py -v`
Expected: PASS, with no test edited. If a test needed editing, the refactor changed behaviour — find out why before continuing.

- [ ] **Step 10: Commit**

```bash
git add server/app/tutor/providers/ server/app/tutor/events.py server/app/tutor/loop.py server/app/api/turn.py server/tests/test_providers.py
git commit -m "Refactor: a provider seam under the turn loop

Payload building and raw-event classification move into
app/tutor/providers/openai.py. EventTranslator now takes a neutral
provider event instead of a Responses API dict, so the phase latch, the
step labels and the board parsers serve both families.

run_turn keeps the round loop, the tool-round bound, the memory budget,
the download budget and the rendezvous. Those constants each carry a
comment naming a real failure they were tuned against, and a second copy
of any of them is a second thing to keep in step.

No behaviour change. test_loop.py and test_turn_endpoint.py pass unedited,
which is the point of the commit."
```

---

### Task 2: Model to provider, with a boot guard

**Files:**
- Modify: `server/app/config.py`
- Modify: `server/app/api/turn.py:103-118`
- Test: `server/tests/test_pricing.py`

**Interfaces:**
- Consumes: `OpenAIProvider` from Task 1.
- Produces: `PROVIDER_FOR_MODEL: dict[str, str]` in `app.config`.

- [ ] **Step 1: Write the failing test**

```python
# append to server/tests/test_pricing.py
from app.config import PROVIDER_FOR_MODEL


def test_every_allowlisted_model_names_a_provider():
    """A model with no provider is a model no turn can route, and finding that
    out at request time means a 500 on a turn the learner already sent."""
    assert MODEL_ALLOWLIST <= set(PROVIDER_FOR_MODEL)


def test_no_provider_entry_is_orphaned():
    """A provider row for a model the device may not name is dead config, and
    dead config is what someone later mistakes for an allowlist."""
    assert set(PROVIDER_FOR_MODEL) <= MODEL_ALLOWLIST
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && uv run pytest tests/test_pricing.py -k provider -v`
Expected: FAIL — `ImportError: cannot import name 'PROVIDER_FOR_MODEL'`

- [ ] **Step 3: Add the table and its boot guard**

In `config.py`, after `MODEL_PRICES_PER_1M`'s guard:

```python
# Which family serves each model, read by `turn.py` to pick a provider.
#
# An explicit table rather than a model-id prefix test. A prefix is a guess
# about how the next model gets named, and this table is cheap to extend and
# impossible to misread. Guarded at import for the reason the price table is:
# an allowlist edit that forgets this row should fail the boot, not a turn the
# learner already sent.
PROVIDER_FOR_MODEL: dict[str, str] = {
    "gpt-5.6-sol": "openai",
    "gpt-5.6-terra": "openai",
    "gpt-5.6-luna": "openai",
}

_unrouted = MODEL_ALLOWLIST - set(PROVIDER_FOR_MODEL)
if _unrouted:
    raise ValueError(f"PROVIDER_FOR_MODEL is missing {sorted(_unrouted)}")
```

- [ ] **Step 4: Make `_provider` a lookup**

```python
# server/app/api/turn.py
def _provider(model: str) -> Provider:
    """The family that serves this model.

    `TurnRequest.model` has already been checked against `MODEL_ALLOWLIST`, and
    every allowlisted model has a provider row or the process did not boot, so
    a KeyError here is unreachable rather than unhandled.
    """
    family = PROVIDER_FOR_MODEL[model]
    if family == "openai":
        return OpenAIProvider(client=_client())
    raise ValueError(f"no provider wired for {family!r}")
```

- [ ] **Step 5: Run the tests**

Run: `cd server && uv run pytest tests/test_pricing.py -k provider -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/app/config.py server/app/api/turn.py server/tests/test_pricing.py
git commit -m "Server: route each model to a provider, guarded at import

An explicit table rather than a model-id prefix test, guarded the way the
price table is: an allowlist edit that forgets the row fails the boot
rather than a turn the learner already sent."
```

---

### Task 3: The Gemini schema converter

**Files:**
- Create: `server/app/tutor/providers/gemini_schema.py`
- Test: `server/tests/test_gemini_schema.py`

**Interfaces:**
- Consumes: `TOOL_DEFINITIONS` from `app.tutor.tools`.
- Produces: `to_gemini_tools(tools: list[dict]) -> list[dict]`, `GEMINI_SUPPORTED_KEYWORDS: frozenset[str]`.

Gemini function declarations accept exactly `type`, `nullable`, `required`, `format`, `description`, `properties`, `items`, `enum`, `anyOf`, `$ref`, `$defs`. This converter drops everything else, and inlines `$ref`/`$defs` despite them being documented as supported, because there are open reports of them being rejected.

- [ ] **Step 1: Write the failing invariant test**

```python
# server/tests/test_gemini_schema.py
"""What survives the trip to a Gemini function declaration.

These are invariant sweeps over the whole produced schema, not spot checks on
its top level. `update_board`'s `elements` is a twelve-arm union built from
`$defs`, and a malformed arm nested three levels down is a blank band on the
learner's board — a top-level assertion would pass while that was broken.
"""

import pytest

from app.tutor.providers.gemini_schema import (
    GEMINI_SUPPORTED_KEYWORDS, to_gemini_tools,
)
from app.tutor.tools import TOOL_DEFINITIONS


def _walk(node):
    """Every dict in the schema tree, the root included."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item)


@pytest.fixture(scope="module")
def converted():
    return to_gemini_tools(TOOL_DEFINITIONS)


def _declarations(tools):
    return [tool for tool in tools if tool.get("type") == "function"]


def test_no_unsupported_keyword_survives_anywhere(converted):
    for declaration in _declarations(converted):
        for node in _walk(declaration["parameters"]):
            unsupported = set(node) - GEMINI_SUPPORTED_KEYWORDS
            assert not unsupported, f"{declaration['name']}: {sorted(unsupported)}"


def test_no_reference_survives_anywhere(converted):
    """Documented as supported, reported as rejected. Inlined instead."""
    for declaration in _declarations(converted):
        for node in _walk(declaration["parameters"]):
            assert "$ref" not in node
            assert "$defs" not in node


def test_strict_is_gone_from_every_declaration(converted):
    for declaration in _declarations(converted):
        assert "strict" not in declaration


def test_every_board_element_arm_keeps_its_discriminator(converted):
    """`const` has no Gemini equivalent, so each arm's `kind` becomes a
    single-value enum. Without it the union is unparseable, and an
    unparseable union is a board that never changes."""
    board = next(d for d in _declarations(converted) if d["name"] == "update_board")
    arms = board["parameters"]["properties"]["elements"]["items"]["anyOf"]
    assert len(arms) >= 12
    for arm in arms:
        kind = arm["properties"]["kind"]
        assert "const" not in kind
        assert len(kind["enum"]) == 1


def test_the_hosted_tools_are_renamed(converted):
    types = {tool["type"] for tool in converted}
    assert "google_search" in types
    assert "code_execution" in types
    assert "web_search" not in types
    assert "code_interpreter" not in types


def test_every_custom_tool_survives_the_trip(converted):
    """A dropped tool is a capability that silently differs between the two
    families, which is the trap the picker is supposed to avoid."""
    before = {t["name"] for t in TOOL_DEFINITIONS if t.get("type") == "function"}
    after = {d["name"] for d in _declarations(converted)}
    assert before == after
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && uv run pytest tests/test_gemini_schema.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.tutor.providers.gemini_schema'`

- [ ] **Step 3: Write the converter**

```python
# server/app/tutor/providers/gemini_schema.py
"""`TOOL_DEFINITIONS` as Gemini function declarations.

One converter rather than a second hand-written schema. The tools are the
tutor's whole board vocabulary; two copies of them would drift, and the drift
would show up as a board that behaves differently depending on which model the
learner picked.

**What is dropped is not what is unchecked.** `strict`, `additionalProperties`
and every numeric and length bound come off here, because Gemini's declaration
schema has nowhere to put them. `parse_board_update` and `lint_svg` still
re-validate every element after the call returns, so the check moves from the
request to the response. It does not disappear. What that costs is the failure
mode: a bound the model breaks is now a rejected element rather than an
argument it was never offered.
"""

from __future__ import annotations

import copy
from typing import Any

#: Exactly what a Gemini function declaration's schema may contain.
#: Everything else is dropped by the provider, so dropping it here is what
#: makes the request predictable rather than silently trimmed upstream.
GEMINI_SUPPORTED_KEYWORDS: frozenset[str] = frozenset({
    "type", "nullable", "required", "format", "description",
    "properties", "items", "enum", "anyOf",
})

#: What each OpenAI hosted tool is called on the other side.
_HOSTED_TOOLS: dict[str, dict] = {
    "web_search": {"type": "google_search"},
    "code_interpreter": {"type": "code_execution"},
}


def _resolve(node: Any, defs: dict[str, Any]) -> Any:
    """Inline every `$ref`, depth-first.

    `$defs` and `$ref` are documented as supported and reported as rejected, so
    this trades schema size for certainty. `_board_element` builds the arms
    programmatically, so what is inlined is one shared point and one shared
    style block per arm — larger on the wire, identical in meaning.

    A reference to a name that is not in `$defs` raises. A silently unresolved
    reference would reach the provider as an empty object, which accepts
    anything, which is how a typo becomes a tool that takes any arguments at
    all.
    """
    if isinstance(node, list):
        return [_resolve(item, defs) for item in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        name = node["$ref"].removeprefix("#/$defs/")
        if name not in defs:
            raise KeyError(f"unresolvable $ref {node['$ref']!r}")
        return _resolve(defs[name], defs)
    return {key: _resolve(value, defs) for key, value in node.items()}


def _strip(node: Any) -> Any:
    """Drop unsupported keywords, and turn `const` into a one-value `enum`.

    `const` is rewritten rather than dropped because it is the `kind`
    discriminator on all twelve arms of `update_board`'s element union. Dropped,
    the arms become indistinguishable and the union stops parsing.
    """
    if isinstance(node, list):
        return [_strip(item) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "const":
            out["enum"] = [value]
        elif key in GEMINI_SUPPORTED_KEYWORDS:
            out[key] = _strip(value)
    return out


def to_gemini_tools(tools: list[dict]) -> list[dict]:
    """Every tool in `tools`, as the Interactions API takes them."""
    converted: list[dict] = []
    for tool in tools:
        kind = tool.get("type")
        if kind in _HOSTED_TOOLS:
            converted.append(dict(_HOSTED_TOOLS[kind]))
            continue
        if kind != "function":
            raise ValueError(f"no Gemini equivalent for tool type {kind!r}")
        parameters = copy.deepcopy(tool.get("parameters") or {})
        defs = parameters.pop("$defs", {})
        converted.append({
            "type": "function",
            "name": tool["name"],
            "description": tool["description"],
            "parameters": _strip(_resolve(parameters, defs)),
        })
    return converted
```

- [ ] **Step 4: Run the invariant test**

Run: `cd server && uv run pytest tests/test_gemini_schema.py -v`
Expected: PASS, all seven tests.

- [ ] **Step 5: Commit**

```bash
git add server/app/tutor/providers/gemini_schema.py server/tests/test_gemini_schema.py
git commit -m "Server: convert the tool schemas to Gemini declarations

Inlines every \$ref, drops the keywords a Gemini declaration has nowhere
to put, and rewrites const as a one-value enum so all twelve arms of
update_board's element union keep their discriminator.

The tests sweep the whole tree rather than its top level. update_board's
union is three levels deep and a malformed arm down there is a blank band
on the board, which a top-level assertion would pass straight over.

Dropping the bounds does not drop the checks: parse_board_update and
lint_svg still re-validate every element."
```

---

### Task 4: Record the Gemini wire shape

The exact JSON keys inside `step.delta` are not something to guess. The event names are documented — `interaction.created`, `step.start`, `step.delta`, `step.stop`, `interaction.completed`, `error` — but the delta payload keys are not, and a fixture built from a guess would test the guess. This task records one real turn first.

**Files:**
- Create: `server/scripts/record_interaction.py`
- Create: `server/tests/fixtures/interactions.py`

**Interfaces:**
- Consumes: `to_gemini_tools` from Task 3.
- Produces: `TEXT_ONLY_INTERACTION`, `TOOL_CALL_INTERACTION`, `TOOL_CALL_FOLLOW_UP`, `BOARD_UPDATE_INTERACTION`, `CODE_EXECUTION_INTERACTION` in `tests/fixtures/interactions.py`, each a tuple of raw event dicts, mirroring `fixtures/sse.py`.

- [ ] **Step 1: Add the dependency**

In `server/pyproject.toml`, add to `dependencies`, keeping the file's habit of explaining a floor:

```toml
    # The Interactions API — stateful rounds via previous_interaction_id,
    # thought summaries, and the native hosted tools — arrived in 2.3.0. The
    # OpenAI compatibility layer would need no new dependency at all, and is
    # not used: it serves /chat/completions only, which has no round chaining.
    "google-genai>=2.3.0",
```

Run: `cd server && uv sync`

- [ ] **Step 2: Write the recorder script**

```python
# server/scripts/record_interaction.py
"""Print the raw events of one real Gemini turn, as fixture source.

The Interactions API's event *names* are documented; the keys inside a
`step.delta` are not. A fixture written from a guess tests the guess, so this
makes one real call and prints what actually arrived.

Usage:

    cd server && uv run python scripts/record_interaction.py "draw a right triangle"

Paste the output into `tests/fixtures/interactions.py`, trimming the argument
deltas to two or three so the fixture stays readable. Keep every event *type*
that appeared, including any this service does not read: the heartbeat fires on
those, and a fixture without them under-tests it.
"""

import asyncio
import json
import sys

from google import genai

from app.config import get_settings
from app.tutor.providers.gemini_schema import to_gemini_tools
from app.tutor.tools import TOOL_DEFINITIONS


async def main(prompt: str) -> None:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise SystemExit("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    stream = await client.aio.interactions.create(
        model="gemini-3.7-flash",
        input=prompt,
        system_instruction="You are a maths tutor. Use your tools.",
        tools=to_gemini_tools(TOOL_DEFINITIONS),
        generation_config={"thinking_level": "low", "thinking_summaries": "auto"},
        store=True,
        stream=True,
    )
    async for event in stream:
        print(json.dumps(event.model_dump(mode="json", exclude_none=True)))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "hello"))
```

- [ ] **Step 3: Record a text-only turn and a tool-call turn**

This step needs a real `GEMINI_API_KEY` in `server/.env` and is the repository owner's to run, because it spends money and needs a key this session does not have.

```bash
cd server && uv run python scripts/record_interaction.py "what is 7 times 8" > /tmp/text_only.jsonl
cd server && uv run python scripts/record_interaction.py "draw a right triangle on the board" > /tmp/tool_call.jsonl
```

- [ ] **Step 4: Build the fixture module from the recordings**

Create `server/tests/fixtures/interactions.py` mirroring `fixtures/sse.py`'s shape: a tuple of dicts per scenario, plus an `interaction_stream(*events)` encoder if the SDK's transport needs one for `respx`. Name the tuples `TEXT_ONLY_INTERACTION`, `TOOL_CALL_INTERACTION`, `TOOL_CALL_FOLLOW_UP`, `BOARD_UPDATE_INTERACTION` and `CODE_EXECUTION_INTERACTION`.

Trim each recording to the smallest set that keeps every event *type* that appeared. Two argument deltas is enough to prove accumulation; forty is noise.

Record in the module docstring the date and the model the recording came from, matching how `MODEL_PRICES_PER_1M` records its verification date.

- [ ] **Step 5: Commit**

```bash
git add server/pyproject.toml server/uv.lock server/scripts/record_interaction.py server/tests/fixtures/interactions.py
git commit -m "Server: record the Gemini interaction wire shape as fixtures

The event names are documented; the keys inside a step.delta are not. A
fixture written from a guess would test the guess, so these come from real
recorded turns, with the model and date in the module docstring."
```

---

### Task 5: The Gemini provider

**Files:**
- Create: `server/app/tutor/providers/gemini.py`
- Modify: `server/app/config.py` (`gemini_api_key`)
- Modify: `server/app/api/turn.py` (`_provider`)
- Test: `server/tests/test_providers.py`

**Interfaces:**
- Consumes: the neutral types from Task 1, `to_gemini_tools` from Task 3, the fixtures from Task 4.
- Produces: `GeminiProvider(client, tools)`, `EFFORT_TO_THINKING_LEVEL: dict[str, str]`.

- [ ] **Step 1: Write the failing tests**

```python
# append to server/tests/test_providers.py
from app.tutor.providers import (
    Completed, TextDelta, ThoughtDelta, ToolArgsDone, ToolCallStarted,
)
from app.tutor.providers.gemini import EFFORT_TO_THINKING_LEVEL, GeminiProvider
from tests.fixtures.interactions import TEXT_ONLY_INTERACTION


def test_the_gemini_provider_satisfies_the_protocol():
    assert isinstance(GeminiProvider(client=None), Provider)


def test_a_round_lifts_the_system_prompt_out_of_the_input():
    """OpenAI takes a system item inside `input`; Gemini takes a top-level
    `system_instruction`. Left in `input`, the prompt would arrive as a user
    turn and the tutor's whole character would be advice rather than
    instruction."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash",
        effort="high",
        outbox=[
            {"role": "system", "content": [{"type": "input_text", "text": "BE A TUTOR"}]},
            {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        ],
        previous_id=None,
        cache_key="session-1",
    )
    assert payload["system_instruction"] == "BE A TUTOR"
    assert all(item.get("role") != "system" for item in payload["input"])


def test_a_round_never_sends_the_rejected_generation_parameters():
    """Gemini 3.x rejects all three, and thinking_budget is superseded."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="high", outbox=[], previous_id=None,
        cache_key=None,
    )
    for rejected in ("temperature", "top_p", "top_k"):
        assert rejected not in payload
        assert rejected not in payload["generation_config"]
    assert "thinking_budget" not in payload["generation_config"]


def test_a_round_carries_no_cache_key():
    """There is no prompt_cache_key equivalent: implicit caching routes on the
    prefix by itself. A key passed through would be an unknown field."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="high", outbox=[], previous_id=None,
        cache_key="session-1",
    )
    assert "prompt_cache_key" not in payload


def test_later_rounds_chain_on_the_previous_interaction():
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="medium", outbox=[], previous_id="int_9",
        cache_key=None,
    )
    assert payload["previous_interaction_id"] == "int_9"


def test_the_deep_efforts_clamp_to_high():
    """Gemini offers three levels where the picker offers five. The client
    clamps before sending, and this is the second line of that defence."""
    assert EFFORT_TO_THINKING_LEVEL["xhigh"] == "high"
    assert EFFORT_TO_THINKING_LEVEL["max"] == "high"
    assert EFFORT_TO_THINKING_LEVEL["low"] == "low"


def test_an_image_part_splits_the_data_url():
    """OpenAI takes one data: URL string; Gemini takes the mime type and the
    raw base64 in separate fields."""
    item = GeminiProvider(client=None).image_item(b"\x89PNG...", "look")
    part = next(p for p in item["content"] if p["type"] == "image")
    assert part["mime_type"] == "image/png"
    assert "data:" not in part["data"]


def test_a_tool_result_names_its_function():
    """function_result carries the name as well as the call_id. OpenAI's
    function_call_output carries only the id, which is why `name` is in the
    shared signature at all."""
    item = GeminiProvider(client=None).tool_output(
        call_id="call_1", name="update_board", output='{"status":"ok"}',
    )
    assert item["type"] == "function_result"
    assert item["call_id"] == "call_1"
    assert item["name"] == "update_board"


def test_a_text_only_interaction_normalises_to_the_expected_events():
    provider = GeminiProvider(client=None)
    neutral = [provider.normalise(raw)[1] for raw in TEXT_ONLY_INTERACTION]
    assert any(isinstance(event, TextDelta) for event in neutral)
    completed = next(e for e in neutral if isinstance(e, Completed))
    assert completed.response_id
    assert completed.usage is not None
```

Write `TEXT_ONLY_INTERACTION` into the test as recorded in Task 4. If a recorded event type is not read by the provider, `normalise` returns `None` for it and that is correct — assert on the events that are present rather than on the list length, so a provider that emits an extra keep-alive event does not fail the test.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && uv run pytest tests/test_providers.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.tutor.providers.gemini'`

- [ ] **Step 3: Add the API key setting**

In `config.py`'s `Settings`:

```python
    #: The Gemini key, env `GEMINI_API_KEY`. Optional so the server still boots
    #: with only an OpenAI key configured.
    #:
    #: Deliberately not the fail-the-boot treatment `MODEL_PRICES_PER_1M` gets.
    #: That guard exists because an unpriced model makes spend invisible, which
    #: is a money problem nobody sees. A missing key makes Gemini turns fail
    #: loudly, which is a problem that reports itself and that arriving key
    #: fixes.
    gemini_api_key: str | None = None
```

- [ ] **Step 4: Write the provider**

Create `server/app/tutor/providers/gemini.py`. It implements the `Provider` protocol:

```python
#: The picker's five efforts as Gemini's three thinking levels.
#:
#: `xhigh` and `max` clamp to `high` because Gemini has nothing deeper.
#: `TutorStore.setModel` clamps on the device before a turn is ever sent, so in
#: normal operation nothing reaches this map that needs clamping. It is here for
#: the turn that does anyway — an older client, or a session restored from a
#: file written before the clamp existed.
EFFORT_TO_THINKING_LEVEL: dict[str, str] = {
    "low": "low", "medium": "medium", "high": "high",
    "xhigh": "high", "max": "high",
}
```

`build_round` returns:

```python
        payload: dict = {
            "model": model,
            "input": input_items,
            "system_instruction": system_instruction,
            "tools": self._tools,
            "generation_config": {
                "thinking_level": EFFORT_TO_THINKING_LEVEL[effort],
                "thinking_summaries": "auto",
                # What `strict: True` bought on the other side. Interaction-
                # scoped rather than per-tool, which is why risk 2 in the spec
                # asks for it to be measured against hosted-tool selection
                # rather than assumed free.
                "tool_choice": "validated",
            },
            # Retained 55 days on the paid tier, and that is the point: it is
            # what `previous_interaction_id` chains against, so the thinking
            # behind a tool call survives into the round that has to act on it.
            "store": True,
            "stream": True,
        }
```

`cache_key` is accepted and ignored, with a comment saying implicit caching routes on the prefix by itself and there is no field to put a key in.

`normalise` maps, keyed on `event_type`:

| Raw | Neutral |
|---|---|
| `interaction.created` | `Created()` |
| `step.delta` carrying a text delta | `TextDelta` |
| `step.delta` carrying a thought-summary delta | `ThoughtDelta` |
| `step.delta` carrying an `arguments_delta` | `ToolArgsDelta` |
| `step.start` on a `function_call` step | `ToolCallStarted` |
| `step.start` on a `code_execution_call` step | `HostedToolStarted` |
| `step.stop` on a `function_call` step | `ToolArgsDone` with the accumulated arguments |
| a `google_search_call` step | `HostedToolActivity("searching")` |
| a `code_execution_call` step | `HostedToolActivity("computing")` |
| `interaction.completed` | `Completed` |
| `error` | `Failed` |

The provider accumulates argument text per step across `step.delta` events, because arguments arrive as incremental JSON strings and `ToolArgsDone` carries the whole string. Use the step index as the `output_index` so `EventTranslator._tool_names` keeps working.

`Completed` reads `usage` through a mapping function:

```python
def map_usage(usage: dict) -> dict:
    """Interactions usage in the shape the recorder already writes.

    Mapped rather than stored raw so `recorder._apply_usage` and
    `pricing.turn_cost_usd` need no provider branch. `total_thought_tokens`
    lands under `output_tokens_details.reasoning_tokens` because Gemini bills
    thinking inside the output tokens, exactly as the OpenAI family does — a
    separate rate would double-charge.

    `cache_write_tokens` has no equivalent and stays absent, so the column
    stays NULL. A NULL is a visible gap someone can query for, which is the
    rule `recorder.cache_tokens` already follows.

    `grounding_tool_count` rides through untouched. `turn_cost_usd` prices it,
    and it is the one number here that is not a token.
    """
    return {
        "input_tokens": usage.get("total_input_tokens"),
        "output_tokens": usage.get("total_output_tokens"),
        "input_tokens_details": {"cached_tokens": usage.get("total_cached_tokens")},
        "output_tokens_details": {
            "reasoning_tokens": usage.get("total_thought_tokens"),
        },
        # Recorded, not priced: the code-execution documentation describes these
        # as intermediate tokens already counted in input and output.
        "tool_use_tokens": usage.get("total_tool_use_tokens"),
        "grounding_tool_count": _searches(usage),
    }
```

`_searches(usage)` sums the `grounding_tool_count` entries for search tools into one integer.

`Completed.status` is the interaction's own `status`, so `requires_action` arrives as itself. `run_turn` branches on whether `calls` is empty, exactly as it already did, so no loop change is needed for it.

`Completed.files` reads inline code-execution images. Each becomes a `ProducedFile` whose `read` returns the already-decoded bytes and whose `key` is `(step_id, str(index))`.

`classify` maps Gemini's failures: 429 retryable unless the body names a quota-exhaustion code, 5xx retryable, everything else final. Keep `RetryDecision`'s reason strings specific — they are logged.

- [ ] **Step 5: Wire it into `_provider`**

```python
    if family == "gemini":
        settings = get_settings()
        if not settings.gemini_api_key:
            raise HTTPException(
                status_code=503,
                detail="GEMINI_API_KEY is not configured on this server",
            )
        return GeminiProvider(client=_gemini_client())
```

`_gemini_client()` mirrors `_client()`: one `genai.Client` per call, for the reason `_client`'s comment gives.

- [ ] **Step 6: Run the tests**

Run: `cd server && uv run pytest tests/test_providers.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/app/tutor/providers/gemini.py server/app/config.py server/app/api/turn.py server/tests/test_providers.py
git commit -m "Server: a Gemini provider on the Interactions API

Lifts the system prompt to system_instruction, splits image data URLs into
mime_type and data, maps the picker's five efforts onto three thinking
levels, and never sends temperature, top_p or top_k.

requires_action arrives as itself. It is how a normal tool round ends, and
run_turn already branches on whether there are calls rather than on a
status, so no loop change was needed for it.

Usage is mapped into the shape the recorder already writes, so
_apply_usage and turn_cost_usd need no provider branch. Thought tokens
land under reasoning_tokens and are not priced separately: Gemini bills
thinking inside the output tokens, the same as the OpenAI family."
```

---

### Task 6: Price the two models, and price grounding

**Files:**
- Modify: `server/app/config.py`
- Modify: `server/app/pricing.py`
- Test: `server/tests/test_pricing.py`

**Interfaces:**
- Consumes: `PROVIDER_FOR_MODEL` from Task 2.
- Produces: two `MODEL_PRICES_PER_1M` rows with a `per_search` key; `turn_cost_usd` priced on searches.

- [ ] **Step 1: Write the failing tests**

```python
# append to server/tests/test_pricing.py
def test_a_flash_turn_costs_input_plus_output():
    cost = turn_cost_usd(
        "gemini-3.7-flash",
        {"input_tokens": 1_000_000, "output_tokens": 1_000_000},
    )
    assert cost == pytest.approx(0.75 + 3.75)


def test_a_flash_lite_turn_costs_input_plus_output():
    cost = turn_cost_usd(
        "gemini-3.5-flash-lite",
        {"input_tokens": 1_000_000, "output_tokens": 1_000_000},
    )
    assert cost == pytest.approx(0.30 + 2.50)


def test_grounding_searches_are_priced_on_top_of_the_tokens():
    """$14 per 1,000 searches, and not a token charge. One search costs what
    ~47,000 Flash-Lite input tokens cost, so a grounded turn priced on tokens
    alone reports a fraction of its cost and spend_today() leaks under the
    cap."""
    cost = turn_cost_usd(
        "gemini-3.5-flash-lite",
        {"input_tokens": 0, "output_tokens": 0, "grounding_tool_count": 3},
    )
    assert cost == pytest.approx(3 * 0.014)


def test_the_free_search_allowance_is_not_modelled():
    """Deliberate. Tracking it needs monthly state the recorder does not have,
    and the allowance is shared with any other Gemini 3.x usage on the key.
    Over-reporting errs toward the cap tripping early, which is the safe
    direction for a spend guard."""
    assert turn_cost_usd("gemini-3.7-flash", {"grounding_tool_count": 1}) > 0


def test_an_openai_turn_is_not_charged_for_searches():
    """No per_search row, so the term is zero rather than a KeyError."""
    cost = turn_cost_usd(
        "gpt-5.6-luna",
        {"input_tokens": 1_000_000, "output_tokens": 0, "grounding_tool_count": 5},
    )
    assert cost == pytest.approx(0.20)


def test_thought_tokens_are_not_priced_twice():
    """Gemini bills thinking inside the output tokens, so a reasoning
    breakdown must not add to the bill."""
    without = turn_cost_usd(
        "gemini-3.7-flash", {"input_tokens": 0, "output_tokens": 1_000_000},
    )
    with_breakdown = turn_cost_usd(
        "gemini-3.7-flash",
        {
            "input_tokens": 0, "output_tokens": 1_000_000,
            "output_tokens_details": {"reasoning_tokens": 900_000},
        },
    )
    assert without == with_breakdown


def test_flash_is_cheaper_than_terra_on_both_halves():
    """The picker's reason to exist. If this ever fails, the caption on the
    settings row is a lie on screen."""
    flash = MODEL_PRICES_PER_1M["gemini-3.7-flash"]
    terra = MODEL_PRICES_PER_1M["gpt-5.6-terra"]
    assert flash["input"] < terra["input"]
    assert flash["output"] < terra["output"]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && uv run pytest tests/test_pricing.py -k "flash or grounding or thought" -v`
Expected: FAIL — `no price row for model 'gemini-3.7-flash'`, so `turn_cost_usd` returns `None`.

- [ ] **Step 3: Add the price rows**

In `config.py`, extend `MODEL_PRICES_PER_1M`. Match the file's habit of stating the verification date:

```python
    # Verified against ai.google.dev/gemini-api/docs/pricing on 2026-08-16.
    #
    # **These are introductory rates and they expire.** $0.75/$3.75 runs through
    # 2026-12-31; on 2027-01-01 Flash becomes $1.50/$7.50 and its cached rate
    # $0.15. The introductory numbers are here rather than the 2027 ones because
    # putting the higher price in early would quietly halve the effective daily
    # cap on Gemini for four months, and a cap that trips early reads as a bug
    # and gets raised. Nothing enforces this date — see the spec's risk 4.
    #
    # `per_search` is not a token rate. Grounding with Google Search bills $14
    # per 1,000 requests, and one turn may run several queries. At $0.014 a
    # search that is what ~47,000 Flash-Lite input tokens cost, so a grounded
    # turn priced on tokens alone would report a fraction of its spend. The
    # 5,000-per-month free allowance is deliberately not modelled: it needs
    # monthly state the recorder does not have and it is shared with any other
    # Gemini 3.x usage on the key, so this over-reports inside the free tier and
    # errs toward the cap tripping early.
    "gemini-3.7-flash": {
        "input": 0.75, "cached_input": 0.075, "output": 3.75, "per_search": 0.014,
    },
    # Flash-Lite's price carries no expiry.
    "gemini-3.5-flash-lite": {
        "input": 0.30, "cached_input": 0.03, "output": 2.50, "per_search": 0.014,
    },
```

Extend `MODEL_ALLOWLIST` and `PROVIDER_FOR_MODEL` with both ids, the latter mapping to `"gemini"`.

Cache storage is not priced. Add a comment saying so: the storage fee applies to explicit caching, this design uses implicit caching, and anyone adding explicit caching later must revisit the cap.

- [ ] **Step 4: Price searches in `turn_cost_usd`**

```python
    # Not a token rate, and not divided by a million. Grounding bills per
    # search request, so this term is a count times a price. Absent on the
    # OpenAI rows, where it reads as zero rather than raising.
    searches = usage.get("grounding_tool_count") or 0
    search_cost = searches * prices.get("per_search", 0.0)

    return (
        (input_tokens - cached) * prices["input"]
        + cached * prices["cached_input"]
        + output_tokens * prices["output"]
    ) / 1_000_000 + search_cost
```

The early `if not usage: return None` guard stays. A usage dict carrying only `grounding_tool_count` is not empty, so a search-only turn still prices.

- [ ] **Step 5: Run the tests**

Run: `cd server && uv run pytest tests/test_pricing.py -v`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add server/app/config.py server/app/pricing.py server/tests/test_pricing.py
git commit -m "Server: price the two Gemini models, and price grounding

Grounding with Google Search bills \$14 per 1,000 requests, not tokens.
One search costs what ~47,000 Flash-Lite input tokens cost, so the price
table grows a per_search dimension and turn_cost_usd multiplies the
count. Without it spend_today() leaks straight under the daily cap.

The 5,000-per-month free allowance is not modelled: it needs monthly
state the recorder does not have and is shared with any other Gemini 3.x
usage on the key. So this over-reports inside the free tier, which errs
toward the cap tripping early.

Flash's rates are introductory and double on 2027-01-01. The comment
carries the date; nothing enforces it."
```

---

### Task 7: Effort sets per model

**Files:**
- Modify: `server/app/config.py`
- Modify: `server/app/api/turn.py:307-319`
- Test: `server/tests/test_turn_request.py`

**Interfaces:**
- Consumes: `MODEL_ALLOWLIST`, `PROVIDER_FOR_MODEL`.
- Produces: `EFFORTS_FOR_MODEL: dict[str, frozenset[str]]`.

Note: a concurrent change removed `ReasoningEffort.none` from the client, so client and server already agree at five levels. `EFFORTS_FOR_MODEL` does not need to carry `none`.

- [ ] **Step 1: Write the failing tests**

```python
# append to server/tests/test_turn_request.py
import pytest
from pydantic import ValidationError

from app.config import EFFORTS_FOR_MODEL, MODEL_ALLOWLIST


def _body(**overrides):
    body = {
        "turn_id": "00000000-0000-4000-8000-000000000001",
        "session_id": "00000000-0000-4000-8000-000000000002",
        "text": "hi",
        "model": "gemini-3.7-flash",
        "reasoning_effort": "high",
    }
    return {**body, **overrides}


def test_every_allowlisted_model_has_an_effort_set():
    assert MODEL_ALLOWLIST <= set(EFFORTS_FOR_MODEL)


def test_no_effort_set_is_empty():
    """A model with no efforts is a model no turn can name an effort for."""
    assert all(efforts for efforts in EFFORTS_FOR_MODEL.values())


def test_gemini_rejects_the_deep_efforts():
    """Gemini offers three levels. The picker clamps on the device; this is
    the guard behind it, and it exists because effort multiplies reasoning
    tokens and reasoning bills at the output rate."""
    with pytest.raises(ValidationError):
        TurnRequest(**_body(reasoning_effort="max"))


def test_gemini_accepts_high():
    assert TurnRequest(**_body(reasoning_effort="high")).reasoning_effort == "high"


def test_openai_still_accepts_max():
    assert TurnRequest(
        **_body(model="gpt-5.6-sol", reasoning_effort="max")
    ).reasoning_effort == "max"


def test_the_pair_is_reported_in_the_refusal():
    """A 422 that names only the effort leaves the learner's client guessing
    which of the two values was wrong."""
    with pytest.raises(ValidationError) as caught:
        TurnRequest(**_body(reasoning_effort="max"))
    assert "gemini-3.7-flash" in str(caught.value)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && uv run pytest tests/test_turn_request.py -k "effort" -v`
Expected: FAIL — `ImportError: cannot import name 'EFFORTS_FOR_MODEL'`

- [ ] **Step 3: Add the table**

Replace `REASONING_EFFORT_ALLOWLIST` in `config.py` with a per-model table, keeping the original comment's reasoning and adding why it is now per model:

```python
# The efforts each model may be asked for.
#
# Per model rather than one set, because the two families do not offer the same
# depths: the gpt-5.6 route takes five, and Gemini takes three. A single
# allowlist would have to be their union, which means accepting `max` for a
# model that has no such level and failing mid-stream at the provider instead of
# at this boundary.
#
# The reason a guard exists at all is unchanged. `reasoning_effort` arrives
# unvalidated from the device, and effort multiplies reasoning tokens, which
# bill at the *output* rate: six times input on Luna, $30 per million on Sol.
# Gating the model and not the effort closes half of "any model at any price".
#
# It also stops a typo becoming a failed turn. An unknown effort is a 400 from
# the provider mid-stream; a 422 from here says which values exist.
_OPENAI_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
_GEMINI_EFFORTS = frozenset({"low", "medium", "high"})

EFFORTS_FOR_MODEL: dict[str, frozenset[str]] = {
    "gpt-5.6-sol": _OPENAI_EFFORTS,
    "gpt-5.6-terra": _OPENAI_EFFORTS,
    "gpt-5.6-luna": _OPENAI_EFFORTS,
    "gemini-3.7-flash": _GEMINI_EFFORTS,
    "gemini-3.5-flash-lite": _GEMINI_EFFORTS,
}

_effortless = MODEL_ALLOWLIST - set(EFFORTS_FOR_MODEL)
if _effortless:
    raise ValueError(f"EFFORTS_FOR_MODEL is missing {sorted(_effortless)}")
```

Grep for `REASONING_EFFORT_ALLOWLIST` and update every reader.

- [ ] **Step 4: Validate the pair**

`reasoning_effort` cannot be validated alone any more, because it needs the model. Replace the field validator with a model validator that runs after both fields are set:

```python
    @model_validator(mode="after")
    def _effort_must_suit_the_model(self) -> "TurnRequest":
        allowed = EFFORTS_FOR_MODEL[self.model]
        if self.reasoning_effort not in allowed:
            raise ValueError(
                f"Model {self.model!r} does not accept reasoning effort "
                f"{self.reasoning_effort!r}. Allowed: {sorted(allowed)}"
            )
        return self
```

The `model` field validator stays, and it must keep running first: `EFFORTS_FOR_MODEL[self.model]` is only safe because an unknown model has already been refused. Pydantic runs field validators before `mode="after"` model validators, so this holds — but state it in a comment, because it is the kind of ordering that looks incidental and is not.

- [ ] **Step 5: Run the tests**

Run: `cd server && uv run pytest tests/test_turn_request.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/app/config.py server/app/api/turn.py server/tests/test_turn_request.py
git commit -m "Server: allow reasoning efforts per model, not globally

The two families do not offer the same depths — five on gpt-5.6, three on
Gemini — so a single allowlist would have to be their union and would
accept 'max' for a model with no such level, failing mid-stream at the
provider instead of at this boundary.

The reason for the guard is unchanged: effort multiplies reasoning
tokens, and reasoning bills at the output rate."
```

---

### Task 8: The client picks a Gemini model

**Files:**
- Modify: `MathTutor/Domain/Models.swift` (`ModelChoice`)
- Modify: `MathTutor/Features/Settings/SettingsOptions.swift`
- Modify: `MathTutor/Features/Settings/SettingsPanes.swift:79`
- Modify: `MathTutor/TutorStore.swift:1392-1395`
- Test: `MathTutorTests/SettingsAndPlanTests.swift`

**Interfaces:**
- Consumes: nothing from the server tasks. The model id strings must match `MODEL_ALLOWLIST` exactly.
- Produces: `ModelChoice.flash`, `ModelChoice.flashLite`, `ModelChoice.supportedEfforts`, `ModelChoice.clamp(_:)`, `SettingsOption.efforts(for:selected:)`.

Re-read all four files before editing. A concurrent session has been editing `Models.swift` and `SettingsOptions.swift`.

- [ ] **Step 1: Write the failing tests**

```swift
// append to MathTutorTests/SettingsAndPlanTests.swift
@Test func modelPickerOffersBothFamilies() {
    let options = SettingsOption.models(selected: .luna)
    #expect(options.count == ModelChoice.allCases.count)
    #expect(options.map(\.value).contains(.flash))
    #expect(options.map(\.value).contains(.flashLite))
    #expect(options.filter(\.isSelected).count == 1)
}

@Test func geminiModelsOfferThreeEfforts() {
    // Gemini's thinking_level is low / medium / high. Offering X-High would
    // show a level the request cannot carry.
    #expect(ModelChoice.flash.supportedEfforts == [.low, .medium, .high])
    #expect(ModelChoice.flashLite.supportedEfforts == [.low, .medium, .high])
}

@Test func openAIModelsKeepAllFiveEfforts() {
    #expect(ModelChoice.sol.supportedEfforts == [.low, .medium, .high, .xhigh, .max])
}

@Test func theEffortRowFollowsTheSelectedModel() {
    let options = SettingsOption.efforts(for: .flash, selected: .high)
    #expect(options.map(\.value) == [.low, .medium, .high])
    #expect(options.filter(\.isSelected).count == 1)
}

@Test func switchingToGeminiClampsADeepEffort() {
    // Without the clamp the session keeps an effort the model does not accept
    // and the next turn 422s.
    #expect(ModelChoice.flash.clamp(.max) == .high)
    #expect(ModelChoice.flash.clamp(.xhigh) == .high)
}

@Test func switchingToGeminiLeavesASupportedEffortAlone() {
    #expect(ModelChoice.flash.clamp(.medium) == .medium)
}

@Test func setModelClampsTheStoredEffort() {
    let store = TutorStore.previewStore()
    store.setReasoningEffort(.max)
    store.setModel(.flash)
    #expect(store.session.reasoningEffort == .high)
    #expect(store.session.selectedModel == .flash)
}

@Test func setModelBackToOpenAIDoesNotRestoreTheDeepEffort() {
    // The clamp is lossy on purpose. Restoring `max` would mean storing a
    // shadow effort per family, and two efforts in one row is a trap.
    let store = TutorStore.previewStore()
    store.setReasoningEffort(.max)
    store.setModel(.flash)
    store.setModel(.sol)
    #expect(store.session.reasoningEffort == .high)
}

@Test func aGeminiModelSurvivesASessionRoundTrip() throws {
    var session = LearningSession.empty()
    session.selectedModel = .flashLite
    let data = try JSONEncoder().encode(session)
    let restored = try JSONDecoder().decode(LearningSession.self, from: data)
    #expect(restored.selectedModel == .flashLite)
}
```

Match the existing file's test style. If it uses XCTest rather than Swift Testing, convert these to `func test…()` with `XCTAssertEqual`, and use whatever store factory the file already uses instead of `previewStore()`.

- [ ] **Step 2: Build to verify the tests fail**

Run: `cd /Users/nordup/Projects/other/math-tutor && xcodebuild -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' build-for-testing 2>&1 | tail -20`
Expected: compile failure — `type 'ModelChoice' has no member 'flash'`

Check first whether the owner has a build running, and never kill theirs.

- [ ] **Step 3: Add the cases and the effort sets**

In `Models.swift`, extend `ModelChoice`:

```swift
    case flash = "gemini-3.7-flash"
    case flashLite = "gemini-3.5-flash-lite"
```

Add to `displayName`: `.flash` → `"Flash"`, `.flashLite` → `"Flash-Lite"`.

Add to `caption`: `.flash` → `"Wide context"`, `.flashLite` → `"Cheapest deep reasoning"`. Neither caption claims Gemini is cheaper than Luna, because it is not — Flash-Lite's $0.30/$2.50 is above Luna's $0.20/$1.20. The saving is against Terra and Sol.

Add to `caption(for:)` following the existing pattern.

Then:

```swift
    /// The reasoning depths this model actually accepts.
    ///
    /// Gemini's `thinking_level` is low / medium / high; the gpt-5.6 route takes
    /// five. The picker reads this so it never shows a level the request cannot
    /// carry, which is the whole reason the row is model-dependent.
    var supportedEfforts: [ReasoningEffort] {
        switch self {
        case .sol, .terra, .luna: [.low, .medium, .high, .xhigh, .max]
        case .flash, .flashLite: [.low, .medium, .high]
        }
    }

    /// `effort` if this model accepts it, otherwise the deepest one it does.
    ///
    /// Lossy on purpose. Restoring the original depth when the learner switches
    /// back would mean storing one effort per family, and two efforts behind one
    /// row is a trap — the row would show a level the next turn did not use.
    func clamp(_ effort: ReasoningEffort) -> ReasoningEffort {
        supportedEfforts.contains(effort) ? effort : (supportedEfforts.last ?? .high)
    }
```

`supportedEfforts.last` is the deepest because both arrays are written shallow-to-deep. Say so in a comment — the ordering is load-bearing and looks incidental.

- [ ] **Step 4: Make the effort options model-dependent**

In `SettingsOptions.swift`, replace `efforts(selected:)`. Keep the existing comment's history about `None` and add why the set now depends on the model:

```swift
    /// Board 10's `Reasoning effort` row, for the model that is selected.
    ///
    /// `ModelChoice.supportedEfforts` rather than `ReasoningEffort.allCases`:
    /// the two families offer different depths, and a row that lists X-High
    /// while a Gemini model is chosen offers a level the request cannot carry.
    static func efforts(for model: ModelChoice, selected: ReasoningEffort) -> [Self] {
        model.supportedEfforts.map {
            Self(value: $0, title: $0.displayName, caption: $0.caption, isSelected: $0 == selected)
        }
    }
```

In `SettingsPanes.swift:79`, pass the model:

```swift
                options: SettingsOption.efforts(
                    for: store.session.selectedModel,
                    selected: store.session.reasoningEffort
                ),
```

- [ ] **Step 5: Clamp in `setModel`**

```swift
    /// Moves the model, and the effort with it when the new model is shallower.
    ///
    /// Without the clamp a session sitting on Max would keep sending it after a
    /// switch to Gemini, and every turn would 422 at `TurnRequest`. The picker
    /// would also be showing a level that is not in the new model's row.
    func setModel(_ model: ModelChoice) {
        session.selectedModel = model
        session.reasoningEffort = model.clamp(session.reasoningEffort)
        persist()
    }
```

- [ ] **Step 6: Build for testing**

Run: `cd /Users/nordup/Projects/other/math-tutor && xcodebuild -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' build-for-testing 2>&1 | tail -20`
Expected: BUILD SUCCEEDED. Do not run the tests — that is the owner's step.

- [ ] **Step 7: Commit**

```bash
git add MathTutor/Domain/Models.swift MathTutor/Features/Settings/SettingsOptions.swift MathTutor/Features/Settings/SettingsPanes.swift MathTutor/TutorStore.swift MathTutorTests/SettingsAndPlanTests.swift
git commit -m "Device: pick a Gemini model, with efforts that follow it

Flash and Flash-Lite join the Tutor model row. The Reasoning effort row
now reads ModelChoice.supportedEfforts, because Gemini offers three
depths where the gpt-5.6 route offers five, and a row listing X-High
under a Gemini model offers a level the request cannot carry.

setModel clamps a stored xhigh or max down to high. Without it a session
on Max would 422 every turn after the switch.

The clamp is lossy on purpose: restoring the original depth would mean an
effort stored per family, and two efforts behind one row is a trap.

No new row, so SettingsWindowMetrics is untouched."
```

---

### Task 9: Both providers, one client-event sequence

The parity test is the point of the whole seam. It is last because it needs every other task, and it is the test to keep if any other is ever dropped.

**Files:**
- Modify: `server/tests/test_providers.py`
- Test: the same file

**Interfaces:**
- Consumes: everything from Tasks 1–7, plus both fixture modules.

- [ ] **Step 1: Write the parity test**

```python
# append to server/tests/test_providers.py
"""Two providers, one ClientEvent sequence."""

import pytest

from app.tutor.events import (
    BoardUpdateEvent, EventTranslator, StatusEvent, TextDeltaEvent,
)
from tests.fixtures.interactions import BOARD_UPDATE_INTERACTION
from tests.fixtures.sse import BOARD_UPDATE_TURN


def _client_events(provider, raw_events):
    """Every ClientEvent one recorded stream produces, in order."""
    translator = EventTranslator(now=lambda: 0.0)
    produced = []
    for raw in raw_events:
        _, neutral = provider.normalise(raw)
        produced.extend(translator.translate(neutral))
    return produced


def _shape(events):
    """The sequence reduced to what the device actually reacts to.

    Text is joined rather than compared delta by delta: the two providers chunk
    prose differently and that is not a difference the learner can see. What
    must match is the order of *kinds* and the board update itself.
    """
    kinds = [type(event).__name__ for event in events]
    text = "".join(e.text for e in events if isinstance(e, TextDeltaEvent))
    boards = [e for e in events if isinstance(e, BoardUpdateEvent)]
    return kinds, text, boards


def test_a_board_update_turn_produces_the_same_shape_on_both_providers():
    openai_events = _client_events(OpenAIProvider(client=None), BOARD_UPDATE_TURN)
    gemini_events = _client_events(GeminiProvider(client=None), BOARD_UPDATE_INTERACTION)

    openai_kinds, openai_text, openai_boards = _shape(openai_events)
    gemini_kinds, gemini_text, gemini_boards = _shape(gemini_events)

    assert gemini_kinds == openai_kinds
    assert gemini_text == openai_text
    assert len(gemini_boards) == len(openai_boards) == 1
    assert gemini_boards[0].model_dump() == openai_boards[0].model_dump()


def test_both_providers_announce_the_board_phase_before_drawing():
    """The status that stops the learner staring at nothing while a detailed
    diagram's arguments stream. It has to arrive at the head of the call on
    both families, not at the next heartbeat."""
    for provider, fixture in (
        (OpenAIProvider(client=None), BOARD_UPDATE_TURN),
        (GeminiProvider(client=None), BOARD_UPDATE_INTERACTION),
    ):
        events = _client_events(provider, fixture)
        first_status = next(e for e in events if isinstance(e, StatusEvent))
        board_index = next(
            i for i, e in enumerate(events) if isinstance(e, BoardUpdateEvent)
        )
        assert events.index(first_status) < board_index
```

The two fixtures must describe the *same turn*: the same prose and the same `update_board` arguments. When recording `BOARD_UPDATE_INTERACTION` in Task 4, use the arguments already in `BOARD_UPDATE_TURN` so this test compares like with like. If the recorded Gemini turn drew something different, hand-edit the recorded arguments to match — the wire *shape* is what needed recording, not the model's choice of triangle.

- [ ] **Step 2: Run it**

Run: `cd server && uv run pytest tests/test_providers.py -v`
Expected: PASS. A failure here is the seam not holding, and it is worth reading closely rather than patching the assertion.

- [ ] **Step 3: Run the whole turn path once**

Run: `cd server && uv run pytest tests/test_loop.py tests/test_providers.py tests/test_pricing.py tests/test_turn_request.py tests/test_gemini_schema.py -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/tests/test_providers.py
git commit -m "Test: both providers produce one client-event sequence

The parity test the seam exists for. Two recorded streams of the same
turn, one on each family, reduced to the order of event kinds, the joined
prose and the board update itself.

Text is joined rather than compared delta by delta: the providers chunk
prose differently and the learner cannot see that. The board update is
compared whole, because that is what they can see."
```

---

### Task 10: Probe both models on the board

The schema converter's tests prove the request is well-formed. Only the probes prove the model can still draw with it. This is a judgement call on output, not an assertion, and it is the gate the spec names as its top risk.

**Files:**
- Modify: `server/tests/eval/run_probes.py` if it hard-codes a model
- Test: run, read, decide

- [ ] **Step 1: Check how the probe runner picks a model**

Run: `cd server && grep -n 'model' tests/eval/run_probes.py | head -20`

If the model is hard-coded, add a `--model` argument defaulting to the current value, so a probe run names its model rather than editing the file.

- [ ] **Step 2: Run the probes on both new models**

This step spends real money and needs a real `GEMINI_API_KEY`. It is the repository owner's to run.

```bash
cd server && uv run python tests/eval/run_probes.py --model gemini-3.7-flash
cd server && uv run python tests/eval/run_probes.py --model gemini-3.5-flash-lite
```

- [ ] **Step 3: Read the output against the four questions**

For each model, decide:

1. Does `update_board` come back parseable? A rejected element means `parse_board_update` refused it, and the learner sees a board that did not change.
2. Are the coordinates inside `recommended_tutor_rect`, and is `reserved_learner_work_rect` left clear?
3. Does `math_text` get used for notation, rather than plain `text` or primitives?
4. Does the tutor reach for `view_board` before grading or correcting?

Question 1 is the schema converter's report card. Questions 2 to 4 are the model's, and a weak result there is a prompt problem or a model that is not good enough for this job — not something to fix in the converter.

- [ ] **Step 4: Record the verdict**

Append a short "Probe results" section to the spec at `docs/superpowers/specs/2026-08-16-gemini-provider-design.md`, with the date, the two models, and one line per question. A bad result is a finding, not a failure to hide: if Flash-Lite cannot draw reliably, its caption should say so, or it should not ship.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-gemini-provider-design.md server/tests/eval/run_probes.py
git commit -m "Eval: probe both Gemini models on the board schema

The converter's tests prove the request is well-formed. Only these prove
the model can still draw with a union that lost strict, const and every
numeric bound. Verdict recorded in the spec."
```

---

## Self-Review

**Spec coverage.** Walked each spec section against the tasks:

| Spec section | Task |
|---|---|
| The seam, neutral events, `PROVIDER_FOR_MODEL` | 1, 2 |
| Tool schema translation, invariant test | 3 |
| Round chaining, parts, `system_instruction`, the three rejected parameters | 5 |
| Code-execution inline images | 1 (`ProducedFile`), 5 (`Completed.files`) |
| Pricing, `per_search`, usage mapping, thought tokens not priced twice | 5 (`map_usage`), 6 |
| Device: cases, `supportedEfforts`, clamp, no new row | 8 |
| Server: `gemini_api_key`, `EFFORTS_FOR_MODEL` | 5, 7 |
| Error handling: per-provider `classify`, terminal statuses | 1 (`RetryDecision`, `TERMINAL_ERROR_STATUSES`), 5 |
| Tests: schema invariant, parity, pricing, boot guards, effort pair, device | 3, 6, 7, 8, 9 |
| Board fidelity probes | 10 |

Two gaps found and closed while reviewing:

- The spec's `Completed` carried no output items, but `run_turn` reads `output_items` from `response.completed` to find both the function calls and the container citations. Fixed by putting `calls` and `files` on `Completed`, with `ProducedFile` carrying a `read` closure so the container download hides behind the provider and Gemini's inline bytes fit the same shape.
- The spec never said what happens to `HostedToolStarted`'s item id, which the device keys its step row on and which Gemini supplies differently. Named explicitly in Task 1.

**Placeholder scan.** No TBD or TODO. Two steps are deliberately the owner's rather than an implementer's — recording real fixtures (Task 4 Step 3) and running the probes (Task 10 Step 2) — because both spend money and need a key this session does not hold. Each says so, and each says exactly what to run.

The one genuine unknown is the JSON keys inside `step.delta`. Rather than invent them, Task 4 records a real turn first and Task 5's mapping table names the events by their documented `event_type` values. That is why Task 4 exists as its own task.

**Type consistency.** Checked the names used across tasks: `Provider`, `ToolCall`, `ProducedFile`, `Created`, `TextDelta`, `ThoughtDelta`, `ToolCallStarted`, `ToolArgsDelta`, `ToolArgsDone`, `HostedToolActivity`, `HostedToolStarted`, `Completed`, `Failed`, `RetryDecision`, `TERMINAL_ERROR_STATUSES`, `to_gemini_tools`, `GEMINI_SUPPORTED_KEYWORDS`, `EFFORT_TO_THINKING_LEVEL`, `map_usage`, `PROVIDER_FOR_MODEL`, `EFFORTS_FOR_MODEL`, `supportedEfforts`, `clamp(_:)`, `efforts(for:selected:)`. Each is defined in exactly one task and spelled the same everywhere it is used.

One inconsistency found and fixed: Task 1's `Provider.tool_output` takes a `name` argument that the OpenAI implementation does not use. Left in the shared signature because Gemini's `function_result` requires it, and Task 1 Step 4 now says so rather than leaving a reader to wonder.
