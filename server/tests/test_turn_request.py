"""What `/v1/turn` refuses before any provider call.

Pure request-body validation, so none of it needs a database. The model check
had a test already, but only through the endpoint — which meant the effort
field beside it could go unguarded without anything noticing.
"""
import uuid

import pytest
from pydantic import ValidationError

from app.api.turn import TurnRequest
from app.config import EFFORTS_FOR_MODEL, MODEL_ALLOWLIST


def _request(**overrides) -> TurnRequest:
    body = {
        "turn_id": uuid.uuid4(),
        "session_id": uuid.uuid4(),
        "text": "check my work",
        "model": "gpt-5.6-luna",
        "reasoning_effort": "high",
    }
    body.update(overrides)
    return TurnRequest(**body)


def test_every_allowlisted_model_has_an_effort_set():
    """The import guard in app/config.py says the same thing, and this says it
    where a failure reads as a test rather than as a server that will not
    boot."""
    assert MODEL_ALLOWLIST <= set(EFFORTS_FOR_MODEL)


def test_no_effort_set_is_empty():
    """A model with no efforts is a model no turn can name an effort for."""
    assert all(efforts for efforts in EFFORTS_FOR_MODEL.values())


@pytest.mark.parametrize(
    ("model", "effort"),
    sorted(
        (model, effort)
        for model, efforts in EFFORTS_FOR_MODEL.items()
        for effort in efforts
    ),
)
def test_every_effort_its_model_offers_is_accepted(model, effort):
    request = _request(model=model, reasoning_effort=effort)
    assert request.reasoning_effort == effort
    assert request.model == model


@pytest.mark.parametrize("effort", ["ultra", "", "HIGH", "maximum", "9", "none"])
def test_an_effort_no_model_offers_is_refused(effort):
    """Effort multiplies reasoning tokens, which bill at the output rate — six
    times input on Luna. Gating the model and not the effort closes half of
    "any model at any price". An unknown string is also a provider 400
    mid-stream, where a 422 here says which values exist.

    "none" is in this list rather than in an effort set, and it is the only
    entry that is not a typo. The device's settings picker offered it, and the
    device sends the raw value, so every turn of that session 422'd here. The
    spend argument above does not object to it — it is the cheapest effort —
    but the provider does not accept it, so the refusal is right and the
    client dropped the case (`ReasoningEffort` in MathTutor/Domain/Models.swift).
    """
    with pytest.raises(ValidationError) as caught:
        _request(reasoning_effort=effort)
    assert "reasoning effort" in str(caught.value)


@pytest.mark.parametrize("effort", ["xhigh", "max"])
def test_gemini_refuses_the_depths_only_gpt_offers(effort):
    """Gemini offers three levels. The picker clamps on the device; this is the
    guard behind it, and it exists because effort multiplies reasoning tokens
    and reasoning bills at the output rate. Accepting `max` here would move the
    failure to mid-stream at the provider, after the turn is already spending.
    """
    with pytest.raises(ValidationError) as caught:
        _request(model="gemini-3.7-flash", reasoning_effort=effort)
    assert "reasoning effort" in str(caught.value)


def test_gemini_accepts_the_depths_it_does_offer():
    assert _request(
        model="gemini-3.7-flash", reasoning_effort="high"
    ).reasoning_effort == "high"


def test_gpt_still_accepts_max():
    """The per-model table must not have narrowed the family that had five."""
    assert _request(
        model="gpt-5.6-sol", reasoning_effort="max"
    ).reasoning_effort == "max"


def test_the_refusal_names_the_pair_not_just_the_effort():
    """A 422 that names only the effort leaves the device guessing which of the
    two values was wrong — `max` is a real effort, just not on this model."""
    with pytest.raises(ValidationError) as caught:
        _request(model="gemini-3.7-flash", reasoning_effort="max")
    message = str(caught.value)
    assert "gemini-3.7-flash" in message
    assert "'max'" in message


@pytest.mark.parametrize("model", sorted(MODEL_ALLOWLIST))
def test_every_allowed_model_is_accepted(model):
    assert _request(model=model, reasoning_effort="low").model == model


def test_a_model_outside_the_allowlist_is_refused():
    with pytest.raises(ValidationError) as caught:
        _request(model="gpt-5.6-expensive")
    assert "Unknown model" in str(caught.value)


def test_an_unknown_model_is_refused_before_the_effort_is_paired_with_it():
    """Load-bearing ordering, not a detail. The effort check indexes
    EFFORTS_FOR_MODEL by `self.model`, which is only safe because the field
    validator has already refused an unknown model — Pydantic runs field
    validators before any `mode="after"` model validator. If that order ever
    inverts, this body raises KeyError instead of ValidationError and the
    device gets a 500 where it had a readable 422.
    """
    with pytest.raises(ValidationError) as caught:
        _request(model="gpt-5.6-expensive", reasoning_effort="max")
    assert "Unknown model" in str(caught.value)


def test_both_gates_name_what_is_allowed():
    """A 422 that does not say what to send instead is a support question."""
    for overrides in [{"model": "nope"}, {"reasoning_effort": "nope"}]:
        with pytest.raises(ValidationError) as caught:
            _request(**overrides)
        assert "Allowed:" in str(caught.value)
