from httpx import ASGITransport, AsyncClient

from app.main import create_app


async def test_health_returns_ok():
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_health_survives_an_unreadable_backlog():
    """No lifespan here, so there is no engine and the backlog cannot be read.

    Which is the case worth pinning: liveness must still answer "ok". A health
    check that fails because a *memory* counter is unavailable reports an
    outage the service is not having.
    """
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "memory": {
            "unextracted_episodes": None,
            "oldest_unextracted_age_seconds": None,
        },
    }
