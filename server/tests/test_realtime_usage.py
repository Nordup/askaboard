"""`POST /v1/realtime/usage` — the device reporting what a voice response cost.

Split from `test_realtime_route.py` on purpose: that file pins the SDP proxy's
no-database property, and this endpoint is exactly the route that writes. The
wire contract under test: the device mints `report_id`, sends the six token
counts from a `response.done` usage event, and names the realtime model the
call ran on. The model is gated by REALTIME_MODEL_ALLOWLIST and every entry
there must be priced, so the device chooses from a priced menu and still
cannot name a price. A body with no model is priced from the server's setting.
"""

import math
import uuid

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.config import get_settings
from app.main import create_app
from app.store.models import RealtimeUsage, Session, Turn
from tests.conftest import requires_db

AUTH = {"Authorization": "Bearer test-token"}


def _report(**overrides):
    body = {
        "report_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "response_id": "resp_abc123",
        "audio_input_tokens": 100_000,
        "cached_audio_input_tokens": 40_000,
        "audio_output_tokens": 50_000,
        "text_input_tokens": 10_000,
        "cached_text_input_tokens": 5_000,
        "text_output_tokens": 2_000,
    }
    body.update(overrides)
    return body


async def test_missing_device_token_is_rejected():
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as client:
        response = await client.post("/v1/realtime/usage", json=_report())
    assert response.status_code == 401


@requires_db
async def test_a_report_lands_as_a_priced_row(db_app, db_factory):
    """A body that names no model is priced from the server's setting — what a
    client that predates the `Voice model` setting sends."""
    report = _report()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post("/v1/realtime/usage", json=report, headers=AUTH)

    assert response.status_code == 200
    async with db_factory() as db:
        row = (await db.execute(select(RealtimeUsage))).scalar_one()
        assert row.id == uuid.UUID(report["report_id"])
        assert row.session_id == uuid.UUID(report["session_id"])
        assert row.model == get_settings().openai_realtime_model
        assert row.cost_usd is not None
        assert row.cost_usd > 0


@requires_db
async def test_a_mini_call_bills_against_the_mini_price_sheet(db_app, db_factory):
    """The point of letting the device name the model.

    Same counts, a third of the cost. Pricing a Mini call from the server's
    configured Full model would hide the whole saving the setting exists to
    produce — the row would say the learner spent Full money on a Mini minute.
    """
    report = _report(model="gpt-realtime-2.1-mini")
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post("/v1/realtime/usage", json=report, headers=AUTH)

    assert response.status_code == 200
    async with db_factory() as db:
        row = (await db.execute(select(RealtimeUsage))).scalar_one()
        assert row.model == "gpt-realtime-2.1-mini"
        # 60k fresh audio in @ $10 + 40k cached @ $0.30 + 50k audio out @ $20
        # + 5k fresh text in @ $0.60 + 5k cached @ $0.06 + 2k text out @ $2.40
        expected = (
            60_000 * 10.00 + 40_000 * 0.30 + 50_000 * 20.00
            + 5_000 * 0.60 + 5_000 * 0.06 + 2_000 * 2.40
        ) / 1_000_000
        assert math.isclose(row.cost_usd, expected, rel_tol=1e-9)


@requires_db
async def test_a_model_off_the_allowlist_is_refused(db_app, db_factory):
    """The device picks from a priced menu; it does not invent an entry.

    A 422 loses one usage row. Accepting the name would write a row priced
    from a table with no entry for it — a money row with a NULL cost, which
    is spend the daily cap cannot see.

    Needs the database fixture even though nothing should reach the database:
    FastAPI resolves `get_recorder` before it validates the body, so a bare
    `create_app()` fails on the missing engine rather than on the model. The
    row count below is what proves the refusal actually wrote nothing.
    """
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/realtime/usage", json=_report(model="gpt-4o-mini-realtime"), headers=AUTH
        )
    assert response.status_code == 422
    async with db_factory() as db:
        assert (await db.execute(select(RealtimeUsage))).first() is None


@requires_db
async def test_a_retried_report_bills_once(db_app, db_factory):
    """A device that never heard the 200 sends the same report again. Two
    200s, one row — `report_id` is the idempotency key."""
    report = _report()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        first = await client.post("/v1/realtime/usage", json=report, headers=AUTH)
        second = await client.post("/v1/realtime/usage", json=report, headers=AUTH)

    assert first.status_code == 200
    assert second.status_code == 200
    async with db_factory() as db:
        rows = (await db.execute(select(RealtimeUsage))).scalars().all()
        assert len(rows) == 1


@requires_db
async def test_voice_spend_trips_the_turn_cap(db_app):
    """The whole point of the table: a day of voice alone must 402 the next
    turn. On 2026-08-15 voice was ~$4.70 of a $7 day and the cap saw $0.00."""
    cap = get_settings().daily_spend_cap_usd
    # Enough audio output alone to clear the cap at $64/1M.
    over_cap = math.ceil(cap * 1_000_000 / 64.00) + 1_000
    report = _report(
        audio_input_tokens=0, cached_audio_input_tokens=0,
        text_input_tokens=0, cached_text_input_tokens=0, text_output_tokens=0,
        audio_output_tokens=over_cap,
    )
    turn = {
        "turn_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "text": "check my work",
        "model": "gpt-5.6-luna",
        "reasoning_effort": "high",
    }

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        posted = await client.post("/v1/realtime/usage", json=report, headers=AUTH)
        assert posted.status_code == 200
        response = await client.post("/v1/turn", json=turn, headers=AUTH)

    assert response.status_code == 402


@requires_db
async def test_an_overlong_response_id_is_clipped_not_refused(db_app, db_factory):
    """`response_id` is a diagnostic back-reference. Refusing a report over
    its length would drop a money row because a trace id grew a prefix."""
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/realtime/usage",
            json=_report(response_id="resp_" + "x" * 100), headers=AUTH,
        )

    assert response.status_code == 200
    async with db_factory() as db:
        row = (await db.execute(select(RealtimeUsage))).scalar_one()
        assert len(row.response_id) == 64
        assert row.response_id.startswith("resp_")


@requires_db
async def test_negative_counts_are_rejected(db_app):
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/realtime/usage",
            json=_report(audio_output_tokens=-5), headers=AUTH,
        )
    assert response.status_code == 422
