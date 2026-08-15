"""What a turn — or a voice response — actually cost, in dollars.

Every number in here is pinned against the price table in `app/config.py`
on purpose: the table is what makes `DAILY_SPEND_CAP_USD` real, and a wrong
formula here is a cap that trips at the wrong dollar. Prices verified against
the provider's published rates on 2026-08-15 (post the July 30 cut).
"""

import pytest

from app.config import (
    MODEL_ALLOWLIST, MODEL_PRICES_PER_1M, REALTIME_MODEL_ALLOWLIST,
    REALTIME_PRICES_PER_1M, Settings,
)
from app.pricing import realtime_cost_usd, turn_cost_usd


def test_every_allowlisted_model_has_a_price():
    """A model the device may name must have a price, or its spend is
    invisible again — the exact gap this table exists to close."""
    assert MODEL_ALLOWLIST <= set(MODEL_PRICES_PER_1M)


def test_the_default_realtime_model_has_a_price():
    assert Settings.model_fields["openai_realtime_model"].default in (
        REALTIME_PRICES_PER_1M
    )


def test_a_luna_turn_costs_input_plus_output():
    cost = turn_cost_usd(
        "gpt-5.6-luna",
        {"input_tokens": 1_000_000, "output_tokens": 1_000_000},
    )
    assert cost == pytest.approx(0.20 + 1.20)


def test_cached_input_bills_at_the_discounted_rate():
    """The cache-hit share of the prompt bills at 10% of the input price,
    not zero and not full price."""
    cost = turn_cost_usd(
        "gpt-5.6-luna",
        {
            "input_tokens": 9_800,
            "output_tokens": 100,
            "input_tokens_details": {"cached_tokens": 9_216},
        },
    )
    expected = (584 * 0.20 + 9_216 * 0.02 + 100 * 1.20) / 1_000_000
    assert cost == pytest.approx(expected)


def test_reasoning_tokens_are_not_billed_twice():
    """The provider reports reasoning *inside* `output_tokens` and bills it at
    the output rate. Adding `reasoning_tokens` on top would double-charge —
    the formula must read `output_tokens` alone."""
    cost = turn_cost_usd(
        "gpt-5.6-sol",
        {
            "input_tokens": 24_294,
            "output_tokens": 4_314,
            "output_tokens_details": {"reasoning_tokens": 467},
        },
    )
    expected = (24_294 * 5.00 + 4_314 * 30.00) / 1_000_000
    assert cost == pytest.approx(expected)


def test_a_terra_turn_uses_terra_prices():
    cost = turn_cost_usd(
        "gpt-5.6-terra", {"input_tokens": 1_000_000, "output_tokens": 1_000_000}
    )
    assert cost == pytest.approx(2.00 + 12.00)


def test_empty_usage_prices_to_none():
    """A turn that reported nothing measured nothing. None is the truth;
    0.0 would be a measurement — same rule as `cache_tokens`."""
    assert turn_cost_usd("gpt-5.6-luna", {}) is None


def test_an_unpriced_model_prices_to_none():
    """No price on file must never guess a dollar figure."""
    assert turn_cost_usd("gpt-9-experimental", {"input_tokens": 5}) is None


def test_a_cached_count_larger_than_the_input_is_clamped():
    """`cached_tokens` is a subset of `input_tokens`. A malformed report that
    claims more must not produce a negative uncached share."""
    cost = turn_cost_usd(
        "gpt-5.6-luna",
        {
            "input_tokens": 100,
            "output_tokens": 0,
            "input_tokens_details": {"cached_tokens": 200},
        },
    )
    assert cost == pytest.approx(100 * 0.02 / 1_000_000)


def test_realtime_cost_prices_audio_and_text_with_their_cached_discounts():
    cost = realtime_cost_usd(
        "gpt-realtime-2.1",
        audio_input_tokens=1_000_000,
        cached_audio_input_tokens=500_000,
        audio_output_tokens=250_000,
        text_input_tokens=100_000,
        cached_text_input_tokens=50_000,
        text_output_tokens=10_000,
    )
    expected = (
        500_000 * 32.00       # uncached audio in
        + 500_000 * 0.40      # cached audio in
        + 250_000 * 64.00     # audio out
        + 50_000 * 4.00       # uncached text in
        + 50_000 * 0.40       # cached text in
        + 10_000 * 24.00      # text out
    ) / 1_000_000
    assert cost == pytest.approx(expected)


def test_realtime_cost_of_a_silent_response_is_zero():
    """A usage event full of zeros is a measurement, unlike a turn with no
    usage at all — the response happened and cost nothing."""
    cost = realtime_cost_usd(
        "gpt-realtime-2.1",
        audio_input_tokens=0,
        cached_audio_input_tokens=0,
        audio_output_tokens=0,
        text_input_tokens=0,
        cached_text_input_tokens=0,
        text_output_tokens=0,
    )
    assert cost == 0.0


def test_an_unpriced_realtime_model_prices_to_none():
    assert realtime_cost_usd(
        "gpt-realtime-99",
        audio_input_tokens=1_000,
        cached_audio_input_tokens=0,
        audio_output_tokens=1_000,
        text_input_tokens=0,
        cached_text_input_tokens=0,
        text_output_tokens=0,
    ) is None


def test_every_selectable_realtime_model_has_a_price_row():
    """The invariant the `Voice model` setting rests on.

    `config.py` enforces this at import — an allowlist edit that forgets the
    price fails the boot — and this states it where a reader looking for it
    will find it. Without the price row a call would run, bill real money, and
    write a row with a NULL cost: spend the daily cap cannot see.
    """
    for model in sorted(REALTIME_MODEL_ALLOWLIST):
        assert model in REALTIME_PRICES_PER_1M, model
        assert set(REALTIME_PRICES_PER_1M[model]) == {
            "audio_input", "cached_audio_input", "audio_output",
            "text_input", "cached_text_input", "text_output",
        }


def test_the_mini_is_the_cheaper_choice_in_every_modality():
    """What makes the setting a cost lever rather than a preference.

    If a future price edit made Mini dearer in any modality, the row's caption
    — "Cheaper, less reliable" — would be a lie on screen.
    """
    full = REALTIME_PRICES_PER_1M["gpt-realtime-2.1"]
    mini = REALTIME_PRICES_PER_1M["gpt-realtime-2.1-mini"]
    for modality, price in full.items():
        assert mini[modality] < price, modality
