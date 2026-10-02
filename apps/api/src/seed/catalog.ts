import { fileURLToPath } from 'node:url';
import { closePool } from '../db/pool.js';
import { closeDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { seedDiagramTypes } from './diagram-types.seed.js';
import { seedLibraries } from './libraries.seed.js';
import { seedAiPersonas } from './ai-personas.seed.js';

/**
 * Seeds reference/lookup data only: the full built-in DiagramType catalog, the bundled Icon/Shape
 * Libraries, and the default AiPersona per architect category. All three are idempotent catalog
 * data (upsert or check-then-insert, never a published credential or demo content) that every
 * environment needs to be usable at all — a fresh database with no DiagramType rows can't create
 * a diagram. Deliberately separate from run.ts's own dev/demo seed (which also creates a
 * published-local-password admin account and a demo project), so a clean environment build can
 * run this unconditionally without also provisioning throwaway accounts.
 */
export async function seedCatalog(): Promise<void> {
  await runMigrations();
  await seedDiagramTypes();
  await seedLibraries();
  await seedAiPersonas();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  seedCatalog()
    .then(() => {
      console.log('Catalog seed complete (DiagramTypes, Icon/Shape Libraries, AiPersonas).');
      return Promise.all([closeDb(), closePool()]);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
      return Promise.all([closeDb(), closePool()]);
    });
}
