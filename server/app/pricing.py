"""Token counts in, dollars out — the arithmetic behind `spend_today()`.

Both functions return None for a model with no price row rather than guessing:
a NULL `cost_usd` is a visible gap someone can query for, a made-up rate is a
cap that trips at the wrong dollar. The prices live in `app.config` so a price
change never touches this file.
"""

from __future__ import annotations

import logging

from app.config import MODEL_PRICES_PER_1M, REALTIME_PRICES_PER_1M

logger = logging.getLogger(__name__)


def turn_cost_usd(model: str, usage: dict) -> float | None:
    """Price one turn's usage dict, as the provider reported it.

    Empty usage prices to None, not 0.0 — same rule as `cache_tokens`: a turn
    that reported nothing measured nothing, and zero would be a measurement.

    `output_tokens` already contains the reasoning tokens (the provider bills
    reasoning at the output rate and reports it inside the total, with
    `output_tokens_details.reasoning_tokens` as a breakdown), so reasoning is
    deliberately not priced separately here — that would double-charge. Gemini
    reports its thinking the same way, inside `output_tokens`, so the rule holds
    across both families.

    Not every charge is a token, which is why the last term is a count and not a
    rate: grounding with Google Search bills per search request, and a turn that
    reported only searches still cost money. `{"grounding_tool_count": 3}` is
    not an empty usage dict, so it prices past the guard above.
    """
    prices = MODEL_PRICES_PER_1M.get(model)
    if prices is None:
        logger.warning("no price row for model %s; cost_usd stays NULL", model)
        return None
    if not usage:
        return None

    input_tokens = usage.get("input_tokens") or 0
    output_tokens = usage.get("output_tokens") or 0
    # A subset of `input_tokens`; clamped so a malformed report can never
    # produce a negative uncached share.
    cached = min(
        (usage.get("input_tokens_details") or {}).get("cached_tokens") or 0,
        input_tokens,
    )
    # Not a token rate, and not divided by a million. Grounding bills per
    # search request, so this term is a count times a price. Absent on the
    # OpenAI rows, where it reads as zero rather than raising.
    searches = usage.get("grounding_tool_count") or 0
    search_cost = searches * prices.get("per_search", 0.0)

    return (
        (input_tokens - cached) * prices["input"]
        + cached * prices["cached_input"]
        + output_tokens * prices["output"]
    ) / 1_000_000 + search_cost


def realtime_cost_usd(
    model: str,
    *,
    audio_input_tokens: int,
    cached_audio_input_tokens: int,
    audio_output_tokens: int,
    text_input_tokens: int,
    cached_text_input_tokens: int,
    text_output_tokens: int,
) -> float | None:
    """Price one voice response's usage event, per modality.

    All-zero counts price to 0.0, not None: unlike a turn with no usage dict,
    a zero-filled usage event is a measurement — the response happened and
    cost nothing. The cached counts are subsets of their input totals and are
    clamped for the same reason `turn_cost_usd` clamps.
    """
    prices = REALTIME_PRICES_PER_1M.get(model)
    if prices is None:
        logger.warning("no realtime price row for model %s; cost_usd stays NULL", model)
        return None

    cached_audio = min(cached_audio_input_tokens, audio_input_tokens)
    cached_text = min(cached_text_input_tokens, text_input_tokens)
    return (
        (audio_input_tokens - cached_audio) * prices["audio_input"]
        + cached_audio * prices["cached_audio_input"]
        + audio_output_tokens * prices["audio_output"]
        + (text_input_tokens - cached_text) * prices["text_input"]
        + cached_text * prices["cached_text_input"]
        + text_output_tokens * prices["text_output"]
    ) / 1_000_000
