import uuid
from datetime import timedelta
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# The only models a turn may name. `TurnRequest.model` arrives unvalidated
# from the device — without this, anyone holding the device token could
# request any model at any price, which is exactly the "no place to put a
# rate limit or a spend cap" gap this service exists to close (see
# server/README.md, Known limitations). Checked in
# app/api/turn.py:TurnRequest before any provider call.
MODEL_ALLOWLIST: frozenset[str] = frozenset({
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
})

# USD per 1M tokens, by model — what makes DAILY_SPEND_CAP_USD real. The
# recorder prices every turn from this table (`app/pricing.py`) and writes the
# dollar figure into `turns.cost_usd`, which `spend_today()` sums; a price cut
# is a one-line edit here. `cached_input` is the provider's discounted rate for
# prompt-cache hits, 10% of the input price across this family. There is no
# `reasoning` entry on purpose: the provider reports reasoning *inside*
# `output_tokens` and bills it at the output rate, so a separate rate would
# double-charge. Verified against the published rates on 2026-08-15 (these
# already include the July 30 Terra/Luna cuts).
MODEL_PRICES_PER_1M: dict[str, dict[str, float]] = {
    "gpt-5.6-sol":   {"input": 5.00, "cached_input": 0.50, "output": 30.00},
    "gpt-5.6-terra": {"input": 2.00, "cached_input": 0.20, "output": 12.00},
    "gpt-5.6-luna":  {"input": 0.20, "cached_input": 0.02, "output": 1.20},
}

# A model the device may name must have a price, or its spend goes back to
# being invisible — the exact gap the table closes. Checked at import for the
# reason `sanitize` runs at import in api/realtime.py: an allowlist edit that
# forgets the price row should fail the boot, not the month's bill.
_unpriced = MODEL_ALLOWLIST - set(MODEL_PRICES_PER_1M)
if _unpriced:
    raise ValueError(f"MODEL_PRICES_PER_1M is missing {sorted(_unpriced)}")

# USD per 1M tokens for the realtime voice models, priced per modality: the
# usage a voice response reports splits input and output into audio and text,
# and audio bills at a different order of magnitude. The device reports each
# response's counts to `POST /v1/realtime/usage` (the server never sees the
# data channel), and the recorder prices the row from this table. The cached
# rate is $0.40 for both modalities — 10% of text input, and the provider's
# own flat cache rate for audio.
REALTIME_PRICES_PER_1M: dict[str, dict[str, float]] = {
    "gpt-realtime-2.1": {
        "audio_input": 32.00, "cached_audio_input": 0.40, "audio_output": 64.00,
        "text_input": 4.00, "cached_text_input": 0.40, "text_output": 24.00,
    },
    # Verified against the published rates on 2026-08-16. Roughly a third of
    # the full model's audio, which is the whole reason the `Voice model`
    # setting exists.
    "gpt-realtime-2.1-mini": {
        "audio_input": 10.00, "cached_audio_input": 0.30, "audio_output": 20.00,
        "text_input": 0.60, "cached_text_input": 0.06, "text_output": 2.40,
    },
}

# The only realtime models the device may open a call on, and the only ones it
# may report usage against. Its own allowlist rather than MODEL_ALLOWLIST:
# these are a different provider family on a different price sheet, and a turn
# must never be able to name one.
#
# This is the narrow reversal of "the realtime model is server-chosen". The
# invariant was never "the device cannot name a model" — `TurnRequest.model`
# has always let it — but "the device cannot name a *price*". An allowlist
# every entry of which must be priced keeps that intact, and it is what lets
# `Voice model` in the settings window mean anything.
REALTIME_MODEL_ALLOWLIST: frozenset[str] = frozenset({
    "gpt-realtime-2.1", "gpt-realtime-2.1-mini",
})

# Same guard as MODEL_ALLOWLIST's, for the same reason: an allowlist edit that
# forgets the price row should fail the boot, not the month's bill.
_unpriced_realtime = REALTIME_MODEL_ALLOWLIST - set(REALTIME_PRICES_PER_1M)
if _unpriced_realtime:
    raise ValueError(f"REALTIME_PRICES_PER_1M is missing {sorted(_unpriced_realtime)}")

# The only reasoning efforts a turn may name, for the reason MODEL_ALLOWLIST
# exists — and it is the same reason, applied to the other half of the lever.
# `TurnRequest.reasoning_effort` arrives unvalidated from the device, and effort
# multiplies reasoning tokens, which bill at the *output* rate: six times input
# on Luna, and $30 per million on Sol. Gating the model and not the effort
# closes half of "any model at any price".
#
# It also stops a typo becoming a failed turn. An unknown effort string is a
# 400 from the provider mid-stream; a 422 from here says which values exist.
REASONING_EFFORT_ALLOWLIST: frozenset[str] = frozenset({
    "low", "medium", "high", "xhigh", "max",
})

# What a session gets when something other than a turn creates it — /v1/dictation
# and /v1/attachments, whose forms carry neither value. Both columns are NOT NULL,
# so a row has to be given something, and the next turn overwrites both with
# what the device actually has selected (see app/api/turn.py). These match the
# client's own defaults for a new session, so a session that begins with a
# dictation or an attachment is labelled with what would have answered it
# rather than with a sentinel.
DEFAULT_MODEL = "gpt-5.6-luna"
DEFAULT_REASONING_EFFORT = "high"

# There is one learner: me. Memory needs something to key on, and inventing an
# auth system to express "one person" would be ceremony. Every memory row
# carries this id, so adding real learners later is a data migration rather
# than a schema change.
SOLE_LEARNER_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")

# Deliberately not in MODEL_ALLOWLIST — that gates what the *device* may ask
# for on a turn. These are server-chosen and never arrive from a request, so
# the spend they represent is bounded by how often sessions close, not by what
# anyone puts in a request body.
EXTRACTION_MODEL = "gpt-5.6-luna"
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1024

# How many past sessions ride along in every prompt's RECENT SESSIONS block.
# Six, per the memory redesign: enough that "what did we do last week" answers
# from context without a tool call, small enough that the standing block stays
# a block and not an archive — the archive is what the search tools are for.
RECENT_SESSION_COUNT = 6

# Ceiling on the SAVED NOTES block, in characters — roughly a thousand tokens
# at four characters each. Notes are injected wholesale, never
# similarity-gated, so this is the one thing that stops a learner who saves
# fifty notes from paying for all of them on every turn: the oldest fall out
# of the block (an overflow line says how many), and `search_memory` still
# reaches them.
SAVED_NOTES_CHAR_CAP = 4_000

# The dense arm's relevance floor, as a maximum cosine distance. Rank-based
# fusion cannot say "nothing is relevant" on its own — with one atom on file
# there is always a rank 1 — so each arm carries its own bar: the sparse arm's
# is matching the query at all, and this is the dense arm's. A query nothing
# clears answers "Nothing on file about that.", which used to be unreachable
# once eight atoms existed. 0.7 sits between related pairs (~0.4–0.6 on this
# embedding model) and unrelated ones (~0.8 and up).
SEARCH_FLOOR_DISTANCE = 0.7

# How long a window of messages must sit silent before the standing block's
# backstop treats it as over. Only consulted when no current session is known
# to exclude (a turn always knows its own): a window the learner has switched
# away from is quiet the moment they leave it. Mirrors the write path's sweep
# threshold, so the two sides agree on when a window has closed.
WINDOW_QUIET_AFTER = timedelta(minutes=30)

# Ceiling on the raw-transcript tail the backstop injects when the latest
# window has no summary yet. Tail-biased — the end of a session is where "where
# did we stop" lives — and bounded because the block rides in every prompt
# until the summary lands.
BACKSTOP_TAIL_CHARS = 4_000

# One page of a stored transcript, as `get_session` serves it. Characters
# rather than tokens for the reason MAX_TRANSCRIPT_CHARS is: this runs on the
# request path and a token count is a round trip.
SESSION_PAGE_CHARS = 6_000

# What a learner may attach to a turn. Each of these is a refusal with a
# sentence the composer shows, never a silent truncation — a worksheet quietly
# cut off at page 20 is worse than one that was never accepted.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENTS_PER_TURN = 5
MAX_PDF_PAGES = 20
MAX_TEXT_CHARS = 100_000
#: The longest edge of the thumbnail the device stores and draws in the thread.
THUMBNAIL_MAX_EDGE = 256
#: The longest edge an uploaded photo is downscaled to before the model sees
#: it. A 12MP camera image costs tokens proportional to its pixels and carries
#: no more legible handwriting than this does.
IMAGE_MAX_EDGE = 2000


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str
    #: Upstream origin for the one provider call made with raw httpx rather
    #: than the SDK: the realtime SDP proxy (`api/realtime.py`). Env
    #: `OPENAI_BASE_URL` repoints it for a test or a relay; the SDK clients
    #: keep their own default and are not affected.
    openai_base_url: str = "https://api.openai.com/v1"
    #: The live-voice model a call falls back to, env `OPENAI_REALTIME_MODEL`.
    #: Only consulted when a call names no model of its own — the device names
    #: one from REALTIME_MODEL_ALLOWLIST on every call it opens.
    #:
    #: The mini, since 2026-08-16. This reverses the voice-mode design's founder
    #: decision (2026-08-15) that the default is always the full model, because
    #: the mini is weakest exactly where voice leans hardest — reliably calling
    #: `send_to_tutor` instead of ad-libbing an answer. Cost won: audio bills at
    #: $32/$64 per million on the full model against $10/$20 here. Matched to
    #: the client's own default so both sides of a call agree about what a
    #: session opens on.
    openai_realtime_model: str = "gpt-realtime-2.1-mini"
    #: The realtime voice, env `OPENAI_REALTIME_VOICE`. Locked once the model
    #: has produced audio, so it is chosen here, at session creation, only.
    #: `cedar` is the sleep app's own default, carried over on 2026-08-16.
    openai_realtime_voice: str = "cedar"
    database_url: str
    device_token: str
    blob_dir: Path = Path("./blobs")
    #: Where the rotating server log is written. Its own directory rather than
    #: a path, because the handler rotates into siblings (`server.log.1` and
    #: so on) and they should land together.
    log_dir: Path = Path("./logs")
    daily_spend_cap_usd: float = 5.0
    persist_dictation_audio: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
