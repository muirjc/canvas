"""Seeds the reference catalog after running the migrations (apps/api/src/seed/catalog.ts): diagram types,
reference standards, icon/shape libraries, AI personas. Idempotent; see canvas_api/seed/.

Usage: python -m canvas_api.jobs.seed_catalog
       (DATABASE_URL, DB_CLIENT, SESSION_SECRET; optional AWS_ICONS_MANIFEST)
"""

from __future__ import annotations

import sys
import traceback

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.seed import seed_catalog


def main() -> int:
    settings = Settings()  # type: ignore[call-arg]  # read from the environment
    engine = create_db_engine(settings)
    try:
        seed_catalog(engine)
    except Exception:
        # TypeScript prints the error (with its stack) and exits 1.
        traceback.print_exc()
        return 1
    finally:
        engine.dispose()
    print("Catalog seed complete (DiagramTypes, reference Standards, Icon/Shape Libraries, AiPersonas).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
