import type { Db, DbClient } from '../db/pool.ts';

/**
 * Согласие устройства без аккаунта (O-260817-15, `0007_analytics_device.sql`).
 * Параллель `users.analytics_opt_in`, только ключ — deviceId, не userId.
 */

export async function getDeviceConsent(db: Db | DbClient, deviceId: string): Promise<boolean> {
  const { rows } = await db.query<{ opt_in: boolean }>(
    'SELECT opt_in FROM analytics_device_consent WHERE device_id = $1',
    [deviceId],
  );
  return rows[0]?.opt_in ?? false;
}

export async function setDeviceConsent(
  db: Db | DbClient,
  deviceId: string,
  optIn: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO analytics_device_consent (device_id, opt_in, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (device_id) DO UPDATE SET opt_in = $2, updated_at = now()`,
    [deviceId, optIn],
  );
}
