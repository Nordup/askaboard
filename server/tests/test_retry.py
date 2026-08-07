import pytest

from app.tutor.retry import classify


@pytest.mark.parametrize("code", ["credit_balance_exhausted", "insufficient_quota"])
def test_billing_429s_are_never_retried(code):
    decision = classify(429, {"error": {"code": code}})
    assert decision.retry is False
    assert "billing" in decision.reason


def test_rate_limit_429_is_retried():
    assert classify(429, {"error": {"code": "rate_limit_exceeded"}}).retry is True


def test_bare_429_with_no_body_is_retried():
    assert classify(429, None).retry is True


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_server_errors_are_retried(status):
    assert classify(status, None).retry is True


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_client_errors_are_not_retried(status):
    assert classify(status, None).retry is False


def test_success_is_not_retried():
    assert classify(200, None).retry is False
