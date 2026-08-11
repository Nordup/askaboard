"""What `/v1/turn` refuses before any provider call.

Pure request-body validation, so none of it needs a database. The model check
had a test already, but only through the endpoint — which meant the effort
field beside it could go unguarded without anything noticing.
"""
import uuid

import pytest
from pydantic import ValidationError

from app.api.turn import TurnRequest
from app.config import MODEL_ALLOWLIST, REASONING_EFFORT_ALLOWLIST


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


@pytest.mark.parametrize("effort", sorted(REASONING_EFFORT_ALLOWLIST))
def test_every_allowed_effort_is_accepted(effort):
    assert _request(reasoning_effort=effort).reasoning_effort == effort


@pytest.mark.parametrize("effort", ["ultra", "", "HIGH", "maximum", "9"])
def test_an_effort_outside_the_allowlist_is_refused(effort):
    """Effort multiplies reasoning tokens, which bill at the output rate — six
    times input on Luna. Gating the model and not the effort closes half of
    "any model at any price". An unknown string is also a provider 400
    mid-stream, where a 422 here says which values exist.
    """
    with pytest.raises(ValidationError) as caught:
        _request(reasoning_effort=effort)
    assert "reasoning effort" in str(caught.value)


@pytest.mark.parametrize("model", sorted(MODEL_ALLOWLIST))
def test_every_allowed_model_is_accepted(model):
    assert _request(model=model).model == model


def test_a_model_outside_the_allowlist_is_refused():
    with pytest.raises(ValidationError) as caught:
        _request(model="gpt-5.6-expensive")
    assert "Unknown model" in str(caught.value)


def test_both_gates_name_what_is_allowed():
    """A 422 that does not say what to send instead is a support question."""
    for overrides in [{"model": "nope"}, {"reasoning_effort": "nope"}]:
        with pytest.raises(ValidationError) as caught:
            _request(**overrides)
        assert "Allowed:" in str(caught.value)
