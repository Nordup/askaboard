from dataclasses import dataclass

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

    Provider error bodies are not guaranteed well-formed, and an exception
    escaping here would turn a recoverable hiccup into a crashed turn. Every
    shape resolves to None rather than raising.
    """
    if not isinstance(body, dict):
        return None
    error = body.get("error")
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
