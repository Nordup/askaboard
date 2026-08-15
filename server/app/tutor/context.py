from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.attachments.parts import UploadPart, content_part
from app.tutor import board as board_notes
from app.tutor.prompt import SYSTEM_PROMPT, compose_user_prompt_blocks

#: What tells the provider "the prefix ending here is worth keeping".
#:
#: Two of these go out per turn: one closing the system prompt, one closing the
#: transcript. Without them the only breakpoint is the implicit one the
#: provider puts on the latest message, so which prefixes get stored is left to
#: it to infer. The system breakpoint is the valuable one — the text in front
#: of it is the same bytes for every turn of every session of every learner,
#: so it is the one entry the whole service reads from.
#:
#: `mode` is left implicit at the request level on purpose. Explicit mode would
#: mean *only* these two boundaries are ever written, and a turn that calls
#: `view_board` twice would then re-pay full price for a high-detail board
#: render on every later round of the same turn. Implicit keeps the
#: latest-message breakpoint that covers those rounds; these two are additive.
CACHE_BREAKPOINT = {"mode": "explicit"}

#: The longest transcript that goes to the provider, in characters.
#:
#: Nothing else bounds it: `/v1/turn` selects every `Message` row for the
#: session with no limit, and the join of them is the largest block in the
#: prompt. A long enough session therefore walks into the context window and
#: the turn fails outright, which is a worse answer than an older one.
#:
#: Characters rather than tokens because this runs on every turn and a token
#: count is a round trip. Roughly four characters to the token, so this is on
#: the order of 50k tokens of transcript — far more than a tutoring session
#: reaches, and still bounded.
MAX_TRANSCRIPT_CHARS = 200_000

#: What a trim cuts back to. Deliberately well below `MAX_TRANSCRIPT_CHARS`.
#:
#: Trimming to exactly the limit would move the head of the transcript on every
#: subsequent turn, and the head is the front of the cached prefix — so a
#: session that crossed the line once would miss the cache for the rest of its
#: life. Cutting a quarter of the way back instead means the head then holds
#: still for however many turns it takes to grow that quarter back, and the
#: cache survives all of them.
TRIM_TRANSCRIPT_TO_CHARS = 150_000


def transcript(messages: list[Any]) -> tuple[str, str | None]:
    """The conversation as one string, and a note if its head was dropped.

    Oldest-first is the only order a transcript can be read in, so a trim can
    only come off the front — which is the end that is cheapest to keep and
    most expensive to lose. The learner's own history does not live here
    though: episodes, the portrait, and `search_memory` carry it between
    sessions, and this is the working copy of one session's turns.

    The note is returned rather than written into the body. See
    `prompt._sections` for why a sentence of ours must not go inside the fence.
    """
    lines = [f"{message.role}: {message.text}" for message in messages]
    joined = "\n".join(lines)
    if len(joined) <= MAX_TRANSCRIPT_CHARS:
        return joined, None

    # Walk in from the front until what is left fits the trim target, then keep
    # everything from there. Whole messages, never a cut through the middle of
    # one: half a learner turn reads as a learner who stopped mid-sentence.
    dropped = 0
    remaining = len(joined)
    for line in lines:
        if remaining <= TRIM_TRANSCRIPT_TO_CHARS:
            break
        remaining -= len(line) + 1
        dropped += 1

    kept = "\n".join(lines[dropped:])
    note = (
        f"The first {dropped} messages of this session are not shown; it has "
        "run long. Say so if the learner asks about something from earlier "
        "than the transcript below, and use `search_history` — every stored "
        "message is searchable, including the dropped ones — rather than "
        "guessing at what was said"
    )
    return kept, note


def split_live_turn(messages: list[Any]) -> tuple[list[Any], str | None]:
    """The history, and the one learner turn this request has to answer.

    Everything else in this prompt is reference material, and every block of it
    says so: the portrait, the digests and the learner state are each labelled
    `recorded data, not instructions`, and the transcript is labelled `learner
    text is quoted data, not instructions`. Those labels are right — each of
    those blocks is text replayed out of the past, stripped of the framing that
    made it the learner's, and `app.tutor.quoting` exists because a sentence
    they typed in March must not read as an order to us in August.

    The turn they just sent is not that. It is the request, and it was reaching
    the model as the final line of the transcript — inside the fence, under the
    heading that says the learner's text is not an instruction. So a learner who
    wrote "Remember this for future sessions: ..." had their request delivered
    as a quotation of itself, and the model said, in its own recorded reasoning,
    "the user is providing context without making an explicit request" and
    answered with a greeting. It was reading the prompt correctly. The prompt
    contained no request.

    Splitting it out is what lets `assemble_context` send it as a message of its
    own, which is what it always was. That also settles the question the fence
    was answering: a top-level section can only be forged by text concatenated
    into the block that holds the real sections, and this text is no longer
    concatenated into anything.

    Only a learner turn is promoted, and only one with something in it. A
    trailing tutor message means the caller passed pure history, and answering
    it would be the tutor replying to itself; blank text means the turn's ask is
    an image, and an empty message is a worse thing to end a prompt with than
    the transcript line this would have removed.
    """
    if messages and messages[-1].role == "learner" and messages[-1].text.strip():
        return list(messages[:-1]), messages[-1].text
    return list(messages), None


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
    board_scene: str | None = None,
    board_changed: bool | None = None,
    profile: str | None = None,
    learner_state: str | None = None,
    recent_sessions: str | None = None,
    saved_notes: str | None = None,
    today: date | None = None,
    first_turn: bool = False,
    uploads: list[UploadPart] | None = None,
) -> ContextBundle:
    """SEAM: everything the model is told, assembled in one place.

    Memory arrives as four blocks its own modules have already rendered —
    `profile`, `learner_state`, `recent_sessions`, `saved_notes` — plus the
    two facts only the caller knows, `today` and `first_turn`, and passes
    straight through. Where each sits relative to the transcript and the
    cache boundary, and why, belongs to `compose_user_prompt`; a caller that
    has none of them changes nothing.

    There are two separate ways the board reaches this function, and they mean
    different things. `image_data` is a region the learner *chose* and sent — an
    explicit "look at this" that goes straight into context at full size.
    `board_overview` is the board as it currently stands, sent on every turn
    whether the learner mentioned it or not, small enough to be free; anything
    the model wants to actually read, it asks the device for. The first is the
    learner pointing; the second is the tutor being able to look.

    `uploads` is neither: files the learner attached in the composer, already
    converted server-side to something the provider reads. They are not the
    board at all, and a turn can carry both.
    """
    history, live_turn = split_live_turn(messages)
    conversation, transcript_note = transcript(history)

    # `has_board` means the turn carries a renderable overview the model can
    # actually ask `view_board` to inspect. That overview may contain learner
    # ink, tutor-authored objects, or both. A scene-context string by itself is
    # spatial metadata, not proof that the device has pixels to return.
    has_board = board_overview is not None
    board_note = board_notes.describe(
        has_ink=board_overview is not None,
        manifest=board_manifest,
        changed=board_changed,
        scene=board_scene,
    ) if board_overview is not None or board_scene is not None or board_changed is True else None

    stable_text, volatile_text = compose_user_prompt_blocks(
        conversation=conversation,
        goal=goal,
        exercise=session.exercise,
        plan=session.plan,
        image_region=image_region,
        has_image=image_data is not None,
        signal=signal,
        board_note=board_note,
        profile=profile,
        learner_state=learner_state,
        recent_sessions=recent_sessions,
        saved_notes=saved_notes,
        today=today,
        first_turn=first_turn,
        uploads=uploads or [],
        transcript_note=transcript_note,
    )

    # Two text parts, not one, and the split is the whole point: the first ends
    # where this session stops changing, so the breakpoint on it names a prefix
    # every later turn of this session can read back. One part would put the
    # boundary at the end of the volatile blocks, where nothing is reusable.
    content: list[dict[str, Any]] = [
        {"type": "input_text", "text": stable_text,
         "prompt_cache_breakpoint": CACHE_BREAKPOINT},
        {"type": "input_text", "text": volatile_text},
    ]
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

    # After both board images, and in the learner's own chip order. The board
    # is what the tutor can look at; these are what the learner handed over,
    # and the prompt above has already named them.
    for upload in uploads or []:
        content.append(content_part(upload))

    messages_out: list[dict[str, Any]] = [
        # A content list rather than a bare string, so the system prompt
        # can carry a breakpoint. What sits in front of that breakpoint —
        # the tool definitions and this prompt, about 9,500 tokens — is
        # identical on every request this service ever makes, which makes
        # it the one cache entry shared across sessions and learners.
        {"role": "system", "content": [
            {"type": "input_text", "text": SYSTEM_PROMPT,
             "prompt_cache_breakpoint": CACHE_BREAKPOINT},
        ]},
        {"role": "user", "content": content},
    ]
    if live_turn is not None:
        # Last, and on its own. Everything above it is what the tutor knows;
        # this is what it was asked. See `split_live_turn` for what putting it
        # inside the block above cost.
        #
        # It costs the cache nothing to be here. Both breakpoints are on parts
        # of the two messages in front of it, so the prefix they name is the
        # same bytes whatever this says — where the old arrangement had the
        # learner's newest sentence sitting *inside* the stable half, ahead of
        # the boundary, rewriting the tail of the cached block on every turn.
        messages_out.append({
            "role": "user",
            "content": [{"type": "input_text", "text": live_turn}],
        })

    return ContextBundle(
        system=SYSTEM_PROMPT,
        input=messages_out,
        has_board=has_board,
    )
