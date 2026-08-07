from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

from app.tutor.prompt import SYSTEM_PROMPT, compose_user_prompt


@dataclass(frozen=True)
class ContextBundle:
    system: str
    input: list[dict[str, Any]]


def assemble_context(
    *,
    session: Any,
    messages: list[Any],
    image_data: bytes | None,
    image_region: str | None,
    signal: str | None,
    goal: str | None,
) -> ContextBundle:
    """SEAM: everything the model is told, assembled in one place.

    Retrieved memory facts and RAG chunks become additional sections appended to
    the user prompt here. No caller changes when they do.
    """
    conversation = "\n".join(f"{m.role}: {m.text}" for m in messages)
    user_text = compose_user_prompt(
        conversation=conversation,
        goal=goal,
        exercise=session.exercise,
        plan=session.plan,
        image_region=image_region,
        has_image=image_data is not None,
        signal=signal,
    )

    content: list[dict[str, Any]] = [{"type": "input_text", "text": user_text}]
    if image_data is not None:
        encoded = base64.b64encode(image_data).decode()
        content.append({
            "type": "input_image",
            "image_url": f"data:image/png;base64,{encoded}",
            "detail": "original",
        })

    return ContextBundle(
        system=SYSTEM_PROMPT,
        input=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
    )
