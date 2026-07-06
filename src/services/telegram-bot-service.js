import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { config } from '../config.js';
import { getDb } from '../db.js';
import {
  getSolaxRealtimeSyncState,
  getSyncLiveProgress,
  runSolaxRealtimeSyncNow,
  setSolaxRealtimeSyncIntervalMs,
} from './solax-realtime-sync-service.js';
import { areDevicesVisibleToAll } from './device-service.js';
import { getHealthSnapshot } from './user-service.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_PARSE_MODE = 'HTML';
const TELEGRAM_WEB_APP_FULLSCREEN_PARAM = 'tgFullscreen';
const DEVICE_PAGE_SIZE = 6;
const SEARCH_RESULT_LIMIT = 8;
const SESSION_TTL_MS = 10 * 60 * 1000;

const BUTTONS = Object.freeze({
  HOME: 'Bosh menyu',
  SYNC_SETTINGS: 'Quvvat sync sozlash',
  WEB_APP: 'Veb-ilova',
});

const BOT_COMMANDS = [
  { command: 'start', description: 'Botni ishga tushirish' },
  { command: 'sync', description: 'Quvvat sync sozlamalari' },
  { command: 'interval', description: "Maxsus sinxronlash oralig'i" },
];

const state = {
  enabled: config.telegramBotEnabled && Boolean(config.telegramBotToken),
  running: false,
  startedAt: null,
  lastPollAt: null,
  lastHandledAt: null,
  lastUpdateId: null,
  lastErrorAt: null,
  lastError: null,
  botId: null,
  botUsername: null,
};

const userSessions = new Map();
const inlineOnlyChats = new Set();
const REALTIME_INTERVAL_OPTIONS = [
  { label: '1 daqiqa', ms: 60 * 1000 },
  { label: '5 daqiqa', ms: 5 * 60 * 1000 },
  { label: '10 daqiqa', ms: 10 * 60 * 1000 },
  { label: '30 daqiqa', ms: 30 * 60 * 1000 },
  { label: '1 soat', ms: 60 * 60 * 1000 },
  { label: '2 soat', ms: 2 * 60 * 60 * 1000 },
  { label: '3 soat', ms: 3 * 60 * 60 * 1000 },
  { label: '6 soat', ms: 6 * 60 * 60 * 1000 },
  { label: '12 soat', ms: 12 * 60 * 60 * 1000 },
  { label: '24 soat', ms: 24 * 60 * 60 * 1000 },
];

let pollingPromise = null;
let stopRequested = false;
let currentPollController = null;
const replyMessageContext = new AsyncLocalStorage();

function ensureBotToken() {
  if (!config.telegramBotEnabled) {
    throw new Error('TELEGRAM_BOT_ENABLED=false, bot polling o\'chirilgan');
  }

  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN sozlanmagan');
  }
}

function getTelegramApiUrl(method) {
  return `${TELEGRAM_API_BASE}/bot${config.telegramBotToken}/${method}`;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatTelegramCode(value) {
  return `<code>${escapeTelegramHtml(value)}</code>`;
}

function formatTelegramField(label, value) {
  return `<b>${escapeTelegramHtml(label)}:</b> ${escapeTelegramHtml(value ?? '-')}`;
}

function withReplyMessagePayload(chatId, extra = {}) {
  const payload = { ...extra };
  const explicitReplyToMessageId = payload.replyToMessageId;
  delete payload.replyToMessageId;

  if (payload.reply_parameters || payload.reply_to_message_id) {
    return payload;
  }

  const replyContext = replyMessageContext.getStore();
  const replyToMessageId = explicitReplyToMessageId ?? replyContext?.messageId;

  if (!replyToMessageId) {
    return payload;
  }

  if (!explicitReplyToMessageId && String(replyContext?.chatId ?? '') !== String(chatId ?? '')) {
    return payload;
  }

  payload.reply_to_message_id = replyToMessageId;

  if (!hasOwn(payload, 'allow_sending_without_reply')) {
    payload.allow_sending_without_reply = true;
  }

  return payload;
}

function parseTelegramIds(rawValue) {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasAdminAccess(telegramUserId, appUser) {
  const cleanTelegramUserId = String(telegramUserId || '').trim();

  if (isBlockedAppUser(appUser)) {
    return false;
  }

  if (appUser?.role === 'admin' || appUser?.role === 'super_admin') {
    return true;
  }

  return config.superAdminTelegramIds.includes(cleanTelegramUserId);
}

function isBlockedAppUser(appUser) {
  return Boolean(appUser?.status && appUser.status !== 'active');
}

function getEffectiveRole(telegramUserId, appUser) {
  if (appUser?.role) {
    return appUser.role;
  }

  return hasAdminAccess(telegramUserId, appUser) ? 'super_admin' : 'user';
}

function formatRoleLabel(role) {
  if (role === 'super_admin') {
    return 'Super Admin';
  }

  if (role === 'admin') {
    return 'Admin';
  }

  return 'Foydalanuvchi';
}

function getAllDeviceRows() {
  return getDb()
    .prepare(`
      SELECT
        registrationNo,
        deviceSn,
        userName,
        plantName,
        deviceModel,
        onlineStatus,
        lastSeenAt,
        lastCheckedAt,
        addedAt,
        deviceNo,
        deviceName,
        source,
        trackingEnabled,
        telegramIds
      FROM devices
      ORDER BY COALESCE(deviceNo, 999999999) ASC, registrationNo ASC
    `)
    .all();
}

function getDeviceRowsByTelegramId(telegramId) {
  const cleanTelegramId = String(telegramId || '').trim();
  const rows = getDb()
    .prepare(`
      SELECT
        registrationNo,
        deviceSn,
        userName,
        plantName,
        deviceModel,
        onlineStatus,
        lastSeenAt,
        lastCheckedAt,
        addedAt,
        deviceNo,
        deviceName,
        source,
        trackingEnabled,
        telegramIds
      FROM devices
      WHERE telegramIds LIKE ?
      ORDER BY COALESCE(deviceNo, 999999999) ASC, registrationNo ASC
    `)
    .all(`%${cleanTelegramId}%`);

  return rows.filter((row) => parseTelegramIds(row.telegramIds).includes(cleanTelegramId));
}

function getAccessibleDeviceRows(telegramUserId, appUser) {
  return hasAdminAccess(telegramUserId, appUser) || areDevicesVisibleToAll()
    ? getAllDeviceRows()
    : getDeviceRowsByTelegramId(telegramUserId);
}

function getUserByTelegramId(telegramId) {
  return getDb()
    .prepare(`
      SELECT
        id,
        role,
        status,
        username,
        displayName,
        telegramId,
        telegramUsername
      FROM app_users
      WHERE telegramId = ?
      LIMIT 1
    `)
    .get(String(telegramId || '').trim());
}

function getDeviceByRegistrationNo(registrationNo) {
  return getDb()
    .prepare(`
      SELECT
        registrationNo,
        deviceSn,
        userName,
        plantName,
        deviceModel,
        onlineStatus,
        lastSeenAt,
        lastCheckedAt,
        addedAt,
        deviceNo,
        deviceName,
        source,
        trackingEnabled,
        telegramIds
      FROM devices
      WHERE registrationNo = ? COLLATE NOCASE
      LIMIT 1
    `)
    .get(String(registrationNo || '').trim());
}

function getDeviceInsights(registrationNo) {
  const db = getDb();

  const historySummary = db
    .prepare(`
      SELECT
        COUNT(*) AS historyCount,
        MAX(snapshotMinute) AS latestSnapshotMinute
      FROM device_status_history
      WHERE registrationNo = ?
    `)
    .get(registrationNo);

  const latestDaily = db
    .prepare(`
      SELECT date, yieldToday, yieldTotal, acPower, updatedAt
      FROM daily_stats
      WHERE registrationNo = ?
      ORDER BY date DESC
      LIMIT 1
    `)
    .get(registrationNo);

  const latestMonthly = db
    .prepare(`
      SELECT month, totalYield, avgYield, maxYield, activeDays, updatedAt
      FROM monthly_summary
      WHERE registrationNo = ?
      ORDER BY month DESC
      LIMIT 1
    `)
    .get(registrationNo);

  const alertSummary = db
    .prepare(`
      SELECT
        COUNT(*) AS totalAlerts,
        COALESCE(SUM(CASE WHEN isRead = 0 THEN 1 ELSE 0 END), 0) AS unreadAlerts
      FROM alerts
      WHERE registrationNo = ?
    `)
    .get(registrationNo);

  const recentAlerts = db
    .prepare(`
      SELECT type, message, createdAt, isRead
      FROM alerts
      WHERE registrationNo = ?
      ORDER BY createdAt DESC
      LIMIT 3
    `)
    .all(registrationNo);

  return {
    historyCount: historySummary?.historyCount ?? 0,
    latestSnapshotMinute: historySummary?.latestSnapshotMinute ?? null,
    latestDaily: latestDaily ?? null,
    latestMonthly: latestMonthly ?? null,
    totalAlerts: alertSummary?.totalAlerts ?? 0,
    unreadAlerts: alertSummary?.unreadAlerts ?? 0,
    recentAlerts,
  };
}

function getSystemAlertPreview(limit = 5) {
  return getDb()
    .prepare(`
      SELECT registrationNo, type, message, createdAt, isRead
      FROM alerts
      ORDER BY createdAt DESC
      LIMIT ?
    `)
    .all(limit);
}

function getStatusTag(status) {
  if (status === 'Online') {
    return '[ON]';
  }

  if (status === 'Offline') {
    return '[OFF]';
  }

  return '[UNK]';
}

function normaliseSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function searchAccessibleDevices(telegramUserId, appUser, query) {
  const cleanQuery = normaliseSearchText(query);

  if (!cleanQuery) {
    return [];
  }

  const rows = getAccessibleDeviceRows(telegramUserId, appUser);
  const filtered = rows.filter((row) => {
    const haystacks = [
      row.registrationNo,
      row.deviceSn,
      row.userName,
      row.plantName,
      row.deviceModel,
      row.deviceName,
      ...parseTelegramIds(row.telegramIds),
    ];

    return haystacks.some((value) => normaliseSearchText(value).includes(cleanQuery));
  });

  filtered.sort((left, right) => {
    const leftExact = normaliseSearchText(left.registrationNo) === cleanQuery ? 1 : 0;
    const rightExact = normaliseSearchText(right.registrationNo) === cleanQuery ? 1 : 0;

    if (leftExact !== rightExact) {
      return rightExact - leftExact;
    }

    const leftNo = Number(left.deviceNo ?? Number.MAX_SAFE_INTEGER);
    const rightNo = Number(right.deviceNo ?? Number.MAX_SAFE_INTEGER);

    if (leftNo !== rightNo) {
      return leftNo - rightNo;
    }

    return String(left.registrationNo).localeCompare(String(right.registrationNo));
  });

  return filtered.slice(0, SEARCH_RESULT_LIMIT);
}

function canAccessDevice(telegramUserId, deviceRow, appUser) {
  if (!deviceRow) {
    return false;
  }

  if (hasAdminAccess(telegramUserId, appUser) || areDevicesVisibleToAll()) {
    return true;
  }

  return parseTelegramIds(deviceRow.telegramIds).includes(String(telegramUserId));
}

function setUserSession(userId, session) {
  userSessions.set(String(userId), {
    ...session,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

function getUserSession(userId) {
  const session = userSessions.get(String(userId));

  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    userSessions.delete(String(userId));
    return null;
  }

  return session;
}

function clearUserSession(userId) {
  userSessions.delete(String(userId));
}

function buildInlineKeyboard(rows) {
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

function getTelegramWebAppUrl() {
  const rawUrl = String(config.telegramWebAppUrl || '').trim();

  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    url.searchParams.set(TELEGRAM_WEB_APP_FULLSCREEN_PARAM, '1');
    return url.toString();
  } catch {
    const hashIndex = rawUrl.indexOf('#');
    const baseUrl = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : rawUrl.slice(hashIndex);
    const separator = baseUrl.includes('?') ? '&' : '?';

    return `${baseUrl}${separator}${TELEGRAM_WEB_APP_FULLSCREEN_PARAM}=1${hash}`;
  }
}

function buildWebAppInlineKeyboardRows() {
  const webAppUrl = getTelegramWebAppUrl();

  if (!webAppUrl) {
    return [];
  }

  return [[{ text: BUTTONS.WEB_APP, web_app: { url: webAppUrl } }]];
}

function buildHomeOnlyInlineKeyboard() {
  return buildWebAppInlineKeyboardRows();
}

function buildHomeInlineKeyboard(appUser, telegramUserId) {
  const rows = [];

  if (hasAdminAccess(telegramUserId, appUser)) {
    rows.push([{ text: BUTTONS.SYNC_SETTINGS, callback_data: 'm:realtime' }]);
  }

  rows.push(...buildWebAppInlineKeyboardRows());

  return rows;
}

function formatDurationMs(ms) {
  const value = Number(ms);

  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }

  const minutes = Math.round(value / 60000);
  if (minutes < 60) {
    return `${minutes} daqiqa`;
  }

  const hours = value / 3600000;
  if (Number.isInteger(hours)) {
    return `${hours} soat`;
  }

  return `${hours.toFixed(1)} soat`;
}

function parseCustomRealtimeIntervalMs(input) {
  const value = String(input || '').trim().toLowerCase().replace(',', '.');

  if (!value) {
    throw new Error('Interval kiriting');
  }

  const match = value.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hour|hours|soat|s|m|min|minute|minutes|daqiqa|daq)?$/i);

  if (!match) {
    throw new Error('Format noto‘g‘ri. Masalan: 2 soat, 90 daqiqa, 1.5h');
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2] || 'soat';

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Interval musbat son bo‘lishi kerak');
  }

  if (['m', 'min', 'minute', 'minutes', 'daqiqa', 'daq'].includes(unit)) {
    return Math.round(amount * 60 * 1000);
  }

  return Math.round(amount * 60 * 60 * 1000);
}

function estimateNextRunAt(intervalMs) {
  const value = Number(intervalMs);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const now = Date.now();
  const remainder = now % value;
  const delayMs = remainder === 0 ? value : value - remainder;
  return new Date(now + delayMs).toISOString();
}

function buildRealtimeSyncInlineKeyboard() {
  const intervalRows = [];

  for (let index = 0; index < REALTIME_INTERVAL_OPTIONS.length; index += 2) {
    intervalRows.push(
      REALTIME_INTERVAL_OPTIONS.slice(index, index + 2).map((option) => ({
        text: option.label,
        callback_data: `rt:set:${option.ms}`,
      })),
    );
  }

  const rows = [
    ...intervalRows,
    [{ text: 'Maxsus interval', callback_data: 'rt:custom' }],
    [
      { text: 'Hozir sync', callback_data: 'rt:run' },
      { text: 'Yangilash', callback_data: 'rt:refresh' },
    ],
    [{ text: '⬅️ Bosh menyu', callback_data: 'm:home' }],
  ];

  return rows;
}

function buildRealtimeIntervalPromptInlineKeyboard() {
  return [[{ text: '◀️ Orqaga', callback_data: 'rt:cancel' }]];
}

function buildDevicesInlineKeyboard(devices, page, totalPages) {
  return [];
}

function buildSearchResultInlineKeyboard(devices) {
  return [];
}

function buildSearchPromptInlineKeyboard() {
  return [];
}

function buildDeviceDetailInlineKeyboard(registrationNo, page) {
  return [];
}

function buildHomeText(telegramUserId, appUser) {
  const linkedDevices = getDeviceRowsByTelegramId(telegramUserId);
  const role = getEffectiveRole(telegramUserId, appUser);
  const lines = [
    '<b><tg-emoji emoji-id="5843680709926981861">🏠</tg-emoji> Solax bot bosh menyusi</b>',
    '<tg-emoji emoji-id="5886412370347036129">👤</tg-emoji> '+formatTelegramField('Rol', formatRoleLabel(role)),
    `<b><tg-emoji emoji-id='5936017305585586269'>🪪</tg-emoji> Telegram ID:</b> ${formatTelegramCode(telegramUserId)}`,
    `<tg-emoji emoji-id="5967816500415827773">💻</tg-emoji> `+formatTelegramField('Biriktirilgan qurilmalar', linkedDevices.length),
  ];

  if (hasAdminAccess(telegramUserId, appUser)) {
    const snapshot = getHealthSnapshot();
    lines.push(`<tg-emoji emoji-id="5877318502947229960">💻</tg-emoji> `+formatTelegramField('Jami qurilmalar', snapshot.devices.totalDevices || 0));
    lines.push(`<tg-emoji emoji-id="5931472654660800739">📊</tg-emoji> `+formatTelegramField('Online', snapshot.devices.onlineDevices || 0));
    lines.push(`<tg-emoji emoji-id="5933629020301169337">📊</tg-emoji> `+formatTelegramField('Offline', snapshot.devices.offlineDevices || 0));
  }

  lines.push('');
  lines.push(
    hasAdminAccess(telegramUserId, appUser)
      ? '<tg-emoji emoji-id="5778202206922608769">🔄</tg-emoji> Quvvat sync sozlamalari uchun pastdagi tugmadan foydalaning.'
      : '<tg-emoji emoji-id="5872829476143894491">🚫</tg-emoji> Quvvat sync bo limi faqat adminlar uchun.',
  );

  return lines.join('\n');
}

function buildWelcomeText(telegramUserId, appUser, displayName) {
  const lines = [
    `<b><tg-emoji emoji-id='5994750571041525522'>👋</tg-emoji> Salom, <a href="tg://user?id=${telegramUserId}">${escapeTelegramHtml(displayName)}</a> !</b>`,
  ];
  return lines.join('\n');
}

function buildStartText(telegramUserId, appUser, displayName) {
  return [buildWelcomeText(telegramUserId, appUser, displayName), '', buildHomeText(telegramUserId, appUser)].join(
    '\n',
  );
}

function buildStatsText() {
  const snapshot = getHealthSnapshot();
  const alerts = getSystemAlertPreview(5);
  const realtimeSync = getSolaxRealtimeSyncState();
  const lines = [
    '<b>Admin statistika:</b>',
    formatTelegramField('Users jami', snapshot.users.totalUsers || 0),
    formatTelegramField('Super admin', snapshot.users.superAdmins || 0),
    formatTelegramField('Admin', snapshot.users.admins || 0),
    formatTelegramField('Oddiy user', snapshot.users.users || 0),
    formatTelegramField('Qurilmalar jami', snapshot.devices.totalDevices || 0),
    formatTelegramField('Online', snapshot.devices.onlineDevices || 0),
    formatTelegramField('Offline', snapshot.devices.offlineDevices || 0),
    formatTelegramField('Alertlar jami', snapshot.alerts.totalAlerts || 0),
    formatTelegramField('Oqilmagan alertlar', snapshot.alerts.unreadAlerts || 0),
    formatTelegramField('Quvvat sync interval', formatDurationMs(realtimeSync.intervalMs)),
    formatTelegramField('Keyingi quvvat sync', realtimeSync.nextRunAt || '-'),
  ];

  if (alerts.length > 0) {
    lines.push('');
    lines.push('<b>Oxirgi alertlar:</b>');
    for (const alert of alerts) {
      lines.push(
        `- ${formatTelegramCode(alert.registrationNo || '-')} | ${escapeTelegramHtml(alert.type || 'alert')} | ${escapeTelegramHtml(
          alert.createdAt || '-',
        )} | ${alert.isRead ? 'read' : 'unread'}`,
      );
    }
  }

  return lines.join('\n');
}

function buildRealtimeSyncText(notice = null) {
  const state = getSolaxRealtimeSyncState();
  const lastSummary = state.lastSummary;
  const nextRunAt = state.nextRunAt || estimateNextRunAt(state.intervalMs);
  const lines = [
    '<b><tg-emoji emoji-id="5839380464116175529">✏️</tg-emoji> Quvvat sync sozlamalari</b>',
    '<tg-emoji emoji-id="5879785854284599288">ℹ️</tg-emoji> '+formatTelegramField('Holat', state.enabled ? 'Yoqilgan' : 'O\'chirilgan yoki token y\'oq'),
    '<tg-emoji emoji-id="5985616167740379273">⏰</tg-emoji> '+formatTelegramField('DBga yozish intervali', formatDurationMs(state.intervalMs)),
    '<tg-emoji emoji-id="5900104897885376843">🕓</tg-emoji> '+formatTelegramField('Minimal interval', formatDurationMs(state.minIntervalMs)),
    '<tg-emoji emoji-id="5839042506024555846">➡️</tg-emoji> '+formatTelegramField('Keyingi run', nextRunAt || '-'),
    '<tg-emoji emoji-id="5879813604068298387">❗️</tg-emoji> '+formatTelegramField('Hozir ishlayaptimi', state.isRunning ? 'Ha' : 'Yo\'q'),
    '<tg-emoji emoji-id="5843799474362652262">🔄</tg-emoji> '+formatTelegramField('Oxirgi muvaffaqiyat', state.lastSuccessAt || 'Noma\'lum'),
  ];

  if (notice) {
    lines.unshift(escapeTelegramHtml(notice), '');
  }

  // Jonli progress — hozir sync ketayotgan bo'lsa qaysi qurilma ishlanayotgani
  const progress = getSyncLiveProgress();
  if (progress.running) {
    const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
    lines.push('');
    lines.push('<b>🔄 Hozir sinxronlanmoqda...</b>');
    lines.push(`📊 ${progress.current}/${progress.total} (${pct}%)`);
    lines.push(`✅ ${progress.succeeded}  ❌ ${progress.failed}`);
    if (progress.currentDevice) {
      lines.push(`🔌 Joriy qurilma: ${formatTelegramCode(progress.currentDevice)}`);
    }
  }

  if (lastSummary) {
    lines.push('');
    lines.push('<b>Oxirgi natija:</b>');
    lines.push(`- Qayta ishlandi: ${escapeTelegramHtml(lastSummary.processed ?? 0)}/${escapeTelegramHtml(lastSummary.totalTargets ?? 0)}`);
    lines.push(`- ✅ Muvaffaqiyatli: ${escapeTelegramHtml(lastSummary.succeeded ?? 0)}`);
    lines.push(`- ❌ Muvaffaqiyatsiz: ${escapeTelegramHtml(lastSummary.failed ?? 0)}`);
    lines.push(`- O'tkazib yuborildi: ${escapeTelegramHtml(lastSummary.skipped ?? 0)}`);

    if (lastSummary.quotaLimited) {
      lines.push('- SolaX limitga tushgan');
    }

    // Muvaffaqiyatsiz qurilmalar ro'yxati
    const errors = Array.isArray(lastSummary.errors) ? lastSummary.errors : [];
    if (errors.length > 0) {
      lines.push('');
      lines.push('<b>Xato bergan qurilmalar:</b>');
      for (const err of errors.slice(0, 10)) {
        lines.push(`• ${formatTelegramCode(err.registrationNo || '-')} — ${escapeTelegramHtml(err.message || 'xato')}`);
      }
      if (errors.length > 10) {
        lines.push(`... va yana ${errors.length - 10} ta`);
      }
    }
  }

  lines.push('');
  lines.push('Kerakli intervalni tanlang yoki custom interval kiriting. Bu qiymat DBga saqlanadi va restartdan keyin ham qoladi.');

  return lines.join('\n');
}

function buildRealtimeIntervalPromptText() {
  const state = getSolaxRealtimeSyncState();

  return [
    "<b>Maxsus sinxronlash oralig'i</b>",
    formatTelegramField('Joriy interval', formatDurationMs(state.intervalMs)),
    formatTelegramField('Minimal interval', formatDurationMs(state.minIntervalMs)),
    '',
    `Interval yuboring. Masalan: ${formatTelegramCode('2 soat')}, ${formatTelegramCode('90 daqiqa')}, ${formatTelegramCode('1.5h')}.`,
  ].join('\n');
}

function buildDeviceListText(devices, page, totalPages, title) {
  const start = page * DEVICE_PAGE_SIZE + 1;
  const end = start + devices.length - 1;
  const lines = [
    `<b>${escapeTelegramHtml(title)}</b>`,
    formatTelegramField('Sahifa', `${page + 1}/${Math.max(totalPages, 1)}`),
    formatTelegramField('Ko\'rinyapti', `${devices.length > 0 ? `${start}-${end}` : '0'} ta`),
    '',
  ];

  if (devices.length === 0) {
    lines.push('Qurilmalar topilmadi.');
    return lines.join('\n');
  }

  for (const device of devices) {
    const label = device.deviceName || device.plantName || device.userName || 'Nomsiz qurilma';
    lines.push(`${getStatusTag(device.onlineStatus)} ${formatTelegramCode(device.registrationNo)} | ${escapeTelegramHtml(label)}`);
  }

  lines.push('');
  lines.push('Batafsil ko\'rish uchun pastdagi tugmalardan foydalaning.');

  return lines.join('\n');
}

function buildDeviceDetailsText(device, insights, telegramUserId, appUser) {
  const telegramIds = parseTelegramIds(device.telegramIds);
  const lines = [
    `<b>Qurilma:</b> ${formatTelegramCode(device.registrationNo)}`,
    formatTelegramField('Holati', device.onlineStatus || 'Noma\'lum'),
    formatTelegramField('Egasi', device.userName || 'Noma\'lum'),
    formatTelegramField('Plant', device.plantName || 'Noma\'lum'),
    formatTelegramField('Model', device.deviceModel || 'Noma\'lum'),
    `<b>SN:</b> ${formatTelegramCode(device.deviceSn || 'Noma\'lum')}`,
    formatTelegramField('Tracking', device.trackingEnabled ? 'Yoqilgan' : 'O\'chirilgan'),
    formatTelegramField('Oxirgi tekshiruv', device.lastCheckedAt || 'Noma\'lum'),
    formatTelegramField('Oxirgi online vaqti', device.lastSeenAt || 'Noma\'lum'),
    `<b>TG ID:</b> ${telegramIds.length > 0 ? telegramIds.map(formatTelegramCode).join(', ') : 'Noma\'lum'}`,
    '',
    formatTelegramField('History yozuvlari', insights.historyCount),
    formatTelegramField('Oxirgi snapshot', insights.latestSnapshotMinute || 'Noma\'lum'),
  ];

  if (insights.latestDaily) {
    lines.push(
      `<b>Kunlik stat:</b> ${escapeTelegramHtml(insights.latestDaily.date)} | Today=${escapeTelegramHtml(
        insights.latestDaily.yieldToday ?? 0,
      )} | Total=${escapeTelegramHtml(insights.latestDaily.yieldTotal ?? 0)} | Power=${escapeTelegramHtml(
        insights.latestDaily.acPower ?? 0,
      )}`,
    );
  }

  if (insights.latestMonthly) {
    lines.push(
      `<b>Oylik stat:</b> ${escapeTelegramHtml(insights.latestMonthly.month)} | Total=${escapeTelegramHtml(
        insights.latestMonthly.totalYield ?? 0,
      )} | Avg=${escapeTelegramHtml(insights.latestMonthly.avgYield ?? 0)} | Max=${escapeTelegramHtml(
        insights.latestMonthly.maxYield ?? 0,
      )}`,
    );
  }

  lines.push(formatTelegramField('Alertlar', `${insights.totalAlerts} jami, ${insights.unreadAlerts} oqilmagan`));

  if (insights.recentAlerts.length > 0) {
    lines.push('');
    lines.push('<b>Oxirgi alertlar:</b>');
    for (const alert of insights.recentAlerts) {
      lines.push(
        `- ${escapeTelegramHtml(alert.createdAt || '-')} | ${escapeTelegramHtml(alert.type || 'alert')} | ${escapeTelegramHtml(
          alert.message || '-',
        )}`,
      );
    }
  }

  if (hasAdminAccess(telegramUserId, appUser)) {
    lines.push('');
    lines.push('Admin access: bu qurilma sizga boshqaruv rejimida ochildi.');
  }

  return lines.join('\n');
}

async function callTelegram(method, payload = {}, { signal } = {}) {
  ensureBotToken();

  const response = await fetch(getTelegramApiUrl(method), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    const description = data?.description || `HTTP ${response.status}`;
    throw new Error(`Telegram API xatosi (${method}): ${description}`);
  }

  return data.result;
}

async function getBotProfile() {
  const profile = await callTelegram('getMe');
  state.botId = profile?.id ?? null;
  state.botUsername = profile?.username ?? null;
  return profile;
}

async function registerBotCommands() {
  await callTelegram('setMyCommands', {
    commands: BOT_COMMANDS,
  });
}

async function answerCallbackQuery(callbackQueryId, text = '', { showAlert = false } = {}) {
  try {
    await callTelegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || undefined,
      show_alert: showAlert,
    });
  } catch (error) {
    console.error('[telegram-bot] callback answer xatosi:', error.message);
  }
}

export async function sendTelegramMessage(chatId, text, extra = {}) {
  const payload = withReplyMessagePayload(chatId, extra);

  if (!hasOwn(payload, 'parse_mode')) {
    payload.parse_mode = TELEGRAM_PARSE_MODE;
  }

  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...payload,
  });
}

export async function sendTelegramDocument(chatId, buffer, filename, extra = {}) {
  ensureBotToken();

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (extra.caption) {
    form.append('caption', extra.caption);
    form.append('parse_mode', extra.parse_mode || TELEGRAM_PARSE_MODE);
  }
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename);

  const response = await fetch(getTelegramApiUrl('sendDocument'), {
    method: 'POST',
    body: form,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    const description = data?.description || `HTTP ${response.status}`;
    throw new Error(`Telegram API xatosi (sendDocument): ${description}`);
  }

  return data.result;
}

export async function sendTelegramMessageToMany(chatIds, text, extra = {}) {
  const uniqueChatIds = [
    ...new Set(
      (Array.isArray(chatIds) ? chatIds : [])
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  ];
  const results = [];

  for (const chatId of uniqueChatIds) {
    try {
      const result = await sendTelegramMessage(chatId, text, extra);
      results.push({ chatId, ok: true, result });
    } catch (error) {
      results.push({ chatId, ok: false, error: error.message });
    }
  }

  return results;
}

async function ensureInlineOnlyChat(chatId) {
  const chatKey = String(chatId);

  if (inlineOnlyChats.has(chatKey)) {
    return;
  }

  await sendTelegramMessage(chatId, 'Inline menyu yoqildi. Endi bot faqat xabar ichidagi tugmalar bilan ishlaydi.', {
    reply_markup: {
      remove_keyboard: true,
    },
  });
  inlineOnlyChats.add(chatKey);
}

async function sendInlinePanel(chatId, text, inlineKeyboardRows = []) {
  return sendTelegramMessage(chatId, text, {
    reply_markup: buildInlineKeyboard(inlineKeyboardRows),
  });
}

async function editTelegramMessage(chatId, messageId, text, inlineKeyboardRows = []) {
  try {
    return await callTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: TELEGRAM_PARSE_MODE,
      disable_web_page_preview: true,
      reply_markup: buildInlineKeyboard(inlineKeyboardRows),
    });
  } catch (error) {
    if (error.message.includes('message is not modified')) {
      return null;
    }

    throw error;
  }
}

function buildBlockedUserText() {
  return [
    '<b>Akkount bloklangan.</b>',
    'Botdan foydalanish uchun admin bilan boglaning.',
  ].join('\n');
}

async function rejectBlockedMessage(message) {
  clearUserSession(message.from.id);

  return sendTelegramMessage(message.chat.id, buildBlockedUserText(), {
    reply_markup: {
      remove_keyboard: true,
    },
  });
}

async function rejectBlockedCallback(callbackQuery) {
  clearUserSession(callbackQuery.from.id);
  await answerCallbackQuery(callbackQuery.id, 'Akkount bloklangan', { showAlert: true });

  try {
    await editTelegramMessage(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      buildBlockedUserText(),
      [],
    );
  } catch (_error) {
    await sendTelegramMessage(callbackQuery.message.chat.id, buildBlockedUserText()).catch(() => null);
  }
}

async function sendHomeMenu(chatId, telegramUserId, appUser, { includeGreeting = false } = {}) {
  if (includeGreeting) {
    const displayName = appUser?.displayName || `User ${telegramUserId}`;
    return sendInlinePanel(
      chatId,
      buildStartText(telegramUserId, appUser, displayName),
      buildHomeInlineKeyboard(appUser, telegramUserId),
    );
  }

  return sendInlinePanel(chatId, buildHomeText(telegramUserId, appUser), buildHomeInlineKeyboard(appUser, telegramUserId));
}

async function editHomeMenu(callbackQuery, telegramUserId, appUser) {
  return editTelegramMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    buildHomeText(telegramUserId, appUser),
    buildHomeInlineKeyboard(appUser, telegramUserId),
  );
}

async function sendDevicesMenu(chatId, telegramUserId, appUser, page = 0) {
  const accessibleDevices = getAccessibleDeviceRows(telegramUserId, appUser);
  const totalPages = Math.max(1, Math.ceil(accessibleDevices.length / DEVICE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const pageDevices = accessibleDevices.slice(
    safePage * DEVICE_PAGE_SIZE,
    safePage * DEVICE_PAGE_SIZE + DEVICE_PAGE_SIZE,
  );
  const title = hasAdminAccess(telegramUserId, appUser)
    ? `Qurilmalar royxati (${accessibleDevices.length} ta)`
    : areDevicesVisibleToAll()
      ? `Barcha qurilmalar (${accessibleDevices.length} ta)`
      : `Sizga biriktirilgan qurilmalar (${accessibleDevices.length} ta)`;

  return sendTelegramMessage(chatId, buildDeviceListText(pageDevices, safePage, totalPages, title), {
    reply_markup: buildInlineKeyboard(buildDevicesInlineKeyboard(pageDevices, safePage, totalPages)),
  });
}

async function editDevicesMenu(callbackQuery, telegramUserId, appUser, page = 0) {
  const accessibleDevices = getAccessibleDeviceRows(telegramUserId, appUser);
  const totalPages = Math.max(1, Math.ceil(accessibleDevices.length / DEVICE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const pageDevices = accessibleDevices.slice(
    safePage * DEVICE_PAGE_SIZE,
    safePage * DEVICE_PAGE_SIZE + DEVICE_PAGE_SIZE,
  );
  const title = hasAdminAccess(telegramUserId, appUser)
    ? `Qurilmalar royxati (${accessibleDevices.length} ta)`
    : areDevicesVisibleToAll()
      ? `Barcha qurilmalar (${accessibleDevices.length} ta)`
      : `Sizga biriktirilgan qurilmalar (${accessibleDevices.length} ta)`;

  return editTelegramMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    buildDeviceListText(pageDevices, safePage, totalPages, title),
    buildDevicesInlineKeyboard(pageDevices, safePage, totalPages),
  );
}

async function sendDeviceDetails(chatId, telegramUserId, appUser, registrationNo, page = 0) {
  const device = getDeviceByRegistrationNo(registrationNo);

  if (!device || !canAccessDevice(telegramUserId, device, appUser)) {
    return sendTelegramMessage(chatId, 'Qurilma topilmadi yoki sizda unga ruxsat yo\'q.');
  }

  const insights = getDeviceInsights(device.registrationNo);

  return sendTelegramMessage(
    chatId,
    buildDeviceDetailsText(device, insights, telegramUserId, appUser),
    {
      reply_markup: buildInlineKeyboard(buildDeviceDetailInlineKeyboard(device.registrationNo, page)),
    },
  );
}

async function editDeviceDetails(callbackQuery, telegramUserId, appUser, registrationNo, page = 0) {
  const device = getDeviceByRegistrationNo(registrationNo);

  if (!device || !canAccessDevice(telegramUserId, device, appUser)) {
    return editTelegramMessage(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      'Qurilma topilmadi yoki sizda unga ruxsat yo\'q.',
      [],
    );
  }

  const insights = getDeviceInsights(device.registrationNo);

  return editTelegramMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    buildDeviceDetailsText(device, insights, telegramUserId, appUser),
    buildDeviceDetailInlineKeyboard(device.registrationNo, page),
  );
}

async function sendStatsMenu(chatId, telegramUserId, appUser) {
  if (!hasAdminAccess(telegramUserId, appUser)) {
    return sendInlinePanel(chatId, 'Bu bo lim faqat adminlar uchun.', buildHomeOnlyInlineKeyboard());
  }

  return sendInlinePanel(chatId, buildStatsText(), [
    [{ text: BUTTONS.SYNC_SETTINGS, callback_data: 'm:realtime' }],
  ]);
}

async function editStatsMenu(callbackQuery, telegramUserId, appUser) {
  if (!hasAdminAccess(telegramUserId, appUser)) {
    return editTelegramMessage(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      'Bu bo lim faqat adminlar uchun.',
      [],
    );
  }

  return editTelegramMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    buildStatsText(),
    [[{ text: BUTTONS.SYNC_SETTINGS, callback_data: 'm:realtime' }]],
  );
}

async function sendRealtimeSyncMenu(chatId, telegramUserId, appUser, notice = null) {
  if (!hasAdminAccess(telegramUserId, appUser)) {
    return sendInlinePanel(chatId, 'Bu bo lim faqat adminlar uchun.', buildHomeOnlyInlineKeyboard());
  }

  return sendInlinePanel(chatId, buildRealtimeSyncText(notice), buildRealtimeSyncInlineKeyboard());
}

async function editRealtimeSyncMenu(callbackQuery, telegramUserId, appUser, notice = null) {
  if (!hasAdminAccess(telegramUserId, appUser)) {
    return editTelegramMessage(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      'Bu bo lim faqat adminlar uchun.',
      buildHomeOnlyInlineKeyboard(),
    );
  }

  return editTelegramMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    buildRealtimeSyncText(notice),
    buildRealtimeSyncInlineKeyboard(),
  );
}

async function promptRealtimeIntervalInput(chatId, telegramUserId, appUser) {
  if (!hasAdminAccess(telegramUserId, appUser)) {
    return sendInlinePanel(chatId, 'Bu bo lim faqat adminlar uchun.', buildHomeOnlyInlineKeyboard());
  }

  setUserSession(telegramUserId, { mode: 'realtime_interval' });

  return sendInlinePanel(chatId, buildRealtimeIntervalPromptText(), buildRealtimeIntervalPromptInlineKeyboard());
}

async function editRealtimeIntervalPrompt(callbackQuery, telegramUserId, appUser) {
  if (!hasAdminAccess(telegramUserId, appUser)) {
    return editTelegramMessage(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      'Bu bo lim faqat adminlar uchun.',
      buildHomeOnlyInlineKeyboard(),
    );
  }

  setUserSession(telegramUserId, { mode: 'realtime_interval' });

  return editTelegramMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    buildRealtimeIntervalPromptText(),
    buildRealtimeIntervalPromptInlineKeyboard(),
  );
}

async function handleRealtimeIntervalInput(message, appUser, input) {
  if (!hasAdminAccess(message.from.id, appUser)) {
    clearUserSession(message.from.id);
    return sendInlinePanel(message.chat.id, 'Bu bo lim faqat adminlar uchun.', buildHomeOnlyInlineKeyboard());
  }

  try {
    const intervalMs = parseCustomRealtimeIntervalMs(input);
    const nextState = setSolaxRealtimeSyncIntervalMs(intervalMs, {
      changedBy: message.from.id,
    });

    clearUserSession(message.from.id);
    return sendInlinePanel(
      message.chat.id,
      buildRealtimeSyncText(`Interval yangilandi: ${formatDurationMs(nextState.intervalMs)}`),
      buildRealtimeSyncInlineKeyboard(),
    );
  } catch (error) {
    setUserSession(message.from.id, { mode: 'realtime_interval' });
    return sendInlinePanel(
      message.chat.id,
      [
        `<b>Interval saqlanmadi:</b> ${escapeTelegramHtml(error.message)}`,
        '',
        buildRealtimeIntervalPromptText(),
      ].join('\n'),
      buildRealtimeIntervalPromptInlineKeyboard(),
    );
  }
}

function notifyRealtimeSyncResult(chatId, summary) {
  // Sync o'chirilgan yoki token yo'q — chalkash "0/0" o'rniga aniq xabar
  if (!summary || summary.enabled === false) {
    return sendTelegramMessage(chatId, "<tg-emoji emoji-id=\"5872829476143894491\">🚫</tg-emoji> Quvvat sync o'chirilgan yoki SolaX token sozlanmagan.");
  }

  // Ushbu chaqiruvda hech narsa qayta ishlanmadi (boshqa sinxronlash allaqachon
  // davom etmoqda yoki qurilma yo'q) — foydalanuvchini chalkashtirmaymiz
  if ((summary.totalTargets ?? 0) === 0 && (summary.processed ?? 0) === 0) {
    return sendTelegramMessage(
      chatId,
      "<tg-emoji emoji-id=\"5843799474362652262\">🔄</tg-emoji> Sinxronlash allaqachon fonda davom etmoqda. Natijani ko'rish uchun \"Yangilash\" tugmasidan foydalaning.",
    );
  }

  const errors = Array.isArray(summary?.errors) ? summary.errors : [];
  const lines = [
    '<b><tg-emoji emoji-id="5843799474362652262">🔄</tg-emoji> Quvvat sync yakunlandi</b>',
    `<tg-emoji emoji-id="5877318502947229960">💻</tg-emoji> Qayta ishlandi: ${escapeTelegramHtml(summary.processed ?? 0)}/${escapeTelegramHtml(summary.totalTargets ?? 0)}`,
    `✅ Muvaffaqiyatli: ${escapeTelegramHtml(summary.succeeded ?? 0)}`,
    `❌ Muvaffaqiyatsiz: ${escapeTelegramHtml(summary.failed ?? 0)}`,
    `⏭ O'tkazib yuborildi: ${escapeTelegramHtml(summary.skipped ?? 0)}`,
    summary.quotaLimited ? 'SolaX kunlik limitga tushgan.' : null,
  ].filter(Boolean);

  if (errors.length > 0) {
    lines.push('');
    lines.push('<b>Xato bergan qurilmalar:</b>');
    for (const err of errors.slice(0, 15)) {
      lines.push(`• ${formatTelegramCode(err.registrationNo || '-')} — ${escapeTelegramHtml(err.message || 'xato')}`);
    }
    if (errors.length > 15) {
      lines.push(`... va yana ${errors.length - 15} ta`);
    }
  }

  return sendTelegramMessage(chatId, lines.join('\n'));
}

// Sync jarayonining jonli progressini xuddi shu xabarni yangilab ko'rsatadi.
const activeSyncStreams = new Set();

async function streamRealtimeSyncProgress(chatId, messageId, telegramUserId, appUser) {
  const key = `${chatId}:${messageId}`;
  if (activeSyncStreams.has(key)) {
    return;
  }
  activeSyncStreams.add(key);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const MAX_TICKS = 45; // ~3 daqiqa (4s * 45)

  try {
    await sleep(1500); // sync boshlanishini kutamiz
    let prevText = '';

    for (let tick = 0; tick < MAX_TICKS; tick += 1) {
      const progress = getSyncLiveProgress();
      const text = buildRealtimeSyncText(progress.running ? null : 'Sync yakunlandi.');

      if (text !== prevText) {
        await editTelegramMessage(chatId, messageId, text, buildRealtimeSyncInlineKeyboard()).catch(() => null);
        prevText = text;
      }

      if (!progress.running && tick > 0) {
        break;
      }

      await sleep(4000);
    }
  } finally {
    activeSyncStreams.delete(key);
  }
}

function buildSearchPromptText() {
  return [
    'Qidiruv rejimi yoqildi.',
    'REG, SN, egasi, plant nomi yoki TG ID ni yuboring.',
    'Bekor qilish yoki bosh menyuga qaytish uchun pastdagi inline tugmalardan foydalaning.',
  ].join('\n');
}

async function promptDeviceSearch(chatId, telegramUserId, appUser) {
  setUserSession(telegramUserId, { mode: 'device_search' });

  return sendInlinePanel(chatId, buildSearchPromptText(), buildSearchPromptInlineKeyboard());
}

async function editSearchPrompt(callbackQuery, telegramUserId) {
  setUserSession(telegramUserId, { mode: 'device_search' });

  return editTelegramMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    buildSearchPromptText(),
    buildSearchPromptInlineKeyboard(),
  );
}

async function handleSearchQuery(message, appUser, query) {
  const results = searchAccessibleDevices(message.from.id, appUser, query);

  if (results.length === 0) {
    setUserSession(message.from.id, { mode: 'device_search' });
    return sendInlinePanel(
      message.chat.id,
      `Qidiruv bo yicha natija topilmadi: ${formatTelegramCode(query)}`,
      buildSearchPromptInlineKeyboard(),
    );
  }

  clearUserSession(message.from.id);

  if (results.length === 1) {
    return sendDeviceDetails(message.chat.id, message.from.id, appUser, results[0].registrationNo, 0);
  }

  return sendTelegramMessage(
    message.chat.id,
    [
      `<b>Qidiruv natijalari (${results.length} ta):</b>`,
      ...results.map((device) => `${getStatusTag(device.onlineStatus)} ${formatTelegramCode(device.registrationNo)}`),
    ].join('\n'),
    {
      reply_markup: buildInlineKeyboard(buildSearchResultInlineKeyboard(results)),
    },
  );
}

function parseCommand(text) {
  const value = String(text || '').trim();

  if (!value.startsWith('/')) {
    return null;
  }

  const [firstToken, ...restTokens] = value.split(/\s+/);
  const commandToken = firstToken.slice(1);
  const [commandName, mentionedBot] = commandToken.split('@');

  if (
    mentionedBot &&
    state.botUsername &&
    mentionedBot.toLowerCase() !== String(state.botUsername).toLowerCase()
  ) {
    return null;
  }

  return {
    command: commandName.toLowerCase(),
    args: restTokens.join(' ').trim(),
  };
}

function parseCallbackData(data) {
  const parts = String(data || '').split(':');

  return {
    group: parts[0] || '',
    action: parts[1] || '',
    parts,
  };
}

async function handleTextShortcut(message, appUser) {
  const text = String(message.text || '').trim();

  if (text === BUTTONS.HOME) {
    clearUserSession(message.from.id);
    await sendHomeMenu(message.chat.id, message.from.id, appUser);
    return true;
  }

  if (text === BUTTONS.SYNC_SETTINGS) {
    clearUserSession(message.from.id);
    await sendRealtimeSyncMenu(message.chat.id, message.from.id, appUser);
    return true;
  }

  return false;
}

async function handleCommand(message, appUser, parsedCommand) {
  switch (parsedCommand.command) {
    case 'start':
      clearUserSession(message.from.id);
      await sendHomeMenu(message.chat.id, message.from.id, appUser, { includeGreeting: true });
      return true;
    case 'sync':
    case 'realtime':
      clearUserSession(message.from.id);
      await sendRealtimeSyncMenu(message.chat.id, message.from.id, appUser);
      return true;
    case 'interval':
      await promptRealtimeIntervalInput(message.chat.id, message.from.id, appUser);
      return true;
    default:
      await sendInlinePanel(
        message.chat.id,
        `Noma lum buyruq: /${escapeTelegramHtml(parsedCommand.command)}`,
        buildHomeInlineKeyboard(appUser, message.from.id),
      );
      return true;
  }
}

async function handleIncomingMessage(message) {
  if (!message?.from?.id || !message?.chat?.id) {
    return;
  }

  const appUser = getUserByTelegramId(message.from.id);
  const text = String(message.text || '').trim();

  if (isBlockedAppUser(appUser)) {
    await rejectBlockedMessage(message);
    return;
  }

  if (text) {
    await ensureInlineOnlyChat(message.chat.id);

    if (await handleTextShortcut(message, appUser)) {
      return;
    }

    const parsedCommand = parseCommand(text);
    if (parsedCommand) {
      await handleCommand(message, appUser, parsedCommand);
      return;
    }

    const session = getUserSession(message.from.id);
    if (session?.mode === 'realtime_interval') {
      await handleRealtimeIntervalInput(message, appUser, text);
      return;
    }

    if (session?.mode === 'device_search') {
      await handleSearchQuery(message, appUser, text);
      return;
    }

    await sendInlinePanel(
      message.chat.id,
      [
        'Xabar qabul qilindi, lekin men uni buyruq sifatida tani olmadim.',
        'Quvvat sync uchun /sync ni yuboring.',
      ].join('\n'),
      buildHomeInlineKeyboard(appUser, message.from.id),
    );
  }
}

async function handleCallbackQuery(callbackQuery) {
  if (!callbackQuery?.id || !callbackQuery?.from?.id || !callbackQuery?.message) {
    return;
  }

  const appUser = getUserByTelegramId(callbackQuery.from.id);
  const parsed = parseCallbackData(callbackQuery.data);

  if (isBlockedAppUser(appUser)) {
    await rejectBlockedCallback(callbackQuery);
    return;
  }

  try {
    if (parsed.group === 'm') {
      switch (parsed.action) {
        case 'realtime':
          await editRealtimeSyncMenu(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Quvvat sync sozlamalari');
          return;
        case 'home':
          clearUserSession(callbackQuery.from.id);
          await editHomeMenu(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Bosh menyu');
          return;
        default:
          await answerCallbackQuery(callbackQuery.id, 'Noma lum amal');
          return;
      }
    }

    if (parsed.group === 'rt') {
      if (!hasAdminAccess(callbackQuery.from.id, appUser)) {
        await answerCallbackQuery(callbackQuery.id, 'Faqat adminlar uchun');
        return;
      }

      switch (parsed.action) {
        case 'set': {
          const intervalMs = Number.parseInt(parsed.parts[2] || '', 10);
          const nextState = setSolaxRealtimeSyncIntervalMs(intervalMs, {
            changedBy: callbackQuery.from.id,
          });
          await editRealtimeSyncMenu(
            callbackQuery,
            callbackQuery.from.id,
            appUser,
            `Interval yangilandi: ${formatDurationMs(nextState.intervalMs)}`,
          );
          await answerCallbackQuery(callbackQuery.id, 'Interval saqlandi');
          return;
        }
        case 'refresh':
          await editRealtimeSyncMenu(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Yangilandi');
          return;
        case 'custom':
          await editRealtimeIntervalPrompt(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Maxsus interval');
          return;
        case 'cancel':
          clearUserSession(callbackQuery.from.id);
          await editRealtimeSyncMenu(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Bekor qilindi');
          return;
        case 'run': {
          await answerCallbackQuery(callbackQuery.id, 'Sync boshlandi');
          const chatId = callbackQuery.message.chat.id;
          const messageId = callbackQuery.message.message_id;

          runSolaxRealtimeSyncNow('telegram-bot')
            .then((summary) => notifyRealtimeSyncResult(chatId, summary))
            .catch((error) =>
              sendTelegramMessage(
                chatId,
                `<b>Quvvat sync xatosi:</b> ${escapeTelegramHtml(error.message)}`,
              ).catch(() => null),
            );

          // Jonli progress'ni shu xabarni yangilab ko'rsatamiz
          streamRealtimeSyncProgress(chatId, messageId, callbackQuery.from.id, appUser).catch(() => null);
          return;
        }
        default:
          await answerCallbackQuery(callbackQuery.id, 'Noma lum sync amali');
          return;
      }
    }

    await answerCallbackQuery(callbackQuery.id, 'Noma lum callback');
  } catch (error) {
    console.error('[telegram-bot] callback xatosi:', error);
    await answerCallbackQuery(callbackQuery.id, 'Xatolik yuz berdi');
  }
}

async function processUpdates(updates) {
  for (const update of updates) {
    if (typeof update.update_id === 'number') {
      state.lastUpdateId = update.update_id;
    }

    if (update.message) {
      await replyMessageContext.run(
        {
          chatId: update.message.chat.id,
          messageId: update.message.message_id,
        },
        async () => handleIncomingMessage(update.message),
      );
      state.lastHandledAt = new Date().toISOString();
      continue;
    }

    if (update.callback_query) {
      const callbackMessage = update.callback_query.message;
      await replyMessageContext.run(
        {
          chatId: callbackMessage?.chat?.id,
          messageId: callbackMessage?.message_id,
        },
        async () => handleCallbackQuery(update.callback_query),
      );
      state.lastHandledAt = new Date().toISOString();
    }
  }
}

async function pollLoop() {
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.lastError = null;
  state.lastErrorAt = null;

  await getBotProfile();
  await registerBotCommands();

  while (!stopRequested) {
    try {
      currentPollController = new AbortController();
      const updates = await callTelegram(
        'getUpdates',
        {
          offset: state.lastUpdateId === null ? undefined : state.lastUpdateId + 1,
          timeout: config.telegramBotPollingTimeoutSeconds,
          allowed_updates: ['message', 'callback_query'],
        },
        { signal: currentPollController.signal },
      );

      state.lastPollAt = new Date().toISOString();
      await processUpdates(Array.isArray(updates) ? updates : []);
      currentPollController = null;
    } catch (error) {
      currentPollController = null;

      if (stopRequested) {
        break;
      }

      state.lastError = error.message;
      state.lastErrorAt = new Date().toISOString();
      console.error('[telegram-bot] Polling xatosi:', error);
      await delay(config.telegramBotRetryDelayMs);
    }
  }

  state.running = false;
}

export function getTelegramBotState() {
  return {
    ...state,
  };
}

export function startTelegramBot() {
  ensureBotToken();

  if (pollingPromise) {
    return pollingPromise;
  }

  stopRequested = false;
  pollingPromise = pollLoop().finally(() => {
    pollingPromise = null;
    state.running = false;
  });

  return pollingPromise;
}

export async function stopTelegramBot() {
  stopRequested = true;
  currentPollController?.abort();

  if (pollingPromise) {
    await pollingPromise.catch(() => null);
  }
}
