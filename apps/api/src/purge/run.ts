import { closePool } from '../db/pool.js';
import { closeDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { DIAGRAM_RETENTION_DAYS, DRAFT_RETENTION_HOURS, findAbandonedDraftIds, findExpiredDiagramIds, purgeExpiredDiagrams } from '../diagrams/diagram.service.js';
import { PROJECT_RETENTION_DAYS, findExpiredProjectIds, purgeExpiredProjects } from '../projects/project.service.js';

/**
 * Ops-run housekeeping script (jmuir-yvh) — physically deletes diagrams whose soft-delete
 * retention window (DIAGRAM_RETENTION_DAYS) has fully elapsed, then projects past
 * PROJECT_RETENTION_DAYS that no longer hold any diagrams or sub-projects (canvas-d3m). Deliberately a manually-invoked
 * script, not a scheduler/cron built into the app itself (Constitution VI; see
 * specs/002-editing-lifecycle-enhancements/research.md §1, which named exactly this as the
 * eventual mechanism). Run this periodically via whatever scheduling the deployment already has
 * — a cron entry, an Azure Container Apps Job on a timer trigger (mirroring modules/migrationjob.
 * bicep/seedjob.bicep's own manual-trigger job pattern, infra/azure/README.md) — the same way this
 * project already expects `npm run migrate`/`npm run seed` to be invoked from outside the app.
 *
 * Usage:
 *   npm run purge --workspace=@canvas/api             # physically deletes expired diagrams (and unsaved
 *                                                     # AI drafts over DRAFT_RETENTION_HOURS old), then projects
 *   npm run purge --workspace=@canvas/api -- --dry-run  # lists candidate ids, deletes nothing
 */
async function purge(): Promise<void> {
  await runMigrations();

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    listIds('[dry run] diagram(s) would be purged', 'diagrams', DIAGRAM_RETENTION_DAYS, await findExpiredDiagramIds());
    // canvas-j6v: Create with AI drafts never saved by their creator.
    const drafts = await findAbandonedDraftIds();
    console.log(`[dry run] ${drafts.length} unsaved AI draft(s) older than ${DRAFT_RETENTION_HOURS} hours would be purged${drafts.length ? `: ${drafts.join(', ')}` : '.'}`);
    // Without deleting the diagrams first, which expired projects would still be blocked can't be
    // known -- so this lists every candidate.
    listIds('[dry run] project(s) are candidates (purged only once they hold no diagrams or sub-projects)', 'projects', PROJECT_RETENTION_DAYS, await findExpiredProjectIds());
    return;
  }

  // Diagrams first: a project is only purged once no diagram rows point at it (canvas-d3m).
  const diagrams = await purgeExpiredDiagrams();
  listIds('Purged diagram(s)', 'diagrams', DIAGRAM_RETENTION_DAYS, diagrams.purgedDiagramIds);
  const projects = await purgeExpiredProjects();
  listIds('Purged project(s)', 'projects', PROJECT_RETENTION_DAYS, projects.purgedProjectIds);
  if (projects.skipped.length > 0) {
    console.log(`Skipped ${projects.skipped.length} expired project(s) still in use:`);
    for (const { id, reason } of projects.skipped) {
      console.log(`  ${id} (${reason})`);
    }
  }
}

function listIds(heading: string, noun: string, retentionDays: number, ids: string[]): void {
  if (ids.length === 0) {
    console.log(`No ${noun} past their ${retentionDays}-day retention window — nothing to purge.`);
    return;
  }
  console.log(`${heading} past their ${retentionDays}-day retention window: ${ids.length}`);
  for (const id of ids) {
    console.log(`  ${id}`);
  }
}

// canvas-jtm.6: findExpiredDiagramIds/purgeExpiredDiagrams are on Kysely, but runMigrations()
// (db/migrate.ts) deliberately stays on db/pool.ts's raw pg.Pool — a dependency-free migration
// runner is a permanent design choice (Constitution VI), not a conversion still pending — so both
// pools still need closing here.
purge()
  .then(() => Promise.all([closeDb(), closePool()]))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    return Promise.all([closeDb(), closePool()]);
  });
