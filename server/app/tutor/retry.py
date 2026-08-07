from dataclasses import dataclass

# Ported from OpenAITranscription.swift, which already draws this line correctly:
# a spend problem is final, and retrying it only makes the learner wait longer
# for the same failure.
BILLING_ERROR_CODES = frozenset({
    "credit_balance_exhausted",
    "insufficient_quota",
    "billing_hard_limit_reached",
    "billing_not_active",
})


@dataclass(frozen=True)
class RetryDecision:
    retry: bool
    reason: str


def classify(status_code: int, body: dict | None) -> RetryDecision:
    if status_code == 429:
        code = ((body or {}).get("error") or {}).get("code")
        if code in BILLING_ERROR_CODES:
            return RetryDecision(False, f"billing error {code} is final")
        return RetryDecision(True, "rate limited")
    if 500 <= status_code < 600:
        return RetryDecision(True, f"server error {status_code}")
    return RetryDecision(False, f"status {status_code} is not retryable")
