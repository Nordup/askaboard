import uuid
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
