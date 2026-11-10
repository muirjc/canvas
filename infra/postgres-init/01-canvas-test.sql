-- Run by the Postgres image the first time docker compose starts it (an empty data volume only):
-- the Python tests' database (apps/api-py/tests/conftest.py, schema canvas_py inside it).
CREATE DATABASE canvas_test OWNER canvas;
