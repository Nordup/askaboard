"""Source-controlled LangSmith evaluation layer for the memory probe suite.

The canonical dataset stays ``probes.yaml`` — the same file ``run_probes.py``
validates and replays through the real close/turn pipeline. This module never
re-implements those rules. It loads the same canonical raw probes, gives each one a
deterministic LangSmith example identity, syncs a ``langsmith-memory-probes``
dataset idempotently, and runs dataset experiments through the real
``run_probe`` pipeline when explicitly asked. Those experiments are offline
evaluations: they run our own probe harness against the dataset and store the
scored compact results in LangSmith. Nothing here calls LangSmith's hosted
model evaluators.

Everything is deterministic and testable without a provider key, a LangSmith
key, or a database:

* ``dry-run`` validates every probe contract, prints a stable manifest plus the
  dataset fingerprint, constructs the exact evaluator payloads, and exits
  nonzero on any contract violation. No network, no keys, no DB.
* ``sync`` upserts examples into LangSmith (explicit ids make repeated syncs
  idempotent); ``--prune`` is required before anything is removed remotely.
* ``evaluate`` runs one sequential dataset experiment through
  ``run_probe``/``run_turn`` with the same model, effort, meter and control
  semantics as ``run_probes.py``, then scores the compact result with the same
  answer/prompt/supersession rules factorised here.

The langsmith SDK is only imported inside the network commands, so the
deterministic commands never touch it.

Dataset schema (LangSmith 0.11.2):

* ``inputs``: ``{"name", "sessions", "question"}``. ``name`` is the canonical
  probe id, ``sessions`` the raw prior-session specs, ``question`` the live
  turn. Raw specs are stored so the dataset fingerprint is independent of the
  machine clock; placeholders are resolved per experiment run.
* ``outputs``: the reference expectations
  ``{"answer_any", "answer_none", "prompt_any", "expect_supersession"}``.
  Missing expectations are simply absent; each deterministic evaluator treats
  an absent expectation as neutral/passing.
* ``id``: UUID5 over ``(dataset name, probe name)`` so reordering examples
  never creates duplicates.
* ``metadata``: ``{"example_id", "schema_version", "content_fingerprint"}``.

Schema version: ``DATASET_SCHEMA_VERSION = 1``. Bump it when an input/output
key, its meaning, or the identity derivation changes, and re-sync with
``--prune`` so stale examples stop being evaluated.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import pathlib
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

#: The LangSmith dataset this layer owns. Do not rename casually: examples are
#: identified by UUID5 over (dataset name, probe name), so renaming the dataset
#: orphans every existing example id.
DATASET_NAME = "langsmith-memory-probes"

PROBES_PATH = pathlib.Path(__file__).parent / "probes.yaml"

#: Stable schema for inputs/outputs/metadata. Bump only on a contract change
#: (key, meaning, or identity derivation), never on cosmetic edits.
DATASET_SCHEMA_VERSION = "1"

#: UUID namespace derived once from the dataset name, so every example id is a
#: stable UUID5 in the namespace instead of mixing two namespaces.
_DATASET_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, DATASET_NAME)

#: Experiment prefix so repeated CI runs are easy to tell apart without
#: overwriting each other's project.
EXPERIMENT_PREFIX = "math-tutor-memory-probes"

#: Sequential by design. The probe harness resets one shared DB schema per
#: probe, so concurrent examples would clobber each other's store.
MAX_CONCURRENCY = 1

#: Keys collected from the probe file without re-implementing matching. Every
#: experiment registers all four evaluators; an absent expectation is scored
#: neutral/passing by design (see the module docstring).
EXPECTATION_KEYS = ("answer_any", "answer_none", "prompt_any", "expect_supersession")

#: Metadata fingerprint keys, in a stable order. Content changes outside these
#: keys (e.g. a placeholder date whose value changes daily) do not count as
#: dataset content; identity is name-based, so this is intentionally narrow.
_FINGERPRINT_KEYS = ("name", "sessions", "question", "answer_any", "answer_none",
                     "prompt_any", "expect_supersession")


class EvalContractError(ValueError):
    """A dataset/example contract violation found by the deterministic checks."""


# --------------------------------------------------------------------------
# Deterministic ids and fingerprints
# --------------------------------------------------------------------------


def example_id(probe_name: str) -> uuid.UUID:
    """Stable UUID5 identity for one probe, independent of file order."""
    return uuid.uuid5(_DATASET_NAMESPACE, probe_name)


def _fingerprint_payload(probe: dict, schema_version: str) -> str:
    parts = [json.dumps(probe.get(key), sort_keys=True, separators=(",", ":"))
             for key in _FINGERPRINT_KEYS]
    parts.append(schema_version)
    return "\n".join(parts)


def content_fingerprint(probe: dict, schema_version: str = DATASET_SCHEMA_VERSION) -> str:
    """Stable content hash for one example; reordering never changes it."""
    return hashlib.sha256(
        _fingerprint_payload(probe, schema_version).encode("utf-8")
    ).hexdigest()


def dataset_manifest(now: datetime) -> "DatasetManifest":
    """All canonical examples plus a deterministic dataset-level fingerprint.

    The raw probe specs (placeholders unresolved) feed the fingerprint and the
    stored inputs, so the manifest is stable across the machine clock.
    Validation still runs through the canonical loader against a fixed clock,
    and placeholders are resolved at experiment execution time.
    """
    # Validate every contract first, with the caller's clock, so a violation
    # exits before any network or experiment work. Keep ``run_probes`` as the
    # single validator instead of maintaining a second copy of its rules here.
    _loader().load_probes(now)
    raw_probes = _raw_probes()
    examples: list[ExampleSpec] = []
    for probe in raw_probes:
        built = build_example(probe)
        examples.append(ExampleSpec(
            probe=probe,
            example_id=built["id"],
            fingerprint=built["metadata"]["content_fingerprint"],
            inputs=built["inputs"],
            outputs=built["outputs"],
            metadata=built["metadata"],
        ))
    aggregate = hashlib.sha256(
        "\n".join(sorted(
            f"{ex.example_id}:{ex.fingerprint}" for ex in examples
        )).encode("utf-8")
    ).hexdigest()
    return DatasetManifest(
        dataset_name=DATASET_NAME,
        schema_version=DATASET_SCHEMA_VERSION,
        aggregate_fingerprint=aggregate,
        examples=examples,
    )


def _raw_probes() -> list[dict]:
    """The canonical probes with placeholders unresolved.

    ``run_probes.load_probes`` validates and resolves placeholders against a
    clock, which is exactly what the manifest must not do: it needs the raw,
    clock-independent specs. The loader is still the source of truth for
    validation; this only reads the same file without substituting dates.
    """
    raw = yaml.safe_load(PROBES_PATH.read_text())
    if not isinstance(raw, list) or not raw:
        raise EvalContractError(f"{PROBES_PATH} does not hold a non-empty list")
    return raw


def _loader():
    """Import the canonical loader lazily (it pulls in the server app).

    Importing this module stays app-free. Validation and experiment commands
    import the real harness only when they are invoked.
    """
    from tests.eval import run_probes as run_probes_mod

    return run_probes_mod


@dataclass
class ExampleSpec:
    """One deterministic LangSmith example built from a validated probe."""

    probe: dict
    example_id: uuid.UUID
    fingerprint: str
    inputs: dict
    outputs: dict
    metadata: dict


@dataclass
class DatasetManifest:
    dataset_name: str
    schema_version: str
    aggregate_fingerprint: str
    examples: list[ExampleSpec]

    def examples_by_name(self) -> dict[str, ExampleSpec]:
        return {ex.probe["name"]: ex for ex in self.examples}


def build_example(probe: dict, schema_version: str = DATASET_SCHEMA_VERSION) -> dict:
    """A plain dict ready for ``Client.create_examples`` (or the dry-run).

    The probe was already validated by ``run_probes.load_probes``; this method
    only rearranges it into the dataset contract.
    """
    outputs = {key: probe[key] for key in EXPECTATION_KEYS if probe.get(key) is not None}
    example = {
        "id": example_id(probe["name"]),
        "inputs": {
            "name": probe["name"],
            "sessions": probe.get("sessions") or [],
            "question": probe["question"],
        },
        "outputs": outputs,
        "metadata": {
            "example_id": probe["name"],
            "schema_version": schema_version,
            "content_fingerprint": content_fingerprint(probe, schema_version),
        },
        "split": "eval",
    }
    return example


def validate_example(example: dict) -> None:
    """Deterministic contract checks, independent of any client or keys."""
    required = {"id", "inputs", "outputs", "metadata"}
    missing = required - set(example)
    if missing:
        raise EvalContractError(
            f"example building dropped {sorted(missing)}; this is a code bug"
        )
    if not isinstance(example["id"], uuid.UUID):
        raise EvalContractError("example id must be a uuid.UUID")
    inputs = example["inputs"]
    if set(inputs) != {"name", "sessions", "question"}:
        raise EvalContractError(
            f"unexpected input keys {sorted(set(inputs) - {'name', 'sessions', 'question'})}"
        )
    if not isinstance(inputs["name"], str) or not inputs["name"]:
        raise EvalContractError("example inputs.name must be a non-empty string")
    if not isinstance(inputs["question"], str) or not inputs["question"]:
        raise EvalContractError("example inputs.question must be a non-empty string")
    metadata = example["metadata"]
    if metadata.get("schema_version") != DATASET_SCHEMA_VERSION:
        raise EvalContractError(
            f"metadata schema_version must be {DATASET_SCHEMA_VERSION!r}, "
            f"got {metadata.get('schema_version')!r}"
        )
    # The canonical loader's validation is the source of truth; these are only
    # cross-checks that the deterministic build preserved the contract.
    if inputs["name"] != metadata.get("example_id"):
        raise EvalContractError("inputs.name must equal metadata.example_id")
    if example.get("split") not in (None, "eval"):
        raise EvalContractError("example split must be 'eval' when set")


def build_evaluator_payloads(manifest: DatasetManifest) -> list[dict[str, Any]]:
    """Construct the exact payloads a dataset experiment would evaluate.

    Used by ``dry-run`` and by the tests so the experiment wiring and its tests
    share one shape. Each entry mirrors what ``aevaluate`` would receive:
    example id, inputs, and reference outputs.
    """
    return [
        {
            "example_id": str(ex.example_id),
            "name": ex.probe["name"],
            "inputs": ex.inputs,
            "reference_outputs": ex.outputs,
        }
        for ex in manifest.examples
    ]


# --------------------------------------------------------------------------
# Evaluators: factorised, deterministic, LangSmith-compatible
# --------------------------------------------------------------------------


def _fold(text: str) -> str:
    # Canonical matcher mirror from run_probes.py: fold typographic
    # apostrophes/dashes/spaces before matching, exactly like the harness.
    return text.translate(str.maketrans({
        "‘": "'", "’": "'", "ʼ": "'",
        "“": '"', "”": '"',
        "–": "-", "—": "-", "−": "-",
        "\u00a0": " ", "\u202f": " ",
    }))


def _pattern(needle: str) -> str:
    folded = _fold(needle)
    escaped = re.escape(folded)
    left = r"(?<!\w)" if folded[:1].isalnum() else ""
    right = r"(?!\w)" if folded[-1:].isalnum() else ""
    return left + escaped + right


def _hits(needles: list[str] | None, haystack: str) -> list[str]:
    folded = _fold(haystack)
    return [n for n in (needles or []) if re.search(_pattern(n), folded, re.IGNORECASE)]


def _placeholders(now: datetime) -> dict[str, str]:
    deadline = (now + timedelta(days=95)).date()
    return {
        "deadline": deadline.strftime("%-d %B %Y"),
        "deadline_month": deadline.strftime("%B"),
        "deadline_iso": deadline.isoformat(),
    }


def _fill_str(value: str, values: dict[str, str]) -> str:
    for key, replacement in values.items():
        value = value.replace("{" + key + "}", replacement)
    return value


def _resolve_reference(reference: dict, now: datetime) -> dict:
    """Resolve date placeholders in evaluator reference expectations."""
    values = _placeholders(now)
    out: dict = {}
    for key, value in reference.items():
        if isinstance(value, str):
            out[key] = _fill_str(value, values)
        elif isinstance(value, list):
            out[key] = [_fill_str(item, values) if isinstance(item, str) else item
                        for item in value]
        else:
            out[key] = value
    return out


def evaluate_answer_any(
    output: str | dict | None,
    reference_outputs: dict | None,
) -> dict[str, bool]:
    """Pass iff the answer contains at least one ``answer_any`` term.

    Missing optional expectations are neutral/passing by design.
    """
    expected = (reference_outputs or {}).get("answer_any")
    answer = output.get("answer") if isinstance(output, dict) else (output or "")
    hits = _hits(expected, answer)
    return {"answer_any_pass": not expected or bool(hits)}


def evaluate_answer_none(
    output: str | dict | None,
    reference_outputs: dict | None,
) -> dict[str, bool]:
    """Pass iff the answer contains none of the ``answer_none`` terms."""
    expected = (reference_outputs or {}).get("answer_none")
    answer = output.get("answer") if isinstance(output, dict) else (output or "")
    leaked = _hits(expected, answer)
    return {"answer_none_pass": bool(leaked) is False}


def evaluate_prompt_any(
    output: str | dict | None,
    reference_outputs: dict | None,
) -> dict[str, bool]:
    """Pass iff at least one ``prompt_any`` term reached the actual prompt."""
    expected = (reference_outputs or {}).get("prompt_any")
    if not expected:
        return {"prompt_any_pass": True}
    prompt = output.get("prompt") if isinstance(output, dict) else ""
    return {"prompt_any_pass": bool(_hits(expected, prompt))}


def evaluate_supersession(
    output: str | dict | None,
    reference_outputs: dict | None,
) -> dict[str, bool]:
    """Pass iff the probe expected supersession and at least one atom closed."""
    expected = (reference_outputs or {}).get("expect_supersession")
    if not expected:
        return {"expect_supersession_pass": True}
    if not isinstance(output, dict):
        return {"expect_supersession_pass": False}
    return {"expect_supersession_pass": bool(output.get("superseded"))}


EVALUATORS: dict[str, Callable[..., dict[str, bool]]] = {
    "answer_any": evaluate_answer_any,
    "answer_none": evaluate_answer_none,
    "prompt_any": evaluate_prompt_any,
    "expect_supersession": evaluate_supersession,
}


def evaluators_for(reference_outputs: dict | None) -> list[str]:
    """Which evaluator keys apply given the reference expectations."""
    expected = reference_outputs or {}
    names: list[str] = []
    if expected.get("answer_any"):
        names.append("answer_any")
    if expected.get("answer_none"):
        names.append("answer_none")
    if expected.get("prompt_any"):
        names.append("prompt_any")
    if expected.get("expect_supersession"):
        names.append("expect_supersession")
    return names


def offline_evaluate(
    output: dict[str, Any],
    reference_outputs: dict | None,
) -> dict[str, bool]:
    """Score one compact result with every registered evaluator.

    Returns flat boolean keys mirroring the online feedback keys (e.g.
    ``expect_supersession_pass``), so offline and online agree.
    """
    out: dict[str, bool] = {}
    for key, fn in EVALUATORS.items():
        result = fn(output, reference_outputs)
        out.update(result)
    return out


# --------------------------------------------------------------------------
# Compact result serialization for the experiment target
# --------------------------------------------------------------------------


def compact_result(result: "Any") -> dict[str, Any]:
    """Serialize one run's result into the compact output the target returns.

    ``result`` is a ``tests.eval.run_probes.Result``; the annotation stays a
    string so this module never imports the app harness at import time. The
    full text (answer and prompt) stays embedded so LangSmith's UI can show
    exactly what was produced; the metrics are denormalized to small keys for
    easy filtering. ``snapshot`` contributes ``live``/``superseded`` counts
    only, so the output stays compact and JSON-safe.
    """
    return {
        "name": result.name,
        "ok": result.ok,
        "seconds": round(result.seconds, 3),
        "answer": result.answer,
        "tools": result.tools,
        "sections_present": [k for k, v in result.sections.items() if v],
        "live": len(result.snapshot.live),
        "superseded": len(result.snapshot.superseded),
        "prompt": result.prompt,
        "reached_prompt": result.reached_prompt,
        "in_store": result.in_store,
        "failures": result.failures,
        "control": result.control,
    }


def _experiment_outputs(reference_outputs: dict, output: dict[str, Any]) -> dict[str, Any]:
    """The subset of the compact result the evaluators actually score."""
    return {
        "answer": output.get("answer", ""),
        "prompt": output.get("prompt", ""),
        "superseded": output.get("superseded", 0),
    }


# --------------------------------------------------------------------------
# LangSmith client wiring (injected, never globally imported)
# --------------------------------------------------------------------------


class _Descriptor:
    """Describe a missing required setting without leaking secrets."""

    def __init__(self, key: str):
        self.key = key

    def reveal(self) -> str:
        return "<set>" if os.environ.get(self.key) else "<unset>"


def _require_settings(keys: list[str]) -> list[str]:
    missing = [key for key in keys if not os.environ.get(key)]
    if missing:
        raise SystemExit(
            "Missing required LangSmith settings: "
            + ", ".join(f"{_Descriptor(k).reveal()} ({k})" for k in missing)
            + ". Set them in server/.env or the environment, then re-run."
        )
    return []


def _load_server_env() -> None:
    """Load ``server/.env`` for explicit network commands only.

    ``dry-run`` returns before this is called, keeping that command independent
    of local credentials. Exported values win over the file, matching the
    existing probe runner and normal one-off CI overrides.
    """
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)


def _command_settings(command: str, model: str | None = None) -> list[str]:
    """Settings a network command must have before creating its client."""
    keys = ["LANGSMITH_API_KEY"]
    if command == "evaluate":
        # The probe rebuild always uses OpenAI for embeddings/extraction, even
        # when the final tutor turn uses another provider.
        keys.extend(["TEST_DATABASE_URL", "OPENAI_API_KEY"])
        if model and model.startswith("gemini"):
            keys.append("GEMINI_API_KEY")
    return keys


def _client_kwargs() -> dict[str, str]:
    kwargs = {"api_key": os.environ["LANGSMITH_API_KEY"]}
    endpoint = os.environ.get("LANGSMITH_ENDPOINT")
    if endpoint:
        kwargs["api_url"] = endpoint
    workspace = os.environ.get("LANGSMITH_WORKSPACE_ID")
    if workspace:
        kwargs["workspace_id"] = workspace
    return kwargs


def ensure_dataset(client: Any, manifest: DatasetManifest) -> dict:
    """Create/read the dataset and upsert the deterministic examples.

    LangSmith 0.11.2 treats ``create_examples`` as create-only, so the sync
    reads the remote ids first, creates missing examples, and updates matching
    examples in place. Examples removed from ``probes.yaml`` remain untouched
    unless the caller explicitly requests pruning.
    """
    if not hasattr(client, "has_dataset") or not hasattr(client, "create_dataset"):
        raise EvalContractError(
            "injected client lacks has_dataset/create_dataset; expected "
            "langsmith.Client"
        )
    dataset = None
    if client.has_dataset(dataset_name=manifest.dataset_name):
        dataset = client.read_dataset(dataset_name=manifest.dataset_name)
    else:
        dataset = client.create_dataset(
            dataset_name=manifest.dataset_name,
            description=(
                "Deterministic memory-probe dataset built from "
                "server/tests/eval/probes.yaml. "
                f"schema_version={manifest.schema_version}; "
                f"aggregate_fingerprint={manifest.aggregate_fingerprint}."
            ),
            metadata={
                "source": "server/tests/eval/probes.yaml",
                "schema_version": manifest.schema_version,
                "aggregate_fingerprint": manifest.aggregate_fingerprint,
            },
        )

    dataset_id = getattr(dataset, "id", None) or dataset.get("id")
    examples = [
        {
            "id": ex.example_id,
            "inputs": ex.inputs,
            "outputs": ex.outputs,
            "metadata": ex.metadata,
            "split": "eval",
        }
        for ex in manifest.examples
    ]
    remote_ids = {
        str(example.id) for example in client.list_examples(dataset_id=dataset_id)
    }
    creates = [example for example in examples if str(example["id"]) not in remote_ids]
    updates = [example for example in examples if str(example["id"]) in remote_ids]
    responses: dict[str, Any] = {}
    if creates:
        responses["created"] = client.create_examples(
            dataset_id=dataset_id,
            examples=creates,
            max_concurrency=1,
        )
    if updates:
        responses["updated"] = client.update_examples(
            dataset_id=dataset_id,
            updates=updates,
        )
    return {"dataset_id": str(dataset_id), "response": responses}


def prune_remote_examples(client: Any, manifest: DatasetManifest) -> int:
    """Explicitly delete remote examples no longer in the manifest."""
    dataset = client.read_dataset(dataset_name=manifest.dataset_name)
    if hasattr(dataset, "id"):
        dataset_id = dataset.id
    else:
        dataset_id = dataset.get("id")  # type: ignore[union-attr]
    remote = list(client.list_examples(dataset_id=dataset_id))
    wanted = {ex.example_id for ex in manifest.examples}
    removed = 0
    for example in remote:
        if example.id not in wanted:
            client.delete_example(example_id=example.id)
            removed += 1
    return removed


# --------------------------------------------------------------------------
# Dataset experiment (offline evaluation)
# --------------------------------------------------------------------------


def build_target(
    *,
    model: str,
    effort: str,
    now: datetime,
    manifest: DatasetManifest | None = None,
) -> Callable[[dict], Any]:
    """Build the sequential target function ``aevaluate`` will call per example.

    ``manifest`` supplies the full resolved probe spec by name, so
    ``run_probe`` receives the reference contract (answer/prompt/supersession
    expectations) and not just the dataset inputs. Each call opens its own
    throwaway schema, replays the probe's sessions, asks the live question, and
    returns the compact result. ``max_concurrency=1`` is enforced by the caller
    so examples never share a schema.

    The returned function is intentionally not decorated with langsmith's
    ``@traceable``: when tracing is enabled, ``aevaluate`` already wraps the
    target in one root span per example, and decorating would double-wrap.
    """
    specs = None
    if manifest is not None:
        # Resolve placeholders against the experiment clock, exactly like the
        # canonical loader does, so `run_probe` sees the same spec it runs
        # locally.
        probes = _loader()
        specs = {
            ex.probe["name"]: probes._fill(ex.probe, probes.placeholders(now))
            for ex in manifest.examples
        }

    async def run_example(inputs: dict) -> dict:
        probe_name = inputs.get("name")
        if not probe_name:
            raise EvalContractError("target inputs missing probe name")
        if specs is None:
            # No manifest: fall back to the dataset inputs (only the probe
            # identity and question are available; reference contract absent).
            probe = {**inputs, "question": inputs.get("question", "")}
        else:
            probe = specs.get(probe_name)
            if probe is None:
                raise EvalContractError(
                    f"target cannot resolve probe spec {probe_name!r} from manifest"
                )
        probes = _loader()
        meter = probes.Meter()
        store = await probes.open_store()
        try:
            result = await probes.run_probe(
                store, probe, model=model, effort=effort, meter=meter, now=now,
            )
        finally:
            await probes.close_store(store)
        return compact_result(result)

    return run_example


async def run_experiment(
    *,
    client: Any,
    manifest: DatasetManifest,
    target: Callable[[dict], Any] | None = None,
    metadata: dict[str, Any] | None = None,
    project_hint: str | None = None,
    now: datetime | None = None,
) -> Any:
    """Run a dataset experiment with the deterministic evaluators, sequentially.

    ``client`` is injected so tests can use fakes. ``target`` defaults to the
    real probe-harness target built from this manifest so the reference
    contract reaches ``run_probe``. ``project_hint`` is a keyword-only hint
    used to make UI URLs clearer; it is only used to set experiment metadata,
    never to switch projects.
    """
    from langsmith.evaluation import run_evaluator
    experiment_now = now or datetime.now(timezone.utc)

    if target is None:
        probes = _loader()
        target = build_target(
            model=probes.PROBE_MODEL,
            effort=probes.PROBE_EFFORT,
            now=experiment_now,
            manifest=manifest,
        )

    def evaluator(key: str, inputs: dict, outputs: dict, reference_outputs: dict):
        return {
            "key": f"probe_{key}",
            "score": bool(EVALUATORS[key](outputs, reference_outputs)[f"{key}_pass"]),
            "comment": (
                f"probe={inputs.get('name')!r} {key}="
                f"{EVALUATORS[key](outputs, reference_outputs)[f'{key}_pass']}"
            ),
        }

    def closure(key: str):
        def score(run, example) -> dict:
            raw_ref = {
                k: example.outputs.get(k)
                for k in EXPECTATION_KEYS
                if example.outputs.get(k) is not None
            }
            ref = _resolve_reference(raw_ref, experiment_now)
            scorable = _experiment_outputs(ref, run.outputs or {})
            return evaluator(key, example.inputs or {}, scorable, ref)
        return run_evaluator(score)

    evaluator_fns = [closure(key) for key in EVALUATORS]
    return await client.aevaluate(
        target,
        data=manifest.dataset_name,
        evaluators=evaluator_fns,
        metadata={
            **(metadata or {}),
            "dataset": manifest.dataset_name,
            "schema_version": manifest.schema_version,
            "aggregate_fingerprint": manifest.aggregate_fingerprint,
            "project_hint": project_hint or "",
        },
        experiment_prefix=EXPERIMENT_PREFIX,
        max_concurrency=MAX_CONCURRENCY,
        blocking=True,
    )


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _print_manifest(manifest: DatasetManifest, payloads: list[dict[str, Any]]) -> None:
    print(f"dataset: {manifest.dataset_name}")
    print(f"schema: {manifest.schema_version}")
    print(f"aggregate fingerprint: {manifest.aggregate_fingerprint}")
    print(f"examples: {len(manifest.examples)}")
    for ex in manifest.examples:
        print(
            f"  {ex.example_id}  {ex.probe['name']}  "
            f"fingerprint={ex.fingerprint[:12]}"
        )
    print("evaluator payloads:")
    for payload in payloads:
        print(f"  {payload['name']}: {evaluators_for(payload['reference_outputs'])}")


def main(argv: list[str] | None = None) -> int:
    # Deterministic commands must not accidentally prompt or use a key.
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    dry = sub.add_parser(
        "dry-run",
        help="validate every probe, print the deterministic manifest, and exit "
             "nonzero on contract violations. Requires no keys and no network.",
    )
    dry.add_argument(
        "--now",
        help="ISO timestamp for placeholder resolution (defaults to now UTC).",
    )

    sync = sub.add_parser(
        "sync",
        help="upsert the deterministic examples into LangSmith.",
    )
    sync.add_argument(
        "--prune",
        action="store_true",
        help="also delete remote examples no longer present. Explicitly "
             "required; never implied.",
    )
    sync.add_argument(
        "--now",
        help="ISO timestamp for placeholder resolution (defaults to now UTC).",
    )

    evaluate = sub.add_parser(
        "evaluate",
        help="run one sequential dataset experiment through run_probe/run_turn.",
    )
    evaluate.add_argument(
        "--model",
        default=None,
        help="model for the probe turn (default from run_probes.PROBE_MODEL)",
    )
    evaluate.add_argument(
        "--effort",
        default=None,
        choices=("low", "medium", "high"),
        help="reasoning effort (default from run_probes.PROBE_EFFORT)",
    )
    evaluate.add_argument(
        "--now",
        help="ISO timestamp for placeholder resolution (defaults to now UTC).",
    )

    args = parser.parse_args(argv)
    now = (
        datetime.fromisoformat(args.now)
        if getattr(args, "now", None)
        else datetime.now(timezone.utc)
    )

    if args.command == "dry-run":
        manifest = dataset_manifest(now)
        payloads = build_evaluator_payloads(manifest)
        for payload in payloads:
            probe = {
                "name": payload["name"],
                "sessions": payload["inputs"].get("sessions", []),
                "question": payload["inputs"]["question"],
                **payload["reference_outputs"],
            }
            validate_example(build_example(probe))
        _print_manifest(manifest, payloads)
        return 0

    _load_server_env()
    probes = _loader() if args.command == "evaluate" else None
    selected_model = None
    if probes is not None:
        selected_model = args.model or probes.PROBE_MODEL
    _require_settings(_command_settings(args.command, selected_model))
    manifest = dataset_manifest(now)
    from langsmith import Client

    client = Client(**_client_kwargs())

    if args.command == "sync":
        try:
            result = ensure_dataset(client, manifest)
            pruned = 0
            if args.prune:
                pruned = prune_remote_examples(client, manifest)
            print(f"synced {len(manifest.examples)} examples into "
                  f"{manifest.dataset_name} (dataset id {result['dataset_id']})")
            if args.prune:
                print(f"pruned {pruned} remote examples no longer in probes.yaml")
            print(f"aggregate fingerprint: {manifest.aggregate_fingerprint}")
            return 0
        finally:
            client.close(timeout=2.0)

    if args.command == "evaluate":
        assert probes is not None and selected_model is not None
        model = selected_model
        effort = args.effort or probes.PROBE_EFFORT
        try:
            return asyncio.run(_run_evaluate_command(
                client=client,
                manifest=manifest,
                model=model,
                effort=effort,
                now=now,
            ))
        finally:
            client.close(timeout=2.0)

    return 2


async def _run_evaluate_command(
    *,
    client: Any,
    manifest: DatasetManifest,
    model: str,
    effort: str,
    now: datetime,
) -> int:
    """Run the dataset experiment and return 0/1 based on real scored rows."""
    target = build_target(model=model, effort=effort, now=now, manifest=manifest)
    result = await run_experiment(
        client=client,
        manifest=manifest,
        target=target,
        metadata={"command": "evaluate"},
        project_hint=EXPERIMENT_PREFIX,
        now=now,
    )
    name = getattr(result, "experiment_name", None) or str(result)
    url = getattr(result, "url", None)
    print(f"experiment: {name}")
    if url:
        print(f"url: {url}")

    # Real AsyncExperimentResults is async-iterable only; fakes may be
    # synchronously iterable.
    rows = []
    try:
        async for row in result:
            rows.append(row)
    except TypeError:
        rows = list(result)
    failures: list[str] = []
    false_scores = 0
    scored_results = 0
    for row in rows:
        run = row.get("run")
        outputs = getattr(run, "outputs", None) or {}
        if outputs.get("failures"):
            failures.extend(outputs["failures"])
        evaluation_results = row.get("evaluation_results") or {}
        for eval_result in evaluation_results.get("results", []):
            score = getattr(eval_result, "score", None)
            if score is None and isinstance(eval_result, dict):
                score = eval_result.get("score")
            if score is None:
                continue
            scored_results += 1
            if not bool(score):
                false_scores += 1
    expected_rows = len(manifest.examples)
    expected_scores = len(rows) * len(EVALUATORS)
    if len(rows) != expected_rows:
        failures.append(
            f"expected {expected_rows} experiment row(s), received {len(rows)}"
        )
    if scored_results != expected_scores:
        failures.append(
            f"expected {expected_scores} evaluator score(s), received "
            f"{scored_results}"
        )
    print(f"evaluated {len(rows)} examples on {manifest.dataset_name}")
    if false_scores:
        print(f"{false_scores} deterministic feedback score(s) were false")
    if failures:
        print("target failures:")
        for failure in failures:
            print(f"  {failure}")
    return 1 if (false_scores or failures) else 0


if __name__ == "__main__":
    raise SystemExit(main())
