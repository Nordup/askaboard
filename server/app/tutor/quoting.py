"""How any externally-authored text is put in front of the model.

Both the recalled-memory blocks (`prompt.py`'s profile, learner-state, and
recent-digest sections) and attached file bodies (`app.attachments.parts`)
wear this. Anything else that quotes learner- or file-authored text into a
prompt should reach for it too, rather than inventing its own delimiter.
"""
from __future__ import annotations

#: Every line of every recalled body wears this.
#:
#: The label alone marks a block; it does not close one. Bodies here are
#: unbounded model prose — `profile.rebuild_profile` returns whatever the
#: synthesis wrote — so a body containing a blank line and a plausible heading
#: renders as a *later* top-level section under framing of its own choosing, up
#: to and including a second CONVERSATION TRANSCRIPT ahead of the real one. A
#: per-line prefix is what makes that unreachable rather than merely
#: discouraged: no body can emit an unprefixed line, so a forged heading stays
#: visibly inside the block that quoted it, and a blank line inside a body
#: cannot pass for the blank line between two sections.
QUOTE = ">"


def quoted(body: str) -> str:
    """A recalled body, fenced line by line. See `QUOTE`."""
    return "\n".join(f"{QUOTE} {line}" if line else QUOTE
                     for line in body.splitlines())
