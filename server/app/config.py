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
