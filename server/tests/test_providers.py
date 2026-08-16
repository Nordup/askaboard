"""The seam both model families are reached through.

One provider so far, so what this file can assert is conformance: that the
OpenAI provider satisfies the protocol every later task writes against, that it
names itself, and that the one piece of wiring the seam newly owns — the
download bound behind `ProducedFile.read` — really reaches the provider.

The parity test this file is eventually for arrives with Task 9: two providers,
one `ClientEvent` sequence, so that a change making one family behave
differently from the other fails here before anyone notices it on a board.
"""

import respx
from httpx import Response
from openai import AsyncOpenAI

from app.tutor.providers import TERMINAL_ERROR_STATUSES, Completed, Provider
from app.tutor.providers.openai import OpenAIProvider
from tests.fixtures.sse import CODE_INTERPRETER_TURN, CONTAINER_ID, SCRIPT_FILE_ID, SCRIPT_FILENAME


def test_requires_action_is_not_a_terminal_error():
    """It is how a normal tool round ends. Treating it as a failure would
    break every turn that calls a tool, which is most of them."""
    assert "requires_action" not in TERMINAL_ERROR_STATUSES


def test_the_openai_provider_satisfies_the_protocol():
    assert isinstance(OpenAIProvider(client=None), Provider)


def test_the_openai_provider_names_itself():
    assert OpenAIProvider(client=None).name == "openai"


@respx.mock
async def test_a_produced_files_read_downloads_the_file_it_names():
    """The one piece of production wiring this seam added, and the one nothing
    else covers.

    `run_turn` no longer knows what a container is: it hands the injected relay a
    `ProducedFile`, and `app.api.turn`'s closure calls `read()` on it. Every relay
    stub in `test_loop.py` answers without reading, and the
    `download_container_file` tests call that function directly with ids of their
    own — so the `partial` bound here is the only thing that says which file the
    bytes come from, and a swapped or dropped argument would break every chart
    relay in production with the suite still green.

    Asserted through the URL as well as the bytes, because that is where a
    swapped `container_id`/`file_id` shows up: both are strings and either order
    downloads *something*.
    """
    route = respx.get(
        f"https://api.openai.com/v1/containers/{CONTAINER_ID}"
        f"/files/{SCRIPT_FILE_ID}/content"
    ).mock(return_value=Response(200, content=b"\x89PNG-bytes"))
    provider = OpenAIProvider(client=AsyncOpenAI(api_key="sk-test"))

    completed = provider.neutral(CODE_INTERPRETER_TURN[-1])

    assert isinstance(completed, Completed)
    file, = completed.files
    assert file.key == (CONTAINER_ID, SCRIPT_FILE_ID)
    assert file.filename == SCRIPT_FILENAME

    assert await file.read() == b"\x89PNG-bytes"
    assert route.call_count == 1


def test_a_completion_with_no_script_output_produces_no_files():
    """The other half of the pairing: a turn that ran no script has nothing to
    relay, and a `ProducedFile` invented for it would buy a round to hand over a
    file that does not exist."""
    completed = OpenAIProvider(client=None).neutral({
        "type": "response.completed",
        "response": {"id": "resp_1", "usage": {"input_tokens": 1},
                     "output": [{"type": "message", "content": [
                         {"type": "output_text", "text": "no plot here"}]}]},
    })

    assert isinstance(completed, Completed)
    assert completed.files == []
    assert completed.calls == []
    assert completed.status == "completed"
    assert completed.response_id == "resp_1"
