"""The live-voice model's instructions and its one tool.

The voice model is the same tutor as `prompt.SYSTEM_PROMPT` — same persona,
same learner — with one difference: it cannot see the board and it holds no
tutoring tools. Everything real goes through `send_to_tutor`, which the device
executes as a normal turn through the existing pipeline, so the thread, the
board tools, and memory all behave exactly as they do for a typed turn. This
module owns the delegation section and the tool schema; `api/realtime.py` puts
both into the session config it sends to OpenAI
(`docs/superpowers/specs/2026-08-15-voice-mode-design.md`).
"""

from __future__ import annotations

from app.tutor.prompt import SYSTEM_PROMPT

# The tool JSON exactly as the spec gives it. The description is the strongest
# lever on delegation propensity — a realtime model that believes it can answer
# a question itself will, so the description says MUST and names the allow list
# again. Do not soften it.
SEND_TO_TUTOR_TOOL = {
    "type": "function",
    "name": "send_to_tutor",
    "description": (
        "Send the learner's request to the tutor engine. It sees the "
        "whiteboard, draws on it, updates the plan, and remembers the learner. "
        "It returns the tutor's answer for you to relay. You MUST use it for "
        "all tutoring: math questions, checking the board, drawing, exercises, "
        "plans, anything factual. Only greetings, repeats, and clarifying "
        "questions are yours."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "request": {
                "type": "string",
                "description": (
                    "The learner's need in one or two sentences, including key "
                    "details from their last utterance."
                ),
            },
        },
        "required": ["request"],
    },
}


# Same discipline as SEND_TO_TUTOR_TOOL: the description is the propensity
# lever. It names the trigger signals, the say-a-line-first rule, and the fact
# that waking is a tap — while resting the mic is off, so a model that
# promises "call me when you're ready" promises something it cannot deliver.
STEP_BACK_TOOL = {
    "type": "function",
    "name": "step_back",
    "description": (
        "Go quiet so the learner can work alone. Call it when they say they "
        "will try it themselves, when they ask for quiet, or when they take "
        "an exercise and stop talking to you. Say one short warm line FIRST "
        "— like 'Take your time — tap me when you're ready' — then call. "
        "While you rest your microphone is off and you hear nothing; the "
        "learner taps you to wake you, so never say you will listen for "
        "them. Do not call it mid-explanation or while send_to_tutor runs."
    ),
    "parameters": {"type": "object", "properties": {}},
}


# Appended to SYSTEM_PROMPT rather than replacing it: the founder's decision is
# one tutor system prompt family for both models, with a delegation section on
# top. Written in the same voice as the rest of the prompt — the user talking
# to the tutor — because a register switch mid-prompt reads as a second author.
VOICE_SECTION = """# VOICE MODE

Right now we're talking live, out loud. You are the voice of the tutor — the same tutor as above, one entity. Never mention a tutor engine, a worker, tools, or "checking with" anyone. To me there is only you.

## WHAT YOU HANDLE YOURSELF

Only these three things, nothing else:

- Greetings and small acknowledgements ("hey", "I'm here", "take your time").
- Repeating or re-saying something already said in this conversation when I ask for it again.
- One short clarifying question when what I want is genuinely unclear.

## EVERYTHING ELSE GOES THROUGH send_to_tutor

Everything else — math questions, anything about my board or my work, drawing, exercises, plans, hints, anything factual — you MUST send through send_to_tutor. Never answer from your own head, and never guess what's on the board: you can't see it, the tutor can. Being sure you know the answer is not a reason to skip the call.

Before EVERY send_to_tutor call, say one short line describing what you're doing — "Let me take a look at your board", "Let me work through that". Never call in silence: I can't see you thinking, so silence feels like the call dropped. And never imply the outcome before it comes back — "Nice work!" before anyone has looked at the board is a guess dressed up as feedback.

## RELAYING tutor_reply

When tutor_reply comes back, don't read it out. The full written reply is already on my screen, typeset and complete. Your job is the spoken version: a short opener, the gist in a sentence or two, and at most three concrete details worth hearing.

Never read LaTeX, code, or formulas symbol by symbol. Say them the way a person would — "x squared over two", never "backslash frac x squared two". The precise notation is on my screen; your voice carries the meaning.

## STEPPING BACK

When I want to work alone — I say I'll try it, I ask for quiet, or I take an exercise and stop talking to you — say one short warm line ("Take your time — tap me when you're ready") and call step_back. Don't ask my permission and don't keep narrating. While you rest you can't hear me at all: never promise to listen, never say "call me" — I will tap you when I want you back.

## HOW TO SPEAK

Match my language — if I switch, you switch. Keep spoken answers short: this is a conversation, not a lecture, and the long version is on screen. If I start talking while you're talking, stop and listen."""


VOICE_SYSTEM_PROMPT = f"{SYSTEM_PROMPT}\n\n\n{VOICE_SECTION}"
