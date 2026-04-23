import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { hashPassword } from './utils/password.js';

let dbInstance;

function getBackendRoot() {
  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), '..');
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function getColumnNames(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = getColumnNames(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function createCoreTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      displayName TEXT,
      telegramId TEXT UNIQUE,
      telegramUsername TEXT,
      telegramPhotoUrl TEXT,
      authProvider TEXT NOT NULL DEFAULT 'local',
      passwordHash TEXT,
      passwordSalt TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      createdBy INTEGER,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lastLoginAt DATETIME,
      lastTelegramAuthAt DATETIME,
      permissions TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_app_users_role ON app_users(role);
    CREATE INDEX IF NOT EXISTS idx_app_users_auth_provider ON app_users(authProvider);
    CREATE INDEX IF NOT EXISTS idx_app_users_telegram_id ON app_users(telegramId);

    CREATE TABLE IF NOT EXISTS role_change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      previousRole TEXT,
      nextRole TEXT NOT NULL,
      changedBy INTEGER NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedBy TEXT,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ensureColumn(db, 'app_users', 'displayName', 'displayName TEXT');
  ensureColumn(db, 'app_users', 'telegramId', 'telegramId TEXT');
  ensureColumn(db, 'app_users', 'telegramUsername', 'telegramUsername TEXT');
  ensureColumn(db, 'app_users', 'telegramPhotoUrl', 'telegramPhotoUrl TEXT');
  ensureColumn(db, 'app_users', 'authProvider', "authProvider TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, 'app_users', 'status', "status TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'app_users', 'createdBy', 'createdBy INTEGER');
  ensureColumn(db, 'app_users', 'updatedAt', "updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
  ensureColumn(db, 'app_users', 'lastTelegramAuthAt', 'lastTelegramAuthAt DATETIME');
  ensureColumn(db, 'app_users', 'permissions', "permissions TEXT NOT NULL DEFAULT '[]'");
}

function createMonitoringTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      userName TEXT PRIMARY KEY,
      plantName TEXT,
      addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS devices (
      registrationNo TEXT PRIMARY KEY,
      deviceSn TEXT,
      userName TEXT,
      plantName TEXT,
      deviceModel TEXT,
      telegramIds TEXT NOT NULL DEFAULT '[]',
      onlineStatus TEXT NOT NULL DEFAULT 'Unknown',
      lastSeenAt DATETIME,
      lastCheckedAt DATETIME,
      addedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deviceNo INTEGER,
      deviceName TEXT,
      source TEXT NOT NULL DEFAULT 'scraped',
      trackingEnabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(onlineStatus);
    CREATE INDEX IF NOT EXISTS idx_devices_source ON devices(source);
    CREATE INDEX IF NOT EXISTS idx_devices_device_no ON devices(deviceNo);

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registrationNo TEXT,
      type TEXT,
      message TEXT,
      isRead INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_registration_no ON alerts(registrationNo);
    CREATE INDEX IF NOT EXISTS idx_alerts_is_read ON alerts(isRead);

    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registrationNo TEXT,
      date TEXT,
      yieldToday REAL DEFAULT 0,
      yieldTotal REAL DEFAULT 0,
      acPower REAL DEFAULT 0,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(registrationNo, date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_stats_registration_no ON daily_stats(registrationNo, date DESC);

    CREATE TABLE IF NOT EXISTS monthly_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registrationNo TEXT,
      month TEXT,
      totalYield REAL DEFAULT 0,
      avgYield REAL DEFAULT 0,
      maxYield REAL DEFAULT 0,
      activeDays INTEGER DEFAULT 0,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(registrationNo, month)
    );

    CREATE INDEX IF NOT EXISTS idx_monthly_summary_registration_no ON monthly_summary(registrationNo, month DESC);

    CREATE TABLE IF NOT EXISTS device_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registrationNo TEXT NOT NULL,
      snapshotMinute DATETIME NOT NULL,
      onlineStatus TEXT NOT NULL DEFAULT 'Unknown',
      lastSeenAt DATETIME,
      lastCheckedAt DATETIME,
      deviceSn TEXT,
      userName TEXT,
      plantName TEXT,
      deviceModel TEXT,
      telegramIds TEXT NOT NULL DEFAULT '[]',
      deviceName TEXT,
      deviceNo INTEGER,
      source TEXT,
      trackingEnabled INTEGER NOT NULL DEFAULT 1,
      acPower REAL,
      yieldToday REAL,
      yieldTotal REAL,
      realtimeUpdatedAt DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(registrationNo, snapshotMinute)
    );

    CREATE INDEX IF NOT EXISTS idx_device_status_history_registration_minute
      ON device_status_history(registrationNo, snapshotMinute DESC);
    CREATE INDEX IF NOT EXISTS idx_device_status_history_snapshot_minute
      ON device_status_history(snapshotMinute DESC);
  `);

  ensureColumn(db, 'devices', 'deviceNo', 'deviceNo INTEGER');
  ensureColumn(db, 'devices', 'deviceName', 'deviceName TEXT');
  ensureColumn(db, 'devices', "telegramIds", "telegramIds TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'devices', "source", "source TEXT NOT NULL DEFAULT 'scraped'");
  ensureColumn(db, 'devices', 'trackingEnabled', 'trackingEnabled INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'devices', 'acPower', 'acPower REAL');
  ensureColumn(db, 'devices', 'yieldToday', 'yieldToday REAL');
  ensureColumn(db, 'devices', 'yieldMonth', 'yieldMonth REAL');
  ensureColumn(db, 'devices', 'yieldYear', 'yieldYear REAL');
  ensureColumn(db, 'devices', 'yieldTotal', 'yieldTotal REAL');
  ensureColumn(db, 'devices', 'realtimeUpdatedAt', 'realtimeUpdatedAt DATETIME');
  ensureColumn(db, 'device_status_history', "telegramIds", "telegramIds TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'device_status_history', 'acPower', 'acPower REAL');
  ensureColumn(db, 'device_status_history', 'yieldToday', 'yieldToday REAL');
  ensureColumn(db, 'device_status_history', 'yieldTotal', 'yieldTotal REAL');
  ensureColumn(db, 'device_status_history', 'realtimeUpdatedAt', 'realtimeUpdatedAt DATETIME');
  ensureColumn(db, 'alerts', 'isRead', 'isRead INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'alerts', 'createdAt', 'createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
}

function migrateLegacyAdmins(db) {
  if (!tableExists(db, 'admin_users')) {
    return 0;
  }

  const appUserCount = db.prepare('SELECT COUNT(*) AS count FROM app_users').get().count;
  if (appUserCount > 0) {
    return 0;
  }

  const legacyAdmins = db.prepare(`
    SELECT username, passwordHash, passwordSalt, role, lastLoginAt, createdAt
    FROM admin_users
    ORDER BY id ASC
  `).all();

  const insertStatement = db.prepare(`
    INSERT INTO app_users (
      username,
      displayName,
      authProvider,
      passwordHash,
      passwordSalt,
      role,
      status,
      createdAt,
      updatedAt,
      lastLoginAt
    )
    VALUES (?, ?, 'local', ?, ?, ?, 'active', COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP, ?)
  `);

  let migratedCount = 0;

  for (const legacyAdmin of legacyAdmins) {
    const username = String(legacyAdmin.username || '').trim().toLowerCase();
    if (!username) {
      continue;
    }

    const existingUser = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username);
    if (existingUser) {
      continue;
    }

    const role = legacyAdmin.role === 'super_admin' ? 'super_admin' : 'admin';
    insertStatement.run(
      username,
      legacyAdmin.username,
      legacyAdmin.passwordHash,
      legacyAdmin.passwordSalt,
      role,
      legacyAdmin.createdAt,
      legacyAdmin.lastLoginAt,
    );
    migratedCount += 1;
  }

  return migratedCount;
}

function ensureSuperAdmin(db) {
  const existingSuperAdmin = db
    .prepare("SELECT id, username, passwordHash FROM app_users WHERE role = 'super_admin' LIMIT 1")
    .get();

  if (existingSuperAdmin) {
    return {
      created: false,
      promoted: false,
      username: existingSuperAdmin.username,
    };
  }

  const existingNamedUser = db
    .prepare('SELECT id, username, passwordHash FROM app_users WHERE username = ?')
    .get(config.superAdminUsername);

  if (existingNamedUser) {
    let passwordHash = existingNamedUser.passwordHash;
    let passwordSalt = null;

    if (!existingNamedUser.passwordHash) {
      const passwordParts = hashPassword(config.superAdminPassword);
      passwordHash = passwordParts.hash;
      passwordSalt = passwordParts.salt;
    }

    db.prepare(`
      UPDATE app_users
      SET
        displayName = ?,
        role = 'super_admin',
        authProvider = CASE
          WHEN authProvider = 'telegram' THEN 'hybrid'
          ELSE authProvider
        END,
        passwordHash = COALESCE(?, passwordHash),
        passwordSalt = COALESCE(?, passwordSalt),
        updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(config.superAdminName, passwordHash, passwordSalt, existingNamedUser.id);

    return {
      created: false,
      promoted: true,
      username: config.superAdminUsername,
    };
  }

  const passwordParts = hashPassword(config.superAdminPassword);

  db.prepare(`
    INSERT INTO app_users (
      username,
      displayName,
      authProvider,
      passwordHash,
      passwordSalt,
      role,
      status,
      createdAt,
      updatedAt
    )
    VALUES (?, ?, 'local', ?, ?, 'super_admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    config.superAdminUsername,
    config.superAdminName,
    passwordParts.hash,
    passwordParts.salt,
  );

  return {
    created: true,
    promoted: false,
    username: config.superAdminUsername,
  };
}

function bootstrapDatabase(db) {
  createCoreTables(db);
  createMonitoringTables(db);
  const migratedCount = migrateLegacyAdmins(db);
  const superAdminState = ensureSuperAdmin(db);

  if (migratedCount > 0) {
    console.log(`[bootstrap] ${migratedCount} ta eski admin app_users jadvaliga ko'chirildi.`);
  }

  if (superAdminState.created) {
    console.log(`[bootstrap] Super admin yaratildi: ${superAdminState.username}`);
  } else if (superAdminState.promoted) {
    console.log(`[bootstrap] ${superAdminState.username} super admin roliga ko'tarildi.`);
  }

  if (config.isDefaultSuperAdminPassword) {
    console.warn('[bootstrap] Super admin default parol bilan turibdi. Uni darhol almashtiring.');
  }
}

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const databaseFilePath = path.resolve(getBackendRoot(), config.databasePath);
  mkdirSync(path.dirname(databaseFilePath), { recursive: true });
  dbInstance = new Database(databaseFilePath);
  dbInstance.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
  `);

  bootstrapDatabase(dbInstance);
  return dbInstance;
}
