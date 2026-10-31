from fastapi.testclient import TestClient


def test_health_matches_the_typescript_service(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
