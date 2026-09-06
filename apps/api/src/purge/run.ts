import { closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { DIAGRAM_RETENTION_DAYS, findExpiredDiagramIds, purgeExpiredDiagrams } from '../diagrams/diagram.service.js';

/**
 * Ops-run housekeeping script (jmuir-yvh) — physically deletes diagrams whose soft-delete
 * retention window (DIAGRAM_RETENTION_DAYS) has fully elapsed. Deliberately a manually-invoked
 * script, not a scheduler/cron built into the app itself (Constitution VI; see
 * specs/002-editing-lifecycle-enhancements/research.md §1, which named exactly this as the
 * eventual mechanism). Run this periodically via whatever scheduling the deployment already has
 * — a cron entry, an Azure Container Apps Job on a timer trigger (mirroring modules/migrationjob.
 * bicep/seedjob.bicep's own manual-trigger job pattern, infra/azure/README.md) — the same way this
 * project already expects `npm run migrate`/`npm run seed` to be invoked from outside the app.
 *
 * Usage:
 *   npm run purge --workspace=@canvas/api             # physically deletes expired diagrams
 *   npm run purge --workspace=@canvas/api -- --dry-run  # lists candidate ids, deletes nothing
 */
async function purge(): Promise<void> {
  await runMigrations();

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    const ids = await findExpiredDiagramIds();
    if (ids.length === 0) {
      console.log(`No diagrams past their ${DIAGRAM_RETENTION_DAYS}-day retention window — nothing to purge.`);
      return;
    }
    console.log(`[dry run] ${ids.length} diagram(s) would be purged (past their ${DIAGRAM_RETENTION_DAYS}-day retention window):`);
    for (const id of ids) {
      console.log(`  ${id}`);
    }
    return;
  }

  const result = await purgeExpiredDiagrams();
  if (result.purgedDiagramIds.length === 0) {
    console.log(`No diagrams past their ${DIAGRAM_RETENTION_DAYS}-day retention window — nothing to purge.`);
    return;
  }
  console.log(`Purged ${result.purgedDiagramIds.length} diagram(s) past their ${DIAGRAM_RETENTION_DAYS}-day retention window:`);
  for (const id of result.purgedDiagramIds) {
    console.log(`  ${id}`);
  }
}

purge()
  .then(() => closePool())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    return closePool();
  });
