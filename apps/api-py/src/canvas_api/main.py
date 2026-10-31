"""Entry point for uvicorn: `uvicorn canvas_api.main:app`."""

from canvas_api.app import create_app

app = create_app()
