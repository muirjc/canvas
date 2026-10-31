import pytest

from canvas_api.telemetry import route_template


@pytest.mark.parametrize(
    ("fastapi_path", "expected"),
    [
        ("/health", "/health"),
        ("/diagrams/{id}", "/diagrams/:id"),
        ("/diagrams/{diagram_id}/versions/{version_id}/restore", "/diagrams/:diagram_id/versions/:version_id/restore"),
        ("/files/{path:path}", "/files/:path"),
    ],
)
def test_span_names_use_the_typescript_route_form(fastapi_path: str, expected: str) -> None:
    assert route_template(fastapi_path) == expected


def test_telemetry_is_off_without_a_connection_string() -> None:
    from fastapi import FastAPI

    from canvas_api.telemetry import configure_telemetry

    assert configure_telemetry(FastAPI(), None) is False
