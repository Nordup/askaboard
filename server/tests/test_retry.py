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


# --- a failure that arrived with no status code ------------------------------
# The shape an `openai.APIError` raised out of the middle of a response stream
# has: the round's POST answered 200, so there is no status line anywhere, and
# the exception is not an `APIStatusError`. Every one of these used to reach the
# request handler's generic `except Exception` and be recorded as final.

#: Verbatim, minus the organization id: the message that ended two real turns.
IN_STREAM_RATE_LIMIT = (
    "Rate limit reached for gpt-5.6-luna in organization org-EXAMPLE0000 on "
    "tokens per min (TPM): Limit 200000, Used 164798, Requested 37409. Please "
    "try again in 662ms."
)


def test_an_in_stream_rate_limit_is_retried_off_its_message_alone():
    """The body carried no code and no type — the sentence was all there was,
    and it is the provider telling us when to try again."""
    decision = classify(None, {"message": IN_STREAM_RATE_LIMIT},
                        IN_STREAM_RATE_LIMIT)
    assert decision.retry is True
    assert decision.reason == "rate limited"


def test_an_in_stream_rate_limit_is_retried_off_the_exception_text_alone():
    """A body that is not a dict at all still leaves the exception's own
    message, which is what the caller passes."""
    assert classify(None, None, IN_STREAM_RATE_LIMIT).retry is True


@pytest.mark.parametrize("body", [
    {"code": "rate_limit_exceeded"},
    {"error": {"code": "rate_limit_exceeded"}},
    {"type": "tokens"},
    {"error": {"type": "requests"}},
])
def test_an_in_stream_rate_limit_is_retried_off_a_code_or_a_type(body):
    assert classify(None, body).retry is True


@pytest.mark.parametrize("code", sorted([
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
]))
def test_a_billing_error_with_no_status_is_still_final(code):
    """An exhausted account says the same thing however it is delivered.
    Retrying it is backoff a learner waits through for a refusal already made."""
    decision = classify(None, {"code": code, "message": "no credits"})
    assert decision.retry is False
    assert "billing" in decision.reason


@pytest.mark.parametrize("body", [
    None, {}, {"error": None}, {"error": {}}, {"error": "a bare string"},
    {"message": "the model produced an invalid tool call"},
])
def test_a_failure_with_no_status_and_no_marker_is_not_retried(body):
    """The default is what it always was. This branch only rescues a failure
    that says it is transient; anything else is treated as a bug in our own
    code, and telling a learner to retry into one is worse than saying it
    failed."""
    assert classify(None, body).retry is False


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
