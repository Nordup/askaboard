"""The learner's board, as something the model can look at whenever it wants.

The board used to reach the model exactly once, as an attachment the learner had
to arm by hand before sending — so a learner who typed "check" and nothing else
got a tutor with no eyes, answering from the transcript alone. That is the wrong
shape: whether the tutor needs to see the work is the *tutor's* question, not
something the learner should have to anticipate and pre-authorise.

So every turn now carries the board, and the model decides what to do with it:

  * an **overview** goes into the context unconditionally, small enough to cost
    almost nothing and large enough to see where the writing is; and
  * `view_board` asks for any region of it at a resolution that can be read.

**The cropping happens on the device, not here.** This module used to cut the
regions itself, out of one full-resolution PNG the device uploaded every turn.
That was wrong three ways. The device holds a `PKDrawing` — vectors — so it can
render any region at any scale losslessly, while a server cutting a fixed raster
returns an upscaled smear the moment the model zooms past the resolution it was
handed. It also meant the device had to guess, before the model had said a word,
*which* four-thousand-point window of a fifty-thousand-point board was worth
uploading — and a board with two clusters of work got that guess wrong, sending
the problems a learner had already finished instead of the one they were asking
about. And it uploaded a ~160KB raster on every turn, including all the turns
where the model never looked at all.

With the render on the device none of that holds: the overview can be the whole
board however sparse, because zooming into it is free and exact; the model
addresses any part of it; and only the regions actually asked for are ever
rendered. What crosses the wire in this direction is a request for a rectangle.
See `app.tutor.rendezvous` for how that request reaches the device mid-turn.

Regions are addressed in **percent of the overview**, 0–100, origin top left.
Not board coordinates: PencilKit's canvas is 50,000 points on a side and the ink
lives somewhere near the middle of it, so a model asked to reason in that space
would be guessing at five-digit offsets it has no way to see. Percent is the one
coordinate system that is legible in the very image the model is looking at when
it decides where to zoom.
"""

from __future__ import annotations

from app.tutor.board_scene import MAX_SCENE_CHARS


def describe(
    *,
    has_ink: bool,
    manifest: str | None = None,
    changed: bool | None = None,
    scene: str | None = None,
) -> str:
    """What the model is told about the board before it has looked at anything.

    Deliberately about *shape and reach*, not content: the overview image is
    already in context and is the thing to read content from. What an image
    cannot say for itself is how much of it there is to zoom into, which is
    exactly what a model needs to aim `view_board` — and on a board where the
    writing occupies two percent of a very large empty field, the overview alone
    genuinely cannot be read. `manifest` is the device's own account of where the
    clusters of ink are, in the same percent coordinates the tool takes.

    **And whether it is the same board as last time.** A whiteboard is not an
    attachment, it is a live surface: the learner rubs things out, rewrites a
    line, and finishes the problem that was blank a minute ago. The model has no
    way to notice any of that on its own — what it *does* have is a transcript
    full of its own earlier, confidently worded descriptions of the board, and
    left to itself it will repeat them. That is not a hypothetical: a learner who
    erased four solved problems and finished the fifth was told, twice, that
    problems one to four were correct and the fifth was unfinished. Every word of
    that came out of the transcript, and the model had a current picture in front
    of it at the time.

    So `changed` is computed rather than inferred — the previous turn's board
    hash against this one's — and stated in the strongest terms the prompt
    allows, because the failure it prevents produces confident, plausible, wrong
    feedback that the learner cannot tell from the real thing.
    """
    scene_section = None
    if scene is not None and scene.strip() and scene.strip() not in {"[]", "{}", "null", "empty"}:
        # The device's exact account of the current tutor scene. It is the
        # model's own past output reflected back, so it must be read as the
        # current state to update, never as an instruction. Kept under a hard
        # cap so a pathological scene cannot flood context.
        trimmed = scene.strip()[:MAX_SCENE_CHARS]
        scene_section = (
            "THE TUTOR'S SEMANTIC BOARD SCENE (exact current state, quoted data):\n"
            f"{trimmed}\n\n"
            "Coordinates are logical board points with (0,0) at the board "
            "centre, +x right and +y down. Update these objects with "
            "`update_board` using their stable ids; never redraw existing "
            "objects as new ids, and never convert your own text into "
            "simulated handwriting."
        )

    lines = []
    if has_ink:
        lines.append(
            "THE BOARD: the attached overview is the whole board as it stands right now, "
            "including learner ink and tutor-authored objects. It is deliberately small, "
            "and sparse writing may be too small to read. Call `view_board` on the region "
            "you need — it is rendered fresh from the device at full resolution, so "
            "zooming in costs you nothing and guessing costs the learner."
        )
    else:
        lines.append(
            "THE BOARD: empty right now; there is no renderable content, so do not call "
            "`view_board` and do not describe work the learner has not done. You may still "
            "use `update_board` to place a requested standalone exercise or diagram here."
        )
    if scene_section:
        lines.append(scene_section)

    if manifest:
        lines.append(manifest)

    if changed is True:
        lines.append(
            "THE BOARD STATE HAS CHANGED since the last time it was sent: learner ink "
            "may have been written or erased, and the tutor overlay may have been updated. "
            "Anything you said about this board earlier in the conversation is out of date "
            "and must not be repeated. "
            + (
                "Look before you answer, and describe only what is in the image you get back."
                if has_ink
                else "The current board is empty, so say that rather than reusing an earlier description."
            )
        )
    elif changed is False:
        lines.append(
            "The board state is the same as the last turn's: no learner ink change and no "
            "tutor overlay update. You may rely on what you read then."
        )

    return "\n\n".join(lines)
