const DEFAULT_JWT_SECRET = 'dev-solax-secret-change-me';
const APP_TIME_ZONE = process.env.TZ || 'Asia/Tashkent';

process.env.TZ = APP_TIME_ZONE;

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalised = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalised)) {
    return false;
  }

  return fallback;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const configuredPort = toInt(process.env.PORT, 4000);
const configuredHost = (process.env.HOST || '0.0.0.0').trim();
const configuredPublicUrl =
  trimTrailingSlash(process.env.PUBLIC_URL) || `http://localhost:${configuredPort}`;

export const config = Object.freeze({
  timeZone: APP_TIME_ZONE,
  port: configuredPort,
  host: configuredHost,
  publicUrl: configuredPublicUrl,
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  databasePath: process.env.DATABASE_PATH || './solax_data.sqlite',
  superAdminUsername: (process.env.SUPER_ADMIN_USERNAME || 'superadmin').trim().toLowerCase(),
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe123!',
  superAdminName: (process.env.SUPER_ADMIN_NAME || 'Super Admin').trim(),
  superAdminTelegramIds: toList(process.env.SUPER_ADMIN_TELEGRAM_ID),
  telegramBotEnabled: toBool(process.env.TELEGRAM_BOT_ENABLED, true),
  telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramWebAppUrl: trimTrailingSlash(process.env.TELEGRAM_WEB_APP_URL) || '',
  telegramInitDataTtl: toInt(process.env.TELEGRAM_INIT_DATA_TTL, 86400),
  telegramBotPollingTimeoutSeconds: Math.max(
    1,
    toInt(process.env.TELEGRAM_BOT_POLLING_TIMEOUT_SECONDS, 25),
  ),
  telegramBotRetryDelayMs: Math.max(1000, toInt(process.env.TELEGRAM_BOT_RETRY_DELAY_MS, 3000)),
  deviceSyncSourcePath: (process.env.DEVICE_SYNC_SOURCE_PATH || './db/devices.json').trim(),
  deviceSyncIntervalMs: Math.max(60000, toInt(process.env.DEVICE_SYNC_INTERVAL_MS, 60000)),
  solaxRealtimeTokenId: (process.env.SOLAX_REALTIME_TOKEN_ID || process.env.SOLAX_TOKEN_ID || '').trim(),
  solaxRealtimeApiUrl: (
    process.env.SOLAX_REALTIME_API_URL ||
    'https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do'
  ).trim(),
  solaxRealtimeSyncEnabled: toBool(process.env.SOLAX_REALTIME_SYNC_ENABLED, true),
  solaxRealtimeSyncIntervalMs: Math.max(
    60000,
    toInt(process.env.SOLAX_REALTIME_SYNC_INTERVAL_MS, 3600000),
  ),
  solaxRealtimeRequestDelayMs: Math.max(0, toInt(process.env.SOLAX_REALTIME_REQUEST_DELAY_MS, 6500)),
  solaxRealtimeRequestTimeoutMs: Math.max(
    5000,
    toInt(process.env.SOLAX_REALTIME_REQUEST_TIMEOUT_MS, 15000),
  ),
  solaxRealtimeOnlineThresholdMs: Math.max(
    60000,
    toInt(process.env.SOLAX_REALTIME_ONLINE_THRESHOLD_MS, 30 * 60 * 1000),
  ),
  solaxRealtimeRunOnStart: toBool(process.env.SOLAX_REALTIME_RUN_ON_START, false),
  isDefaultJwtSecret: !process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET,
  isDefaultSuperAdminPassword:
    !process.env.SUPER_ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD === 'ChangeMe123!',
});
