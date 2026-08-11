import httpx
import pytest

from app.tutor.retry import (
    FALLBACK_RETRY_DELAY, MAX_RETRY_DELAY, classify, retry_delay,
)


@pytest.mark.parametrize("code", [
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
])
def test_billing_429s_are_never_retried(code):
    decision = classify(429, {"error": {"code": code}})
    assert decision.retry is False
    assert "billing" in decision.reason


def test_rate_limit_429_is_retried():
    assert classify(429, {"error": {"code": "rate_limit_exceeded"}}).retry is True


@pytest.mark.parametrize("code", [
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
])
def test_billing_429s_are_never_retried_when_the_body_is_already_unwrapped(code):
    # openai's own exception handling already unwraps the response body's
    # "error" key onto APIStatusError.body before classify() ever sees it, so
    # a caller passing that attribute through hands us {"code": ...} directly
    # rather than {"error": {"code": ...}}. Both shapes must classify the same.
    decision = classify(429, {"code": code, "message": "no credits"})
    assert decision.retry is False
    assert "billing" in decision.reason


def test_rate_limit_429_is_retried_when_the_body_is_already_unwrapped():
    assert classify(429, {"code": "rate_limit_exceeded"}).retry is True


def test_bare_429_with_no_body_is_retried():
    assert classify(429, None).retry is True


@pytest.mark.parametrize("body", [
    None,
    {},
    {"error": None},
    {"error": {}},
    {"error": "a bare string"},
    {"error": {"code": None}},
])
def test_malformed_429_bodies_are_retried_not_crashed(body):
    # All malformed shapes should be treated as retryable, never raise an exception.
    assert classify(429, body).retry is True


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_server_errors_are_retried(status):
    assert classify(status, None).retry is True


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_client_errors_are_not_retried(status):
    assert classify(status, None).retry is False


def test_success_is_not_retried():
    assert classify(200, None).retry is False


# --- retry_delay ------------------------------------------------------------
# Moved here from `app/api/dictation.py` when `run_turn` grew a retry of its
# own. Both callers want the same answer, and it had no test in either place.

def _response(header: str | None) -> httpx.Response:
    headers = {} if header is None else {"Retry-After": header}
    return httpx.Response(429, headers=headers)


def test_a_usable_retry_after_is_honoured():
    assert retry_delay(_response("3")) == 3.0
    assert retry_delay(_response(" 2.5 ")) == 2.5


def test_a_provider_asking_for_longer_than_a_learner_waits_is_capped():
    assert retry_delay(_response("600")) == MAX_RETRY_DELAY


@pytest.mark.parametrize("header", [None, "", "soon", "0", "-5", "NaN", "nan", "-inf"])
def test_every_unusable_header_falls_back_rather_than_raising(header):
    """A malformed header is the provider having a bad day, which is exactly
    when this must keep working."""
    assert retry_delay(_response(header)) == FALLBACK_RETRY_DELAY
