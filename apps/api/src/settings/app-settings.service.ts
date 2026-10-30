import { getDb } from '../db/client.js';
import { currentTimestamp, dbBoolean, fromDbBoolean } from '../db/sql-helpers.js';

/** canvas-8em: platform-wide feature switches, read by every signed-in user's client. */
export interface AppSettings {
  /** Whether the editor shows the Share button. Sharing keeps working underneath either way. */
  sharingEnabled: boolean;
}

export async function getAppSettings(): Promise<AppSettings> {
  const row = await getDb().selectFrom('app_settings').select('sharing_enabled').executeTakeFirstOrThrow();
  return { sharingEnabled: fromDbBoolean(row.sharing_enabled) };
}

export async function setAppSettings(input: Partial<AppSettings>): Promise<AppSettings> {
  await getDb()
    .updateTable('app_settings')
    .set({
      sharing_enabled: input.sharingEnabled === undefined ? undefined : dbBoolean(input.sharingEnabled),
      updated_at: currentTimestamp(),
    })
    .execute();
  return getAppSettings();
}
