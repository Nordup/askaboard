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

# What a session gets when something other than a turn creates it — today only
# /v1/dictation, whose form carries neither value. Both columns are NOT NULL,
# so a row has to be given something, and the next turn overwrites both with
# what the device actually has selected (see app/api/turn.py). These match the
# client's own defaults for a new session, so a dictation-first session is
# labelled with what would have answered it rather than with a sentinel.
DEFAULT_MODEL = "gpt-5.6-luna"
DEFAULT_REASONING_EFFORT = "high"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str
    database_url: str
    device_token: str
    blob_dir: Path = Path("./blobs")
    daily_spend_cap_usd: float = 5.0
    persist_dictation_audio: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
