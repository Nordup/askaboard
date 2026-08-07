"""The maths-recognition steering the transcription endpoint is told, and the
guard against writing a Whisper-family hallucination into a student's answer.

A server-side port of `DictationVocabulary` / `DictationSilence` from
`MathTutor/Services/OpenAITranscription.swift` (`docs/design-system/07-dictation.md`
§1.5-1.6). Preserved exactly rather than reinvented: both `KEYWORDS` and
`DICTATION_PROMPT` are the Swift constants verbatim, and `BOILERPLATE_SILENCE`
is the Swift `DictationSilence.boilerplate` set — not the shorter placeholder
sketched in this task's own brief, which would have narrowed the guard.
"""

from __future__ import annotations

# `07-dictation.md §1.1` / `1.5`, verbatim: "Keep each keyword on one line and
# don't include `<`, `>`, a carriage return, or a line feed. The API rejects
# the entire request when it encounters one of these characters." A whole-
# request rejection is the point — silently stripping a character would
# change what the recogniser was steered toward with nobody noticing, so this
# raises rather than sanitising by deletion.
FORBIDDEN = ("<", ">", "\r", "\n")


def sanitize(value: str) -> str:
    """A forbidden character rejects the whole request rather than being
    stripped.

    Silently dropping one changes what the recogniser was steered toward
    without anyone noticing. Nothing here comes from the student — `keywords`
    and `prompt` are both constants below — so this is a guard on a constant
    a future edit could break, not defence against user input.
    """
    if any(char in value for char in FORBIDDEN):
        raise ValueError(f"Value contains a forbidden character: {value!r}")
    return value


# The situation, and nothing else. Short on purpose: `prompt` is prepended to
# the model's context on every request, and a long one starts shaping the
# *wording* of the transcript rather than its spelling.
DICTATION_PROMPT = (
    "A student is thinking out loud about a maths problem for a tutor. "
    "Numbers and operations are spoken in words, not symbols."
)

# The terms themselves. One per entry, never a phrase list in a single
# string: the endpoint rejects the whole request over a stray newline.
KEYWORDS = [
    "sine", "cosine", "tangent", "theta", "pi", "squared", "cubed", "square root",
    "radical", "radicand", "exponent", "power", "numerator", "denominator",
    "fraction", "decimal", "percent", "ratio", "equation", "inequality",
    "expression", "coefficient", "variable", "constant", "integer", "factor",
    "factorise", "simplify", "substitute", "expand", "solve for x", "quotient",
    "remainder", "absolute value", "logarithm", "polynomial", "quadratic",
    "binomial", "vertex", "slope", "intercept", "axis", "origin", "coordinate",
    "vector", "angle", "degrees", "radians", "hypotenuse", "isosceles",
    "perpendicular", "parallel", "congruent", "perimeter", "circumference",
    "diameter", "radius", "area", "volume", "plus", "minus", "times", "divided by",
    "equals", "negative", "over", "therefore",
]

# Stated rather than detected. A mispredicted language on a four-word
# utterance is a total loss, and the docs note that an unreliable prediction
# comes back as `"languages": []`.
LANGUAGES = ["en"]

# Only applied under this length, which is long enough for the longest
# documented artefact ("Subtitles by the Amara.org community") and far short
# of a question. A fabrication longer than this is not something a phrase
# list can catch, and quietly deleting a real sentence would be far worse
# than showing one the student can edit.
BOILERPLATE_LIMIT = 60

# Whisper-family models fabricate on near-silent audio. A short boilerplate
# result must never be written into the composer as if the student said it.
# Compared against `_normalised(_)` output, so every entry here is already
# lowercase and free of punctuation.
BOILERPLATE_SILENCE = frozenset({
    "", "you", "thank you", "thanks", "thank you very much", "thanks for watching",
    "please subscribe", "subscribe", "bye", "bye bye",
    "subtitles by the amara org community", "subtitles by amara org", "amara org",
    "transcription by castingwords", "the end", "music", "applause", "laughter",
})


def _normalised(transcript: str) -> str:
    """Lowercased, stripped of punctuation, whitespace collapsed — the
    documented hallucinations vary in casing and trailing stops."""
    stripped = "".join(char if char.isalnum() else " " for char in transcript.lower())
    return " ".join(stripped.split())


def is_silence(transcript: str) -> bool:
    """Whether a finished transcript is really nothing.

    `isEmpty` is not a sufficient guard: a child who taps the mic, hesitates,
    and taps again can plausibly receive "Thank you." — grammatical,
    confident, and entirely fabricated.
    """
    trimmed = transcript.strip()
    if len(trimmed) > BOILERPLATE_LIMIT:
        return False
    return _normalised(trimmed) in BOILERPLATE_SILENCE
