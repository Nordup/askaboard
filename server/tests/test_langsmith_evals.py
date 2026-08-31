"""Deterministic, no-network tests for the LangSmith probe-eval layer.

Everything here uses fake clients and pure functions; no provider key, no
LangSmith key, no database. The real ``run_probe`` pipeline itself is not
invoked (it would need a database and a key); the wiring is tested through a
stubbed target that records the concurrency and the evaluator payloads.
"""

from __future__ import annotations

import inspect
import json
import uuid
from datetime import datetime, timezone

import pytest

from tests.eval import langsmith_eval as le


def _now() -> datetime:
    return datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)


def _probe(**overrides) -> dict:
    base = {
        "name": "recalls_a_stated_preference",
        "sessions": [
            {
                "days_ago": 21,
                "transcript": (
                    "learner: before we start, I really need to see the picture "
                    "before the algebra\n"
                    "tutor: noted, I'll lead with diagrams\n"
                    "learner: symbols first never works for me, I just lose track\n"
                    "tutor: then we draw it first every time\n"
                    "learner: yes please, that's how my old teacher did it\n"
                ),
            }
        ],
        "question": "teach me about completing the square",
        "answer_any": ["diagram", "picture", "visual"],
        "prompt_any": ["diagram", "picture"],
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------------
# Manifest stability, ids, fingerprints
# --------------------------------------------------------------------------


class TestManifest:
    def test_deterministic_manifest_stability(self):
        a = le.dataset_manifest(_now())
        b = le.dataset_manifest(_now())
        assert a.aggregate_fingerprint == b.aggregate_fingerprint
        assert [e.example_id for e in a.examples] == [e.example_id for e in b.examples]
        assert [e.probe["name"] for e in a.examples] == [
            e.probe["name"] for e in b.examples
        ]
        assert len(a.examples) == 6
        assert {e.probe["name"] for e in a.examples} == {
            "recalls_a_stated_preference",
            "recalls_a_goal_with_a_deadline",
            "supersedes_stale_skill_state",
            "does_not_invent_memories",
            "recalls_what_we_did_last_time",
            "recalls_an_older_fact_after_a_later_session",
        }

    def test_reordering_probes_does_not_change_identity_or_aggregate(
        self, monkeypatch,
    ):
        manifest = le.dataset_manifest(_now())
        raw = le._raw_probes()
        monkeypatch.setattr(le, "_raw_probes", lambda: list(reversed(raw)))
        reversed_manifest = le.dataset_manifest(_now())
        assert {
            e.probe["name"]: e.example_id for e in manifest.examples
        } == {
            e.probe["name"]: e.example_id for e in reversed_manifest.examples
        }
        assert (
            manifest.aggregate_fingerprint
            == reversed_manifest.aggregate_fingerprint
        )

    def test_uuid5_identity_is_name_based(self):
        name = "recalls_a_goal_with_a_deadline"
        assert le.example_id(name) == uuid.uuid5(le._DATASET_NAMESPACE, name)
        assert le.example_id("recalls_a_goal_with_a_deadline") == le.example_id(
            "recalls_a_goal_with_a_deadline"
        )
        assert le.example_id("recalls_a_stated_preference") != le.example_id(
            "recalls_a_goal_with_a_deadline"
        )

    def test_fingerprint_is_content_stable_and_ignores_order(self):
        probe = _probe()
        f1 = le.content_fingerprint(probe)
        f2 = le.content_fingerprint(_probe())
        assert f1 == f2
        # Schema version is part of the fingerprint.
        assert le.content_fingerprint(probe, "2") != f1
        different = dict(probe, question="a different question")
        assert le.content_fingerprint(different) != f1

    def test_manifest_is_clock_independent(self):
        later = datetime(2026, 12, 31, 23, 59, tzinfo=timezone.utc)
        a = le.dataset_manifest(_now())
        b = le.dataset_manifest(later)
        assert a.aggregate_fingerprint == b.aggregate_fingerprint
        assert [e.fingerprint for e in a.examples] == [
            e.fingerprint for e in b.examples
        ]
        # Stored inputs keep the raw placeholder, not the resolved date.
        goal = next(e for e in a.examples if e.probe["name"] == "recalls_a_goal_with_a_deadline")
        transcript = "\n".join(
            spec["transcript"] for spec in goal.inputs["sessions"]
        )
        assert "2026-11-12" not in transcript
        assert "{deadline}" in transcript

    def test_build_example_contract(self):
        example = le.build_example(_probe())
        le.validate_example(example)
        assert example["id"] == le.example_id("recalls_a_stated_preference")
        assert example["inputs"]["name"] == "recalls_a_stated_preference"
        assert example["inputs"]["sessions"][0]["days_ago"] == 21
        assert example["inputs"]["question"] == "teach me about completing the square"
        assert example["outputs"]["answer_any"] == ["diagram", "picture", "visual"]
        assert "answer_none" not in example["outputs"]
        assert example["metadata"]["schema_version"] == "1"
        assert example["metadata"]["example_id"] == "recalls_a_stated_preference"
        assert example["metadata"]["content_fingerprint"] == le.content_fingerprint(
            _probe()
        )

    def test_build_example_omits_missing_expectations(self):
        example = le.build_example(_probe(answer_any=None, expect_supersession=True))
        assert "answer_any" not in example["outputs"]
        assert example["outputs"]["expect_supersession"] is True


# --------------------------------------------------------------------------
# Upsert payload and idempotent sync
# --------------------------------------------------------------------------


class FakeClient:
    """A minimal fake of the langsmith.Client surface used by this layer."""

    def __init__(self):
        self.datasets = {}
        self.examples = []
        self.created = []
        self.deleted = []
        self.has_calls = []
        self.read_calls = []
        self.create_calls = []
        self.update_calls = []
        self.aevaluate_calls = []

    def has_dataset(self, *, dataset_name=None):
        self.has_calls.append(dataset_name)
        return dataset_name in self.datasets

    def read_dataset(self, *, dataset_name=None):
        self.read_calls.append(dataset_name)
        return self.datasets.get(dataset_name)

    def create_dataset(self, dataset_name, **kwargs):
        ds = {"id": uuid.uuid4(), "name": dataset_name, "metadata": kwargs.get("metadata")}
        self.datasets[dataset_name] = ds
        return ds

    def create_examples(self, *, dataset_name=None, dataset_id=None, examples=None, **kwargs):
        self.create_calls.append({
            "dataset_name": dataset_name,
            "dataset_id": dataset_id,
            "examples": examples,
        })
        by_id = {e.id: e for e in self.examples}
        for ex in examples:
            if ex["id"] in by_id:
                raise RuntimeError("create_examples is create-only")
            by_id[ex["id"]] = FakeExample(**ex)
        self.examples = list(by_id.values())
        return {"count": len(examples), "example_ids": [str(e["id"]) for e in examples]}

    def update_examples(self, *, dataset_id=None, updates=None, **kwargs):
        self.update_calls.append({"dataset_id": dataset_id, "updates": updates})
        by_id = {e.id: e for e in self.examples}
        for update in updates:
            if update["id"] not in by_id:
                raise RuntimeError("cannot update a missing example")
            by_id[update["id"]] = FakeExample(**update)
        self.examples = list(by_id.values())
        return {"count": len(updates), "example_ids": [str(e["id"]) for e in updates]}

    def list_examples(self, dataset_id=None, **kwargs):
        return list(self.examples)

    def delete_example(self, example_id=None):
        self.deleted.append(example_id)
        self.examples = [e for e in self.examples if e.id != example_id]

    async def aevaluate(self, target, data=None, evaluators=None, **kwargs):
        self.aevaluate_calls.append({**kwargs, "data": data, "evaluators": evaluators})
        rows = await self._run_all(target, evaluators or [])
        return FakeResults(rows)

    async def _run_all(self, target, evaluators):
        rows = []
        for ex in self.examples:
            outputs = await target(dict(ex.inputs))
            evaluation = {"results": []}
            for evaluator in evaluators:
                result = evaluator.evaluate_run(
                    run=FakeRun(outputs=outputs),
                    example=FakeExample(
                        id=ex.id,
                        inputs=ex.inputs,
                        outputs=ex.outputs,
                        metadata=ex.metadata,
                    ),
                )
                if inspect.isawaitable(result):
                    result = await result
                results_list = result.results if hasattr(result, "results") else (
                    [result] if hasattr(result, "score") else []
                )
                evaluation["results"].extend(results_list)
            rows.append({
                "run": FakeRun(outputs=outputs),
                "example": FakeExample(
                    id=ex.id,
                    inputs=ex.inputs,
                    outputs=ex.outputs,
                    metadata=ex.metadata,
                ),
                "evaluation_results": evaluation,
            })
        return rows


class FakeExample:
    def __init__(self, id=None, inputs=None, outputs=None, metadata=None, **kwargs):
        self.id = id
        self.inputs = inputs or {}
        self.outputs = outputs or {}
        self.metadata = metadata or {}


class FakeRun:
    def __init__(self, outputs=None, run_id=None):
        self.id = run_id or uuid.uuid4()
        self.session_id = None
        self.outputs = outputs or {}


class FakeResults:
    def __init__(self, rows):
        self.rows = rows
        self.experiment_name = "experiment-fake"
        self.url = "https://smith.example/experiments/fake"

    def __iter__(self):
        return iter(self.rows)

    def __aiter__(self):
        return self._aiter()

    async def _aiter(self):
        for row in self.rows:
            yield row


class FakeEvalResult:
    def __init__(self, score=True):
        self.score = score


class FakeEvalResults:
    def __init__(self, rows, scores=None):
        self.rows = rows
        self.scores = scores or [True] * len(rows)
        self.experiment_name = "experiment-fake"
        self.url = "https://smith.example/experiments/fake"

    def __iter__(self):
        for i, row in enumerate(self.rows):
            row = dict(row)
            score = self.scores[i] if i < len(self.scores) else True
            row["evaluation_results"] = {
                "results": [
                    FakeEvalResult(score=score) for _ in le.EVALUATORS
                ]
            }
            yield row

    def __aiter__(self):
        return self._aiter()

    async def _aiter(self):
        for row in self:
            yield row


class TestSync:
    def test_upsert_payload_shape(self):
        manifest = le.dataset_manifest(_now())
        payload = le.build_evaluator_payloads(manifest)[0]
        assert set(payload["inputs"]) == {"name", "sessions", "question"}
        assert "reference_outputs" in payload
        assert payload["example_id"] == str(
            le.example_id("recalls_a_stated_preference")
        )
        example = le.build_example(manifest.examples[0].probe)
        assert example["inputs"]["name"] == payload["inputs"]["name"]
        assert example["outputs"] == payload["reference_outputs"]

    def test_sync_creates_dataset_and_examples(self):
        client = FakeClient()
        manifest = le.dataset_manifest(_now())
        result = le.ensure_dataset(client, manifest)
        assert result["dataset_id"]
        assert len(client.examples) == 6
        client_ids = {e.id for e in client.examples}
        assert client_ids == {e.example_id for e in manifest.examples}
        assert len(client.create_calls) == 1
        assert client.create_calls[0]["dataset_id"] == uuid.UUID(result["dataset_id"])
        assert client.update_calls == []

    def test_dataset_creation_does_not_pass_string_data_type(self):
        class SDKCompatibleClient(FakeClient):
            def create_dataset(self, dataset_name, **kwargs):
                # LangSmith 0.11.2 expects schemas.DataType, not a raw string.
                assert not isinstance(kwargs.get("data_type"), str)
                return super().create_dataset(dataset_name, **kwargs)

        client = SDKCompatibleClient()
        le.ensure_dataset(client, le.dataset_manifest(_now()))
        assert le.DATASET_NAME in client.datasets

    def test_sync_is_idempotent_on_repeat(self):
        client = FakeClient()
        manifest = le.dataset_manifest(_now())
        le.ensure_dataset(client, manifest)
        le.ensure_dataset(client, manifest)
        assert len(client.examples) == 6
        assert len(client.create_calls) == 1
        assert len(client.update_calls) == 1
        assert len(client.update_calls[0]["updates"]) == 6
        assert len(client.examples) == 6

    def test_sync_without_prune_keeps_remote_stale_examples(self):
        client = FakeClient()
        manifest = le.dataset_manifest(_now())
        le.ensure_dataset(client, manifest)
        stale = {"id": uuid.uuid4(), "inputs": {"name": "removed"}, "outputs": {},
                "metadata": {"example_id": "removed"}}
        client.examples.append(FakeExample(**stale))
        le.ensure_dataset(client, manifest)
        assert any(e.metadata.get("example_id") == "removed" for e in client.examples)
        assert client.deleted == []

    def test_prune_requires_explicit_flag(self):
        client = FakeClient()
        manifest = le.dataset_manifest(_now())
        le.ensure_dataset(client, manifest)
        stale = {"id": uuid.uuid4(), "inputs": {"name": "removed"}, "outputs": {},
                "metadata": {"example_id": "removed"}}
        client.examples.append(FakeExample(**stale))
        removed = le.prune_remote_examples(client, manifest)
        assert removed == 1
        assert any(e.metadata.get("example_id") == "removed" for e in client.examples) is False

    def test_evaluator_payloads_cover_all_expected_roles(self):
        manifest = le.dataset_manifest(_now())
        payloads = le.build_evaluator_payloads(manifest)
        by_name = {p["name"]: p for p in payloads}
        assert le.evaluators_for(by_name["supersedes_stale_skill_state"]["reference_outputs"]) == [
            "answer_none",
            "expect_supersession",
        ]
        assert le.evaluators_for(by_name["recalls_a_goal_with_a_deadline"]["reference_outputs"]) == [
            "prompt_any"
        ]

    def test_supersession_evaluator_is_registered(self):
        assert "expect_supersession" in le.EVALUATORS
        assert set(le.EVALUATORS) == {
            "answer_any",
            "answer_none",
            "prompt_any",
            "expect_supersession",
        }


# --------------------------------------------------------------------------
# Evaluators
# --------------------------------------------------------------------------


class TestEvaluators:
    def test_answer_any_pass_and_fail(self):
        ref = {"answer_any": ["diagram", "picture"]}
        assert le.evaluate_answer_any("I will draw a diagram", ref) == {
            "answer_any_pass": True
        }
        assert le.evaluate_answer_any("Let's just talk numbers", ref) == {
            "answer_any_pass": False
        }

    def test_answer_any_neutral_when_absent(self):
        assert le.evaluate_answer_any("anything at all", None) == {
            "answer_any_pass": True
        }
        assert le.evaluate_answer_any("anything at all", {}) == {
            "answer_any_pass": True
        }

    def test_answer_none_fail_on_leak(self):
        ref = {"answer_none": ["you struggle", "you find it hard"]}
        assert le.evaluate_answer_none("You struggle with the signs", ref) == {
            "answer_none_pass": False
        }
        assert le.evaluate_answer_none("You cracked it this week", ref) == {
            "answer_none_pass": True
        }

    def test_answer_none_neutral_when_absent(self):
        assert le.evaluate_answer_none("fine", None) == {"answer_none_pass": True}

    def test_prompt_any_matches_the_prompt(self):
        ref = {"prompt_any": ["Sunday", "Sundays"]}
        assert le.evaluate_prompt_any(
            {"prompt": "We planned Sunday evenings together", "answer": "no"},
            ref,
        ) == {"prompt_any_pass": True}
        assert le.evaluate_prompt_any(
            {"prompt": "We planned weekday evenings", "answer": "no"},
            ref,
        ) == {"prompt_any_pass": False}

    def test_prompt_any_neutral_when_absent(self):
        assert le.evaluate_prompt_any("anything", None) == {"prompt_any_pass": True}

    def test_supersession(self):
        ref = {"expect_supersession": True}
        assert le.evaluate_supersession({"superseded": 2}, ref) == {
            "expect_supersession_pass": True
        }
        assert le.evaluate_supersession({"superseded": 0}, ref) == {
            "expect_supersession_pass": False
        }
        assert le.evaluate_supersession("not a dict", ref) == {
            "expect_supersession_pass": False
        }

    def test_supersession_neutral_when_not_expected(self):
        assert le.evaluate_supersession({}, None) == {"expect_supersession_pass": True}

    def test_offline_evaluate_uses_reference_and_outputs(self):
        output = {
            "answer": "Let's draw a picture",
            "prompt": "the portrait mentioned a picture",
            "superseded": 1,
        }
        ref = {
            "answer_any": ["picture"],
            "answer_none": ["struggle"],
            "prompt_any": ["picture"],
            "expect_supersession": True,
        }
        assert le.offline_evaluate(output, ref) == {
            "answer_any_pass": True,
            "answer_none_pass": True,
            "prompt_any_pass": True,
            "expect_supersession_pass": True,
        }

    def test_folding_apostrophes_matches_run_probes(self):
        ref = {"answer_any": ["haven't"]}
        assert le.evaluate_answer_any("I haven’t seen it", ref) == {
            "answer_any_pass": True
        }

    def test_word_boundaries_do_not_overmatch(self):
        ref = {"answer_none": ["not"]}
        assert le.evaluate_answer_none("nothing to report", ref) == {
            "answer_none_pass": True
        }


# --------------------------------------------------------------------------
# Result serialization and compact outputs
# --------------------------------------------------------------------------


def _result() -> "probes.Result":
    from tests.eval import run_probes as probes

    return probes.Result(
        name="recalls_a_stated_preference",
        ok=True,
        seconds=2.5,
        answer="I will draw a diagram first",
        prompt="the system prompt showed the learner prefers diagrams",
        snapshot=probes.Snapshot(
            profile="learner prefers diagrams",
            live=[("preference", "learner wants pictures first")],
            superseded=[("skill", "old fact")],
            digests="today: learner prefers diagrams",
        ),
        tools=["search_memory"],
        sections={"profile": True},
        failures=[],
        reached_prompt=True,
        in_store=True,
    )


class TestSerialization:
    def test_compact_result_is_json_safe_and_small(self):
        compact = le.compact_result(_result())
        json.dumps(compact)
        assert compact["ok"] is True
        assert compact["live"] == 1
        assert compact["superseded"] == 1
        assert compact["answer"] == "I will draw a diagram first"
        assert compact["prompt"] == "the system prompt showed the learner prefers diagrams"

    def test_experiment_outputs_are_scorable_subset(self):
        compact = le.compact_result(_result())
        ref = {"answer_any": ["diagram"], "prompt_any": ["today"]}
        scorable = le._experiment_outputs(ref, compact)
        assert scorable["answer"] == compact["answer"]
        assert scorable["prompt"] == compact["prompt"]
        assert scorable["superseded"] == compact["superseded"]

    def test_compact_result_scores_prompt_shown_not_digests(self):
        from tests.eval import run_probes as probes

        result = probes.Result(
            name="recalls_a_stated_preference",
            ok=True,
            seconds=0.1,
            answer="yes",
            prompt="the real prompt mentioned diagrams",
            snapshot=probes.Snapshot(
                profile="",
                live=[],
                superseded=[],
                digests="digests do not mention diagrams",
            ),
            tools=[],
            sections={},
            failures=[],
            reached_prompt=True,
            in_store=True,
        )
        compact = le.compact_result(result)
        assert compact["prompt"] == "the real prompt mentioned diagrams"
        assert "digests do not mention diagrams" not in compact["prompt"]


# --------------------------------------------------------------------------
# CLI dry-run
# --------------------------------------------------------------------------


class TestDryRun:
    def test_dry_run_requires_no_keys(self, monkeypatch):
        monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
        code = le.main(["dry-run", "--now", "2026-08-31T12:00:00+00:00"])
        assert code == 0

    def test_dry_run_validates_every_example(self, capsys):
        code = le.main(["dry-run", "--now", "2026-08-31T12:00:00+00:00"])
        out = capsys.readouterr().out
        assert code == 0
        assert "dataset: langsmith-memory-probes" in out
        assert "examples: 6" in out
        assert "aggregate fingerprint:" in out
        assert "recalls_a_stated_preference: ['answer_any', 'prompt_any']" in out

    def test_dry_run_manifest_is_clock_independent(self, capsys):
        later = datetime(2027, 3, 1, 0, 0, tzinfo=timezone.utc)
        le.main(["dry-run", "--now", later.isoformat()])
        later_out = capsys.readouterr().out
        le.main(["dry-run", "--now", _now().isoformat()])
        now_out = capsys.readouterr().out
        assert later_out == now_out

    def test_required_settings_error_never_reveals_value(self, monkeypatch, capsys):
        monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_super_secret_abcdef")
        monkeypatch.delenv("LANGSMITH_ENDPOINT", raising=False)
        with pytest.raises(SystemExit) as exc:
            # sync/evaluate require the key; only dry-run is deterministic.
            le._require_settings(["LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT"])
        message = str(exc.value)
        # The key is set, so it appears only as <set>; the endpoint is unset.
        assert "lsv2" not in message
        assert "abcdef" not in message

    def test_network_commands_load_server_dotenv_without_overriding_exports(
        self, monkeypatch, tmp_path,
    ):
        (tmp_path / ".env").write_text(
            "LANGSMITH_API_KEY=from-file\nLANGSMITH_PROJECT=from-file\n"
        )
        monkeypatch.setattr(le, "ROOT", tmp_path)
        monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
        monkeypatch.setenv("LANGSMITH_PROJECT", "exported")
        le._load_server_env()
        assert le.os.environ["LANGSMITH_API_KEY"] == "from-file"
        assert le.os.environ["LANGSMITH_PROJECT"] == "exported"

    def test_live_command_requirements_are_checked_up_front(self):
        assert le._command_settings("sync") == ["LANGSMITH_API_KEY"]
        assert le._command_settings("evaluate", "gpt-5.6-luna") == [
            "LANGSMITH_API_KEY", "TEST_DATABASE_URL", "OPENAI_API_KEY",
        ]
        assert le._command_settings("evaluate", "gemini-3.5-flash-lite") == [
            "LANGSMITH_API_KEY", "TEST_DATABASE_URL", "OPENAI_API_KEY",
            "GEMINI_API_KEY",
        ]


# --------------------------------------------------------------------------
# Experiment wiring (fake client, sequential concurrency)
# --------------------------------------------------------------------------


class TestExperiment:
    async def _collect_command(
        self,
        *,
        rows,
        scores=None,
        manifest=None,
        target=None,
    ):
        """Drive `_run_evaluate_command` with a fake client/result."""
        client = FakeClient()
        fake = FakeEvalResults(rows, scores=scores)

        async def fake_aevaluate(*args, **kwargs):
            return fake

        client.aevaluate = fake_aevaluate
        return await le._run_evaluate_command(
            client=client,
            manifest=manifest or le.dataset_manifest(_now()),
            model="gpt-test",
            effort="low",
            now=_now(),
        )

    async def _practice_manifest(self):
        probe = _probe()
        preview = le.build_example(probe)
        return le.DatasetManifest(
            dataset_name=le.DATASET_NAME,
            schema_version="1",
            aggregate_fingerprint="fake",
            examples=[
                le.ExampleSpec(
                    probe=probe,
                    example_id=preview["id"],
                    fingerprint=preview["metadata"]["content_fingerprint"],
                    inputs=preview["inputs"],
                    outputs=preview["outputs"],
                    metadata=preview["metadata"],
                )
            ],
        )

    async def test_run_experiment_sequential_and_scored(self):
        client = FakeClient()
        manifest = await self._practice_manifest()
        client.examples = [
            FakeExample(
                id=ex.example_id,
                inputs=ex.inputs,
                outputs=ex.outputs,
                metadata=ex.metadata,
            )
            for ex in manifest.examples
        ]
        order: list[str] = []

        async def target(inputs: dict) -> dict:
            order.append(inputs["name"])
            return {"answer": "I will draw a diagram", "prompt": "portrait: diagram",
                    "superseded": 0}

        results = await le.run_experiment(
            client=client,
            manifest=manifest,
            target=target,
            project_hint="hint",
        )
        assert order == ["recalls_a_stated_preference"]
        call = client.aevaluate_calls[-1]
        assert call["max_concurrency"] == 1
        assert call["experiment_prefix"] == le.EXPERIMENT_PREFIX
        assert call["data"] == le.DATASET_NAME
        assert call["metadata"]["dataset"] == le.DATASET_NAME
        assert call["metadata"]["schema_version"] == "1"
        # The fake client actually awaited the target and evaluators.
        assert call["evaluators"]
        assert len(order) == 1
        assert len(client.examples) == 1

    async def test_run_experiment_with_multiple_examples_runs_all(self):
        client = FakeClient()
        manifest = le.dataset_manifest(_now())
        client.examples = [
            FakeExample(
                id=ex.example_id,
                inputs=ex.inputs,
                outputs=ex.outputs,
                metadata=ex.metadata,
            )
            for ex in manifest.examples
        ]
        order: list[str] = []

        async def target(inputs: dict) -> dict:
            order.append(inputs["name"])
            return {
                "answer": "I will draw a diagram",
                "prompt": "portrait: diagram",
                "superseded": 1,
            }

        results = await le.run_experiment(
            client=client,
            manifest=manifest,
            target=target,
        )
        assert set(order) == {e.probe["name"] for e in manifest.examples}
        assert client.aevaluate_calls[-1]["max_concurrency"] == 1

    async def test_evaluate_command_fails_on_false_score(self):
        manifest = le.dataset_manifest(_now())
        rows = [
            {
                "run": FakeRun(outputs={"answer": "bad", "failures": []}),
                "example": FakeExample(
                    id=uuid.uuid4(), inputs={"name": "recalls_a_stated_preference"},
                    outputs=manifest.examples[0].outputs,
                ),
            }
        ]
        code = await self._collect_command(rows=rows, scores=[False])
        assert code == 1

    async def test_evaluate_command_fails_on_target_failure(self):
        manifest = le.dataset_manifest(_now())
        rows = [
            {
                "run": FakeRun(outputs={"failures": ["nothing reached the model"]}),
                "example": FakeExample(
                    id=uuid.uuid4(), inputs={"name": "does_not_invent_memories"},
                    outputs=manifest.examples[3].outputs,
                ),
            }
        ]
        code = await self._collect_command(rows=rows)
        assert code == 1

    async def test_evaluate_command_passes_on_all_true(self):
        manifest = le.dataset_manifest(_now())
        rows = []
        for i, ex in enumerate(manifest.examples):
            rows.append({
                "run": FakeRun(outputs={"answer": "ok", "failures": []}),
                "example": FakeExample(
                    id=ex.example_id,
                    inputs=ex.inputs,
                    outputs=ex.outputs,
                    metadata=ex.metadata,
                ),
            })
        code = await self._collect_command(rows=rows)
        assert code == 0

    async def test_evaluate_command_fails_when_rows_are_missing(self):
        code = await self._collect_command(rows=[])
        assert code == 1

    async def test_evaluate_command_fails_when_scores_are_missing(self):
        manifest = await self._practice_manifest()
        rows = [{
            "run": FakeRun(outputs={"answer": "ok", "failures": []}),
            "example": FakeExample(
                id=manifest.examples[0].example_id,
                inputs=manifest.examples[0].inputs,
                outputs=manifest.examples[0].outputs,
            ),
        }]

        class ScoresMissing:
            experiment_name = "experiment-missing-scores"
            url = None

            def __aiter__(self):
                async def iterate():
                    for row in rows:
                        yield row
                return iterate()

        client = FakeClient()

        async def fake_aevaluate(*args, **kwargs):
            return ScoresMissing()

        client.aevaluate = fake_aevaluate
        code = await le._run_evaluate_command(
            client=client,
            manifest=manifest,
            model="gpt-test",
            effort="low",
            now=_now(),
        )
        assert code == 1

    async def test_build_target_signature_accepts_inputs_positionally(self):
        target = le.build_target(model="gpt-test", effort="low", now=_now())
        import inspect
        sig = inspect.signature(target)
        params = list(sig.parameters)
        assert params[0] == "inputs"
        # The real harness must always be sequential so the shared DB schema is
        # never shared between examples.
        assert le.MAX_CONCURRENCY == 1

    async def test_build_target_resolves_full_reference_contract(self):
        # The dataset stores raw inputs only; the target must resolve the full
        # probe spec (including answer/prompt/supersession expectations) from
        # the manifest before calling run_probe.
        manifest = le.dataset_manifest(_now())
        target = le.build_target(model="gpt-test", effort="low", now=_now(),
                                 manifest=manifest)
        seen: dict[str, dict] = {}

        async def fake_run_probe(store, probe, **kwargs):
            seen[probe["name"]] = probe
            return _result()

        import tests.eval.run_probes as probes
        import pytest
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(probes, "run_probe", fake_run_probe)
        async def fake_open_store():
            return {"fake": True}

        async def fake_close_store(store):
            return None

        monkeypatch.setattr(probes, "open_store", fake_open_store)
        monkeypatch.setattr(probes, "close_store", fake_close_store)
        try:
            await target(manifest.examples[0].inputs)
        finally:
            monkeypatch.undo()
        spec = seen["recalls_a_stated_preference"]
        expected = next(
            e for e in manifest.examples
            if e.probe["name"] == "recalls_a_stated_preference"
        ).probe
        assert spec["answer_any"] == expected["answer_any"]
        assert spec["prompt_any"] == expected["prompt_any"]

    async def test_build_target_resolves_placeholders_at_run_time(self):
        manifest = le.dataset_manifest(_now())
        target = le.build_target(model="gpt-test", effort="low",
                                 now=datetime(2026, 11, 1, tzinfo=timezone.utc),
                                 manifest=manifest)
        seen: dict[str, dict] = {}

        async def fake_run_probe(store, probe, **kwargs):
            seen[probe["name"]] = probe
            return _result()

        import tests.eval.run_probes as probes
        import pytest
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(probes, "run_probe", fake_run_probe)
        async def fake_open_store():
            return {"fake": True}

        async def fake_close_store(store):
            return None

        monkeypatch.setattr(probes, "open_store", fake_open_store)
        monkeypatch.setattr(probes, "close_store", fake_close_store)
        try:
            goal = next(e for e in manifest.examples
                        if e.probe["name"] == "recalls_a_goal_with_a_deadline")
            await target(goal.inputs)
        finally:
            monkeypatch.undo()
        spec = seen["recalls_a_goal_with_a_deadline"]
        transcript = "\n".join(s["transcript"] for s in spec["sessions"])
        assert "{deadline_iso}" not in transcript
        assert "{deadline}" not in transcript

    async def test_reference_placeholders_resolved_in_evaluator(self):
        """The evaluator reference must use the experiment clock, not raw."""
        raw = {"prompt_any": ["{deadline_month}", "{deadline_iso}"]}
        resolved = le._resolve_reference(
            raw,
            datetime(2026, 11, 1, tzinfo=timezone.utc),
        )
        assert "{deadline_month}" not in resolved["prompt_any"][0]
        assert "{deadline_iso}" not in resolved["prompt_any"][1]
        assert "February" in resolved["prompt_any"][0]
        assert "2027-02-04" in resolved["prompt_any"][1]

    def test_reference_resolution_matches_target_clock(self):
        now = datetime(2026, 11, 1, tzinfo=timezone.utc)
        resolved = le._resolve_reference(
            {"prompt_any": ["{deadline_iso}"]}, now
        )
        # 95 days after 2026-11-01 is 2027-02-04.
        assert resolved == {"prompt_any": ["2027-02-04"]}


def test_sequence_is_sequential_constant():
    assert le.MAX_CONCURRENCY == 1
