import math
from dataclasses import dataclass

import httpx

#: How many times a retryable failure may be retried before it is reported.
#:
#: Here rather than in one caller because both retrying paths want the same
#: answer: `/v1/dictation` opening a transcription stream, and `run_turn`
#: opening a round. `classify` already lives here for the same reason — a
#: second copy of either decision is a second thing to keep in step.
RETRY_LIMIT = 2

#: What to wait when the provider sends no usable `Retry-After`.
FALLBACK_RETRY_DELAY = 1.0

#: A provider asking for longer than the learner will wait is a failure, not
#: a pause — `OpenAITranscriptionClient.retryDelay(from:)`.
MAX_RETRY_DELAY = 10.0


def retry_delay(response: httpx.Response) -> float:
    """How long to wait before the next attempt, from `Retry-After`.

    Every unusable header shape — absent, unparseable, zero, negative, or not
    a finite number — resolves to `FALLBACK_RETRY_DELAY` rather than raising. A
    malformed header is the provider having a bad day, which is the moment this
    function most needs to keep working.

    `math.isfinite` is doing real work, not being tidy. `float("nan")` parses,
    and `nan <= 0` is False, so a `Retry-After: NaN` used to reach
    `min(nan, MAX_RETRY_DELAY)` — which returns `nan`, because every comparison
    against it is False — and from there `asyncio.sleep(nan)`. The retry that
    was meant to recover the turn would have been where it stopped.
    """
    header = response.headers.get("Retry-After")
    if header is None:
        return FALLBACK_RETRY_DELAY
    try:
        seconds = float(header.strip())
    except ValueError:
        return FALLBACK_RETRY_DELAY
    if not math.isfinite(seconds) or seconds <= 0:
        return FALLBACK_RETRY_DELAY
    return min(seconds, MAX_RETRY_DELAY)

# The first four come from OpenAITranscription.swift's terminalBillingCodes.
# insufficient_quota is a real provider code that predates Swift's set.
# A code the Swift client knows but this file does not would be retried in
# production — the learner watches a thinking indicator through backoff sleeps
# before failing at an exhausted account.
BILLING_ERROR_CODES = frozenset({
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
})


@dataclass(frozen=True)
class RetryDecision:
    retry: bool
    reason: str


def _error_code(body: dict | None) -> str | None:
    """Extract the provider's error code from a body of any shape.

    Accepts both the raw response shape, `{"error": {"code": ...}}`, and the
    already-unwrapped shape, `{"code": ...}`. openai's own exception handling
    unwraps the response body's "error" key onto APIStatusError.body before
    classify() ever sees it (see openai._client._make_status_error), so a
    caller passing that attribute straight through hands us the unwrapped
    form. Handling both here — rather than requiring a caller to rewrap —
    means this file has no dependency on that SDK internal continuing to
    unwrap exactly as it does today.

    Provider error bodies are not guaranteed well-formed, and an exception
    escaping here would turn a recoverable hiccup into a crashed turn. Every
    shape resolves to None rather than raising.
    """
    if not isinstance(body, dict):
        return None
    error = body.get("error", body)
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


def classify(status_code: int, body: dict | None) -> RetryDecision:
    if status_code == 429:
        code = _error_code(body)
        if code in BILLING_ERROR_CODES:
            return RetryDecision(False, f"billing error {code} is final")
        return RetryDecision(True, "rate limited")
    if 500 <= status_code < 600:
        return RetryDecision(True, f"server error {status_code}")
    return RetryDecision(False, f"status {status_code} is not retryable")
