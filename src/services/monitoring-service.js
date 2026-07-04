import { getDb } from '../db.js';
import { config } from '../config.js';
import { toTashkentDate } from './device-service.js';
import { getConnectedClients } from './sse-service.js';
import { getDeviceSyncState } from './device-sync-service.js';
import { getSolaxRealtimeSyncState } from './solax-realtime-sync-service.js';
import { getDailyReportSchedulerState } from './daily-report-service.js';

function getDbStats() {
  const db = getDb();

  const tableStats = {};
  const tables = ['app_users', 'devices', 'daily_stats', 'device_status_history', 'monthly_summary', 'user_devices', 'daily_reports', 'alerts'];

  for (const table of tables) {
    try {
      const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
      tableStats[table] = count;
    } catch {
      tableStats[table] = -1;
    }
  }

  // DB file size
  let dbSize = 0;
  try {
    const result = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
    dbSize = result?.size || 0;
  } catch {
    // ignore
  }

  // WAL mode
  let journalMode = 'unknown';
  try {
    const result = db.prepare("PRAGMA journal_mode").get();
    journalMode = result?.journal_mode || 'unknown';
  } catch {
    // ignore
  }

  return {
    tables: tableStats,
    totalRows: Object.values(tableStats).reduce((sum, count) => sum + Math.max(0, count), 0),
    dbSizeBytes: dbSize,
    dbSizeMB: Math.round(dbSize / (1024 * 1024) * 100) / 100,
    journalMode,
  };
}

function getDeviceHealth() {
  const db = getDb();
  const today = toTashkentDate();

  const statusCounts = db
    .prepare(`
      SELECT onlineStatus, COUNT(*) as count
      FROM devices
      GROUP BY onlineStatus
    `)
    .all();

  const modelCounts = db
    .prepare(`
      SELECT deviceModel, COUNT(*) as count
      FROM devices
      WHERE deviceModel IS NOT NULL AND deviceModel != ''
      GROUP BY deviceModel
      ORDER BY count DESC
      LIMIT 10
    `)
    .all();

  const sourceCounts = db
    .prepare(`
      SELECT source, COUNT(*) as count
      FROM devices
      GROUP BY source
    `)
    .all();

  const recentSync = db
    .prepare(`
      SELECT DATE(snapshotMinute) as date, COUNT(DISTINCT registrationNo) as devices
      FROM device_status_history
      WHERE DATE(snapshotMinute) >= DATE(?, '-7 days')
      GROUP BY DATE(snapshotMinute)
      ORDER BY date DESC
      LIMIT 7
    `)
    .all(today);

  const topProducers = db
    .prepare(`
      SELECT
        d.registrationNo,
        d.deviceName,
        d.plantName,
        d.deviceModel,
        d.onlineStatus,
        d.ratedPower,
        COALESCE(ds.yieldToday, 0) as yieldToday
      FROM devices d
      LEFT JOIN daily_stats ds ON ds.registrationNo = d.registrationNo AND ds.date = ?
      ORDER BY yieldToday DESC
      LIMIT 5
    `)
    .all(today);

  return {
    statusCounts: Object.fromEntries(statusCounts.map((r) => [r.onlineStatus, r.count])),
    modelCounts,
    sourceCounts: Object.fromEntries(sourceCounts.map((r) => [r.source, r.count])),
    recentSync,
    topProducers,
  };
}

function getSystemHealth() {
  const memory = process.memoryUsage();
  const uptime = process.uptime();

  return {
    uptime: Math.round(uptime),
    uptimeFormatted: formatUptime(uptime),
    memory: {
      rss: Math.round(memory.rss / 1024 / 1024),
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
      external: Math.round(memory.external / 1024 / 1024),
    },
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    sseClients: getConnectedClients(),
  };
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

export function getMonitoringDashboard() {
  return {
    generatedAt: new Date().toISOString(),
    config: {
      port: config.port,
      host: config.host,
      timeZone: config.timeZone,
      telegramEnabled: config.telegramBotEnabled,
      solaxRealtimeEnabled: config.solaxRealtimeSyncEnabled,
      solaxRealtimeInterval: config.solaxRealtimeSyncIntervalMs,
      dailyReportEnabled: config.reportEodEnabled,
      dailyReportTime: config.reportEodTime,
    },
    system: getSystemHealth(),
    database: getDbStats(),
    devices: getDeviceHealth(),
    services: {
      deviceSync: getDeviceSyncState(),
      solaxRealtimeSync: getSolaxRealtimeSyncState(),
      dailyReport: getDailyReportSchedulerState(),
    },
  };
}

export function getSystemAlerts() {
  const db = getDb();
  const alerts = [];
  const today = toTashkentDate();

  // 1. DB hajmi katta bo'lsa
  try {
    const result = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
    if (result?.size > 500 * 1024 * 1024) {
      alerts.push({
        level: 'warning',
        type: 'db_size',
        message: `DB hajmi ${(result.size / 1024 / 1024).toFixed(0)} MB — tozalash kerak`,
      });
    }
  } catch { /* ignore */ }

  // 2. Offlayn qurilmalar ko'p bo'lsa
  const offlineCount = db.prepare("SELECT COUNT(*) as c FROM devices WHERE onlineStatus != 'Online'").get().c;
  const totalCount = db.prepare("SELECT COUNT(*) as c FROM devices").get().c;
  if (totalCount > 0 && offlineCount / totalCount > 0.5) {
    alerts.push({
      level: 'warning',
      type: 'offline_devices',
      message: `${offlineCount}/${totalCount} qurilma offlayn`,
    });
  }

  // 3. Sync yangilanmagan bo'lsa
  const lastSync = db.prepare("SELECT MAX(snapshotMinute) as last FROM device_status_history").get();
  if (lastSync?.last) {
    const lastSyncTime = new Date(lastSync.last);
    const hoursAgo = (Date.now() - lastSyncTime.getTime()) / (1000 * 60 * 60);
    if (hoursAgo > 2) {
      alerts.push({
        level: 'critical',
        type: 'sync_stale',
        message: `Oxirgi sync ${Math.round(hoursAgo)} soat oldin — sinxronizatsiya to'xtagan`,
      });
    }
  }

  // 4. JWT_SECRET default
  if (config.isDefaultJwtSecret) {
    alerts.push({
      level: 'critical',
      type: 'default_secret',
      message: 'JWT_SECRET default qiymatda — xavfsizlik xavfi',
    });
  }

  // 5. Super admin parol default
  if (config.isDefaultSuperAdminPassword) {
    alerts.push({
      level: 'critical',
      type: 'default_password',
      message: 'Super admin paroli default — darhol o\'zgartiring',
    });
  }

  return alerts;
}
