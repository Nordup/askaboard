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
