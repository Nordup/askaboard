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

#: What a rate limit calls itself when there is no status code to read it off.
#:
#: A 429 says it in the status line and nothing else is needed. An error
#: delivered *inside* a response stream has no status line at all — the request
#: succeeded, and the refusal arrives as an SSE `error` event minutes later — so
#: the only thing naming it is the body the provider put in that event. These
#: are the values seen in `code` and in `type`.
RATE_LIMIT_ERROR_CODES = frozenset({
    "rate_limit_exceeded",
    "rate_limit",
    "tokens",
    "requests",
})

#: What the provider's own trouble calls itself, delivered the same way.
#:
#: Here so the two paths agree. `classify` reads any 5xx as retryable, and a
#: provider failing on its own account inside a stream is the same event
#: arriving through a door with no status line on it — a verdict that depended
#: on which door it came through would be a bug that only shows up in the
#: column nobody reads.
SERVER_ERROR_CODES = frozenset({
    "server_error",
    "internal_error",
    "internal_server_error",
    "service_unavailable",
})

#: The same fact, as the provider writes it in prose.
#:
#: Read only when neither `code` nor `type` says anything, because a body is not
#: guaranteed to carry either: the turn that produced this file's in-stream
#: branch arrived as a bare message — "Rate limit reached for … on tokens per
#: min (TPM): Limit 200000, Used 164798, Requested 37409. Please try again in
#: 662ms." — and was recorded as final. A provider telling us when to try again
#: is a provider telling us to try again.
#:
#: The cost of reading this wrong in either direction is small and unequal. A
#: false positive is one retry the learner did not need; a false negative is a
#: transient hiccup presented to a child as a dead end.
_RATE_LIMIT_PHRASES = ("rate limit", "rate_limit", "too many requests")


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


def _error_field(body: dict | None, key: str) -> str | None:
    """One string field off a provider error body of either shape.

    The companion to `_error_code`, and it accepts the same two shapes for the
    same reason. `type` and `message` are what is left to read when the code is
    absent, which is the ordinary case for an error delivered inside a stream.
    """
    if not isinstance(body, dict):
        return None
    error = body.get("error", body)
    if not isinstance(error, dict):
        return None
    value = error.get(key)
    return value if isinstance(value, str) else None


def _reads_as_rate_limit(text: str | None) -> bool:
    if not text:
        return False
    lowered = text.lower()
    return any(phrase in lowered for phrase in _RATE_LIMIT_PHRASES)


def _without_status(body: dict | None, message: str | None) -> RetryDecision:
    """Whether to retry a failure that never carried a status code.

    The whole of this branch exists for one shape: an `openai.APIError` raised
    out of the middle of a response stream. The round's `POST` answered 200, the
    stream opened, and the refusal arrived as an SSE `error` event — so there is
    no status line, the exception is not an `APIStatusError`, and every caller
    that reached for `.status_code` found nothing there.

    Billing first, exactly as the 429 branch does it: an exhausted account
    says the same thing however it is delivered, and retrying it is backoff a
    learner waits through for a refusal that was already final.
    """
    code = _error_code(body)
    if code in BILLING_ERROR_CODES:
        return RetryDecision(False, f"billing error {code} is final")
    kind = _error_field(body, "type")
    if code in RATE_LIMIT_ERROR_CODES or kind in RATE_LIMIT_ERROR_CODES:
        return RetryDecision(True, "rate limited")
    if code in SERVER_ERROR_CODES or kind in SERVER_ERROR_CODES:
        return RetryDecision(True, f"server error {code or kind}")
    if _reads_as_rate_limit(message) or _reads_as_rate_limit(
        _error_field(body, "message")
    ):
        return RetryDecision(True, "rate limited")
    return RetryDecision(False, "no status, and nothing saying it is retryable")


def classify(
    status_code: int | None, body: dict | None, message: str | None = None
) -> RetryDecision:
    """Whether a provider failure is worth trying again.

    `status_code` is `None` for a failure that arrived without one — see
    `_without_status`. `message` is the exception's own text, read only in that
    case and only when the body names nothing.
    """
    if status_code is None:
        return _without_status(body, message)
    if status_code == 429:
        code = _error_code(body)
        if code in BILLING_ERROR_CODES:
            return RetryDecision(False, f"billing error {code} is final")
        return RetryDecision(True, "rate limited")
    if 500 <= status_code < 600:
        return RetryDecision(True, f"server error {status_code}")
    return RetryDecision(False, f"status {status_code} is not retryable")
