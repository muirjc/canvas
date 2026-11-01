from fastapi.testclient import TestClient


def test_health_matches_the_typescript_service(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_every_response_carries_the_typescript_services_security_headers(client: TestClient) -> None:
    """apps/api's onSend hook sets these on every response; the Python service does too (it will be the
    front door in phase 10). Errors included."""
    for response in (client.get("/health"), client.get("/projects"), client.get("/no-such-route")):
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["referrer-policy"] == "same-origin"
