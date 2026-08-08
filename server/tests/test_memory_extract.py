import json

from app.config import EXTRACTION_MODEL
from app.memory.extract import EXTRACTION_PROMPT, MIN_TRANSCRIPT_CHARS, _parse, extract_atoms
from app.memory.schema import EXTRACTION_SCHEMA, MemoryCategory
from app.store.models import MEMORY_CATEGORIES


class _FakeResponses:
    def __init__(self, recorder, payload: str):
        self._recorder = recorder
        self._payload = payload

    async def create(self, **kwargs):
        self._recorder.append(kwargs)
        return type("R", (), {"output_text": self._payload})()


class _FakeClient:
    def __init__(self, recorder, payload: str = '{"atoms": []}'):
        self.responses = _FakeResponses(recorder, payload)


#: Long enough to clear MIN_TRANSCRIPT_CHARS, so a test about the request is
#: not silently testing the short-transcript skip instead.
TRANSCRIPT = (
    "learner: I have my GCSE foundation paper in June and I keep losing marks on "
    "fractions.\ntutor: Let's look at one. What did you get for 3/4 + 1/6?\n"
    "learner: 4/10. And honestly I'd rather you draw it than write the algebra out.\n"
    "tutor: Let's draw the two bars then.\n"
)


def test_parse_keeps_known_categories():
    payload = json.dumps({"atoms": [
        {"text": "Wants to be ready for the June exam.", "category": "goal", "stated": True},
        {"text": "Prefers worked examples first.", "category": "preference", "stated": True},
    ]})
    atoms = _parse(payload)
    assert [a.category for a in atoms] == [MemoryCategory.goal, MemoryCategory.preference]


def test_parse_drops_unknown_categories():
    payload = json.dumps({"atoms": [
        {"text": "Something.", "category": "vibes", "stated": True},
        {"text": "Wants the June exam.", "category": "goal", "stated": True},
    ]})
    assert len(_parse(payload)) == 1


def test_parse_drops_inferred_atoms():
    """Only what the learner actually said. Inferences are where a memory
    system starts being confidently wrong about someone."""
    payload = json.dumps({"atoms": [
        {"text": "Is probably an anxious learner.", "category": "context", "stated": False},
        {"text": "Said they are in Year 9.", "category": "context", "stated": True},
    ]})
    atoms = _parse(payload)
    assert len(atoms) == 1
    assert atoms[0].text == "Said they are in Year 9."


def test_parse_tolerates_empty():
    assert _parse(json.dumps({"atoms": []})) == []


def test_parse_requires_stated_to_be_literally_true():
    """`"false"` is a true-ish string. Truthiness would admit it as a statement.

    This is the one asymmetric field in the payload. Dropping a real fact
    because the model typed a string costs one atom out of one session;
    admitting a guess because `"false"` is truthy writes an inference into the
    learner's permanent record wearing a learner statement's authority, and
    nothing downstream can tell the two apart afterwards.
    """
    payload = json.dumps({"atoms": [
        {"text": "Seems to rush the last question.", "category": "context", "stated": "false"},
        {"text": "Studies after dinner on weekdays.", "category": "context", "stated": 1},
    ]})
    assert _parse(payload) == []


def test_parse_drops_blank_and_non_string_text():
    """An atom with no text is a row that says nothing and ranks against every
    query. Whitespace-only counts as blank."""
    payload = json.dumps({"atoms": [
        {"text": "   ", "category": "goal", "stated": True},
        {"text": "", "category": "goal", "stated": True},
        {"text": 42, "category": "goal", "stated": True},
        {"text": "  Sits the AQA foundation paper in June.  ", "category": "goal", "stated": True},
    ]})
    atoms = _parse(payload)
    assert [a.text for a in atoms] == ["Sits the AQA foundation paper in June."]


def test_parse_survives_malformed_payloads():
    """Tolerant of the model: nothing it can emit turns into an exception.

    Structured output makes these unlikely, not impossible — a refusal, a
    truncated response, or a model that answers with the array alone all land
    here. One session's extraction failing is acceptable; the offline pass that
    calls this walking a whole backlog and dying on one session is not.
    """
    assert _parse("not json at all") == []
    assert _parse("") == []
    assert _parse("null") == []
    assert _parse(json.dumps(["already unwrapped"])) == []
    assert _parse(json.dumps({"atoms": None})) == []
    assert _parse(json.dumps({"atoms": "goal"})) == []
    assert _parse(json.dumps({})) == []


def test_parse_drops_only_the_malformed_entry():
    """The cost of one bad entry is that entry."""
    payload = json.dumps({"atoms": [
        "a bare string where an object was asked for",
        None,
        {"category": "goal", "stated": True},
        {"text": "Sits the AQA foundation paper in June.", "category": "goal", "stated": True},
    ]})
    atoms = _parse(payload)
    assert [a.text for a in atoms] == ["Sits the AQA foundation paper in June."]


async def test_extract_atoms_skips_short_transcripts(monkeypatch):
    called = []
    monkeypatch.setattr("app.memory.extract._complete",
                        lambda *a, **k: called.append(1))
    assert await extract_atoms("learner: hi") == []
    assert called == []


async def test_extract_atoms_sends_the_transcript_and_parses_the_reply(monkeypatch):
    calls = []
    payload = json.dumps({"atoms": [
        {"text": "Sits the AQA foundation paper in June.", "category": "goal", "stated": True},
        {"text": "Believes 3/4 + 1/6 is 4/10 — adds numerators and denominators.",
         "category": "misconception", "stated": False},
    ]})
    monkeypatch.setattr("app.memory.extract._client",
                        lambda: _FakeClient(calls, payload))

    atoms = await extract_atoms(TRANSCRIPT)

    # The inferred one is gone; the stated one survives with its category.
    assert [(a.text, a.category) for a in atoms] == [
        ("Sits the AQA foundation paper in June.", MemoryCategory.goal),
    ]
    # EXTRACTION_MODEL imported rather than spelled out, as in
    # tests/test_memory_embed.py: the bug worth catching is a hardcoded model or
    # a reach for the turn's model, not the string's value.
    assert calls[0]["model"] == EXTRACTION_MODEL
    assert TRANSCRIPT in calls[0]["input"][0]["content"]


async def test_extract_atoms_asks_for_the_strict_schema(monkeypatch):
    """Without `strict`, the enum in the schema is advice.

    The categories are a closed set because `ck_memory_atoms_category` rejects
    anything else at insert time. `_parse` is the second line of defence, but
    an atom dropped there is a fact this session found and threw away, so the
    request should be the one that makes a seventh category impossible.
    """
    calls = []
    monkeypatch.setattr("app.memory.extract._client", lambda: _FakeClient(calls))

    await extract_atoms(TRANSCRIPT)

    fmt = calls[0]["text"]["format"]
    assert fmt["type"] == "json_schema"
    assert fmt["strict"] is True
    assert fmt["schema"] == EXTRACTION_SCHEMA


def test_extraction_schema_is_valid_under_strict_mode():
    """Strict structured output rejects any object that omits either rule.

    Nothing else in the suite would notice: the failure is a 400 from the
    provider on the first real extraction, in a background pass nobody is
    watching, long after this was written.
    """
    def walk(node: dict, path: str) -> None:
        if node.get("type") == "object":
            assert node.get("additionalProperties") is False, path
            assert set(node.get("required", [])) == set(node["properties"]), path
            for name, child in node["properties"].items():
                walk(child, f"{path}.{name}")
        elif node.get("type") == "array":
            walk(node["items"], f"{path}[]")

    walk(EXTRACTION_SCHEMA, "$")


def test_categories_match_the_database_constraint():
    """The enum and `ck_memory_atoms_category` are one vocabulary in two files.

    A member added here and not there is not a type error and not a test
    failure anywhere else — it is an atom the extractor happily produces and
    the INSERT rejects, in a background pass, per session, forever.
    """
    assert [c.value for c in MemoryCategory] == list(MEMORY_CATEGORIES)


def test_prompt_offers_exactly_the_categories_the_schema_allows():
    """A category the prompt never explains is one the model never uses; a
    category the prompt invites and the schema forbids is a refused request."""
    for category in MemoryCategory:
        assert f"- {category.value}:" in EXTRACTION_PROMPT
    assert EXTRACTION_SCHEMA["properties"]["atoms"]["items"]["properties"]["category"][
        "enum"
    ] == [c.value for c in MemoryCategory]


def test_prompt_demands_self_contained_facts():
    """Pinning prose, deliberately.

    Every other assertion in this file survives the self-containment
    instruction being trimmed out of the prompt to save tokens — `_parse` would
    keep accepting "they liked that", the schema would keep validating it, and
    the store would fill with atoms that are read back months later with no
    conversation around them and mean nothing. The instruction is the product,
    so it gets a test that fails when it goes.
    """
    assert "stands alone" in EXTRACTION_PROMPT
    assert "Resolve every pronoun" in EXTRACTION_PROMPT
    assert "months from now with no surrounding conversation" in EXTRACTION_PROMPT
    # And the `stated` filter's instruction, which is what makes the flag mean
    # anything by the time `_parse` reads it.
    assert "only when the learner said it themselves" in EXTRACTION_PROMPT


def test_min_transcript_chars_is_a_floor_not_a_ceiling():
    """A boundary a refactor could invert without any other test noticing."""
    assert len(TRANSCRIPT) >= MIN_TRANSCRIPT_CHARS
