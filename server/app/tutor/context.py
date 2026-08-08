from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

from app.tutor import board as board_notes
from app.tutor.prompt import SYSTEM_PROMPT, compose_user_prompt


@dataclass(frozen=True)
class ContextBundle:
    system: str
    input: list[dict[str, Any]]
    #: Whether this turn has a board the tutor could look at.
    #:
    #: A flag rather than bytes, because the server no longer holds the board.
    #: The device renders every region on demand — see `app.tutor.board` for why
    #: that moved — so all the loop needs to know here is whether offering
    #: `view_board` an answer is possible at all.
    has_board: bool = False


def assemble_context(
    *,
    session: Any,
    messages: list[Any],
    image_data: bytes | None,
    image_region: str | None,
    signal: str | None,
    goal: str | None,
    board_overview: bytes | None = None,
    board_manifest: str | None = None,
    board_changed: bool | None = None,
) -> ContextBundle:
    """SEAM: everything the model is told, assembled in one place.

    Retrieved memory facts and RAG chunks become additional sections appended to
    the user prompt here. No caller changes when they do.

    There are two separate ways the board reaches this function, and they mean
    different things. `image_data` is a region the learner *chose* and sent — an
    explicit "look at this" that goes straight into context at full size.
    `board_overview` is the board as it currently stands, sent on every turn
    whether the learner mentioned it or not, small enough to be free; anything
    the model wants to actually read, it asks the device for. The first is the
    learner pointing; the second is the tutor being able to look.
    """
    conversation = "\n".join(f"{m.role}: {m.text}" for m in messages)

    has_board = board_overview is not None
    board_note = board_notes.describe(
        has_ink=has_board, manifest=board_manifest, changed=board_changed
    ) if has_board or board_changed is True else None

    user_text = compose_user_prompt(
        conversation=conversation,
        goal=goal,
        exercise=session.exercise,
        plan=session.plan,
        image_region=image_region,
        has_image=image_data is not None,
        signal=signal,
        board_note=board_note,
    )

    content: list[dict[str, Any]] = [{"type": "input_text", "text": user_text}]
    if image_data is not None:
        encoded = base64.b64encode(image_data).decode()
        content.append({
            "type": "input_image",
            "image_url": f"data:image/png;base64,{encoded}",
            "detail": "original",
        })
    if board_overview is not None:
        encoded = base64.b64encode(board_overview).decode()
        content.append({
            # `low` rather than `original`: the overview exists to be glanced at
            # and aimed with, and `view_board` is what reading is for. Paying
            # original-detail token cost for a thumbnail on every single turn
            # would undo the reason it is a thumbnail.
            "type": "input_image",
            "image_url": f"data:image/png;base64,{encoded}",
            "detail": "low",
        })

    return ContextBundle(
        system=SYSTEM_PROMPT,
        input=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        has_board=has_board,
    )
