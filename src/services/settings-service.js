import { getDb } from '../db.js';

export function getSetting(key, fallbackValue = null) {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(String(key));

  return row?.value ?? fallbackValue;
}

export function setSetting(key, value, { updatedBy = null } = {}) {
  const cleanKey = String(key || '').trim();

  if (!cleanKey) {
    throw new Error('Setting key bosh bo\'lmasligi kerak');
  }

  getDb()
    .prepare(`
      INSERT INTO app_settings (key, value, updatedBy, updatedAt)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updatedBy = excluded.updatedBy,
        updatedAt = CURRENT_TIMESTAMP
    `)
    .run(cleanKey, String(value), updatedBy ? String(updatedBy) : null);

  return getSetting(cleanKey);
}
