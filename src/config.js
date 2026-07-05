const DEFAULT_JWT_SECRET = 'dev-solax-secret-change-me';
const APP_TIME_ZONE = process.env.TZ || 'Asia/Tashkent';

process.env.TZ = APP_TIME_ZONE;

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(value ?? '');
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
  payloadEncryptionEnabled: toBool(process.env.PAYLOAD_ENCRYPTION_ENABLED, false),
  payloadEncryptionKey: (process.env.PAYLOAD_ENCRYPTION_KEY || '').trim(),
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
  // "Online" oynasi: qurilma shu vaqt ichida SolaX'ga ma'lumot yuklagan bo'lsa online.
  // 40-60 daqiqa oralig'i SolaX Cloud'ning online sanog'iga aynan mos keladi
  // (polling kechikishini hisobga olib 45 daqiqa - barqaror "plato" markazi).
  solaxRealtimeOnlineThresholdMs: Math.max(
    60000,
    toInt(process.env.SOLAX_REALTIME_ONLINE_THRESHOLD_MS, 45 * 60 * 1000),
  ),
  solaxRealtimeRunOnStart: toBool(process.env.SOLAX_REALTIME_RUN_ON_START, false),
  // Circuit breaker: ketma-ket N ta nosozlikdan keyin SolaX'ga ulanishni M vaqtga to'xtatamiz
  solaxCircuitFailureThreshold: Math.max(1, toInt(process.env.SOLAX_CIRCUIT_FAILURE_THRESHOLD, 5)),
  solaxCircuitOpenMs: Math.max(30000, toInt(process.env.SOLAX_CIRCUIT_OPEN_MS, 5 * 60 * 1000)),
  // Gap detection: ma'lumot bo'shlig'ini aniqlash (oxirgi yig'ilishdan shuncha o'tsa gap deb belgilaymiz)
  syncGapDetectionEnabled: toBool(process.env.SYNC_GAP_DETECTION_ENABLED, true),
  syncGapMinMs: Math.max(60000, toInt(process.env.SYNC_GAP_MIN_MS, 15 * 60 * 1000)),
  // Quvvat keskin tushishi haqida ogohlantirish (egasi + adminlarga)
  powerDropAlertEnabled: toBool(process.env.POWER_DROP_ALERT_ENABLED, true),
  powerDropRatio: Math.min(1, Math.max(0.1, toFloat(process.env.POWER_DROP_RATIO, 0.6))),
  powerDropMinKw: Math.max(0, toFloat(process.env.POWER_DROP_MIN_KW, 1)),
  powerDropRatedFraction: Math.min(1, Math.max(0, toFloat(process.env.POWER_DROP_RATED_FRACTION, 0.15))),
  powerDropCooldownMinutes: Math.max(5, toInt(process.env.POWER_DROP_COOLDOWN_MINUTES, 180)),
  // Oldingi o'lchov shundan eski bo'lsa (bo'shliq) — "keskin tushish" deб hisoblamaymiz,
  // chunki ketma-ket bo'lmagan ikki o'lchovni solishtirish noto'g'ri (soxta ogohlantirish).
  powerDropMaxGapMinutes: Math.max(2, toInt(process.env.POWER_DROP_MAX_GAP_MINUTES, 20)),
  powerDropActiveStartHour: Math.min(23, Math.max(0, toInt(process.env.POWER_DROP_ACTIVE_START_HOUR, 9))),
  powerDropActiveEndHour: Math.min(24, Math.max(1, toInt(process.env.POWER_DROP_ACTIVE_END_HOUR, 17))),
  reportEodEnabled: toBool(process.env.REPORT_EOD_ENABLED, true),
  reportEodTime: /^\d{2}:\d{2}$/.test((process.env.REPORT_EOD_TIME || '').trim())
    ? (process.env.REPORT_EOD_TIME || '').trim()
    : '23:55',
  isDefaultJwtSecret: !process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET,
  isDefaultSuperAdminPassword:
    !process.env.SUPER_ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD === 'ChangeMe123!',
});
