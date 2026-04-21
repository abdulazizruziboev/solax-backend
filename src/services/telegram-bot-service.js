import { setTimeout as delay } from 'node:timers/promises';

import { config } from '../config.js';
import { getDb } from '../db.js';
import {
  getSolaxRealtimeSyncState,
  runSolaxRealtimeSyncNow,
  setSolaxRealtimeSyncIntervalMs,
} from './solax-realtime-sync-service.js';
import { getHealthSnapshot } from './user-service.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEVICE_PAGE_SIZE = 6;
const SEARCH_RESULT_LIMIT = 8;
const SESSION_TTL_MS = 10 * 60 * 1000;

const BUTTONS = Object.freeze({
  HOME: 'Bosh menyu',
  DEVICES: 'Qurilmalar',
  MY_ID: 'Mening ID',
  HELP: 'Yordam',
  SEARCH: 'Qurilma qidirish',
  STATS: 'Admin statistika',
  SYNC_SETTINGS: 'Quvvat sync sozlash',
  CANCEL: 'Bekor qilish',
});

const BOT_COMMANDS = [
  { command: 'start', description: 'Botni ishga tushirish' },
  { command: 'menu', description: 'Bosh menyuni ochish' },
  { command: 'help', description: 'Yordam va buyruqlar' },
  { command: 'myid', description: 'Telegram ID ni korish' },
  { command: 'devices', description: 'Qurilmalar royxati' },
  { command: 'device', description: 'Bitta qurilma: /device REG' },
  { command: 'search', description: 'Qurilma qidirish' },
];

const state = {
  enabled: Boolean(config.telegramBotToken),
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

function ensureBotToken() {
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN sozlanmagan');
  }
}

function getTelegramApiUrl(method) {
  return `${TELEGRAM_API_BASE}/bot${config.telegramBotToken}/${method}`;
}

function encodeCallbackValue(value) {
  return encodeURIComponent(String(value ?? ''));
}

function decodeCallbackValue(value) {
  return decodeURIComponent(String(value ?? ''));
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

  if (appUser?.role === 'admin' || appUser?.role === 'super_admin') {
    return true;
  }

  return config.superAdminTelegramIds.includes(cleanTelegramUserId);
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
  return hasAdminAccess(telegramUserId, appUser)
    ? getAllDeviceRows()
    : getDeviceRowsByTelegramId(telegramUserId);
}

function getUserByTelegramId(telegramId) {
  return getDb()
    .prepare(`
      SELECT
        id,
        role,
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

  if (hasAdminAccess(telegramUserId, appUser)) {
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

function buildHomeOnlyInlineKeyboard() {
  return [[{ text: BUTTONS.HOME, callback_data: 'm:home' }]];
}

function buildHomeInlineKeyboard(appUser, telegramUserId) {
  const rows = [
    [
      { text: BUTTONS.DEVICES, callback_data: 'm:list:0' },
      { text: BUTTONS.MY_ID, callback_data: 'm:id' },
    ],
    [
      { text: BUTTONS.SEARCH, callback_data: 'm:search' },
      { text: BUTTONS.HELP, callback_data: 'm:help' },
    ],
  ];

  if (hasAdminAccess(telegramUserId, appUser)) {
    rows.push([
      { text: BUTTONS.STATS, callback_data: 'm:stats' },
      { text: BUTTONS.SYNC_SETTINGS, callback_data: 'm:realtime' },
    ]);
  }

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
    [
      { text: 'Hozir sync', callback_data: 'rt:run' },
      { text: 'Yangilash', callback_data: 'rt:refresh' },
    ],
    [{ text: BUTTONS.HOME, callback_data: 'm:home' }],
  ];

  return rows;
}

function buildDevicesInlineKeyboard(devices, page, totalPages) {
  const rows = devices.map((device) => [
    {
      text: `${getStatusTag(device.onlineStatus)} ${device.registrationNo}`,
      callback_data: `d:view:${page}:${encodeCallbackValue(device.registrationNo)}`,
    },
  ]);

  const navigationRow = [];

  if (page > 0) {
    navigationRow.push({ text: 'Oldingi', callback_data: `m:list:${page - 1}` });
  }

  navigationRow.push({ text: 'Yangilash', callback_data: `m:list:${page}` });

  if (page < totalPages - 1) {
    navigationRow.push({ text: 'Keyingi', callback_data: `m:list:${page + 1}` });
  }

  rows.push(navigationRow);
  rows.push([
    { text: BUTTONS.SEARCH, callback_data: 'm:search' },
    { text: BUTTONS.HOME, callback_data: 'm:home' },
  ]);

  return rows;
}

function buildSearchResultInlineKeyboard(devices) {
  const rows = devices.map((device) => [
    {
      text: `${getStatusTag(device.onlineStatus)} ${device.registrationNo}`,
      callback_data: `d:view:0:${encodeCallbackValue(device.registrationNo)}`,
    },
  ]);

  rows.push([
    { text: BUTTONS.SEARCH, callback_data: 'm:search' },
    { text: BUTTONS.HOME, callback_data: 'm:home' },
  ]);
  return rows;
}

function buildSearchPromptInlineKeyboard() {
  return [
    [{ text: BUTTONS.CANCEL, callback_data: 'm:cancel' }],
    [{ text: BUTTONS.HOME, callback_data: 'm:home' }],
  ];
}

function buildDeviceDetailInlineKeyboard(registrationNo, page) {
  return [
    [
      {
        text: 'Yangilash',
        callback_data: `d:refresh:${page}:${encodeCallbackValue(registrationNo)}`,
      },
      {
        text: 'Royxatga qaytish',
        callback_data: `m:list:${page}`,
      },
    ],
    [
      { text: BUTTONS.SEARCH, callback_data: 'm:search' },
      { text: BUTTONS.HOME, callback_data: 'm:home' },
    ],
  ];
}

function buildHomeText(telegramUserId, appUser) {
  const linkedDevices = getDeviceRowsByTelegramId(telegramUserId);
  const role = getEffectiveRole(telegramUserId, appUser);
  const lines = [
    'Solax bot bosh menyusi',
    `Rol: ${formatRoleLabel(role)}`,
    `Telegram ID: ${telegramUserId}`,
    `Biriktirilgan qurilmalar: ${linkedDevices.length}`,
  ];

  if (hasAdminAccess(telegramUserId, appUser)) {
    const snapshot = getHealthSnapshot();
    lines.push(`Jami qurilmalar: ${snapshot.devices.totalDevices || 0}`);
    lines.push(`Online: ${snapshot.devices.onlineDevices || 0}`);
    lines.push(`Offline: ${snapshot.devices.offlineDevices || 0}`);
  }

  lines.push('');
  lines.push('Quyidagi tugmalardan birini tanlang.');

  return lines.join('\n');
}

function buildWelcomeText(telegramUserId, appUser, displayName) {
  const lines = [
    `Salom, ${displayName}!`,
    'Solax bot ishga tushdi.',
    `Sizning Telegram ID: ${telegramUserId}`,
    '',
  ];

  if (hasAdminAccess(telegramUserId, appUser)) {
    lines.push('Admin panel orqali qurilmalarni boshqarish va foydalanuvchilarga biriktirish mumkin.');
  } else {
    lines.push('Qurilma sizga biriktirilgandan keyin bot orqali uni kuzata olasiz.');
  }

  lines.push('');
  lines.push('Asosiy boshqaruv inline tugmalar orqali ishlaydi.');

  return lines.join('\n');
}

function buildStartText(telegramUserId, appUser, displayName) {
  return [buildWelcomeText(telegramUserId, appUser, displayName), '', buildHomeText(telegramUserId, appUser)].join(
    '\n',
  );
}

function buildHelpText(telegramUserId, appUser) {
  const lines = [
    'Bot imkoniyatlari:',
    `/start - botni ishga tushirish`,
    `/menu - bosh menyu`,
    `/help - yordam`,
    `/myid - Telegram ID`,
    `/devices - qurilmalar royxati`,
    `/device REG - bitta qurilma`,
    `/search - qurilma qidirish`,
    '',
    'Bot faqat inline tugmalar bilan ishlaydi.',
  ];

  if (hasAdminAccess(telegramUserId, appUser)) {
    lines.push(`Inline menyu: ${BUTTONS.DEVICES}, ${BUTTONS.MY_ID}, ${BUTTONS.SEARCH}, ${BUTTONS.HELP}, ${BUTTONS.STATS}`);
  } else {
    lines.push(`Inline menyu: ${BUTTONS.DEVICES}, ${BUTTONS.MY_ID}, ${BUTTONS.SEARCH}, ${BUTTONS.HELP}`);
  }

  lines.push('');
  lines.push('Inline tugmalar orqali royxatni varaqlash, qurilma detallarini ochish va yangilash mumkin.');

  return lines.join('\n');
}

function buildMyIdText(telegramUserId, appUser) {
  const linkedDevices = getDeviceRowsByTelegramId(telegramUserId);
  const role = getEffectiveRole(telegramUserId, appUser);
  const lines = [
    `Sizning Telegram ID: ${telegramUserId}`,
    `Rol: ${formatRoleLabel(role)}`,
    `Biriktirilgan qurilmalar: ${linkedDevices.length}`,
    '',
  ];

  if (hasAdminAccess(telegramUserId, appUser)) {
    lines.push('Bu ID ni admin paneldagi devicega biriktirish mumkin.');
  } else {
    lines.push('Bu ID ni masul xodimga yuboring, shunda device sizga biriktiriladi.');
  }

  return lines.join('\n');
}

function buildStatsText() {
  const snapshot = getHealthSnapshot();
  const alerts = getSystemAlertPreview(5);
  const realtimeSync = getSolaxRealtimeSyncState();
  const lines = [
    'Admin statistika:',
    `Users jami: ${snapshot.users.totalUsers || 0}`,
    `Super admin: ${snapshot.users.superAdmins || 0}`,
    `Admin: ${snapshot.users.admins || 0}`,
    `Oddiy user: ${snapshot.users.users || 0}`,
    `Qurilmalar jami: ${snapshot.devices.totalDevices || 0}`,
    `Online: ${snapshot.devices.onlineDevices || 0}`,
    `Offline: ${snapshot.devices.offlineDevices || 0}`,
    `Alertlar jami: ${snapshot.alerts.totalAlerts || 0}`,
    `Oqilmagan alertlar: ${snapshot.alerts.unreadAlerts || 0}`,
    `Quvvat sync interval: ${formatDurationMs(realtimeSync.intervalMs)}`,
    `Keyingi quvvat sync: ${realtimeSync.nextRunAt || '-'}`,
  ];

  if (alerts.length > 0) {
    lines.push('');
    lines.push('Oxirgi alertlar:');
    for (const alert of alerts) {
      lines.push(
        `- ${alert.registrationNo || '-'} | ${alert.type || 'alert'} | ${alert.createdAt || '-'} | ${
          alert.isRead ? 'read' : 'unread'
        }`,
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
    'Quvvat sync sozlamalari',
    `Holat: ${state.enabled ? 'yoqilgan' : 'ochirilgan yoki token yoq'}`,
    `DBga yozish intervali: ${formatDurationMs(state.intervalMs)}`,
    `Minimal interval: ${formatDurationMs(state.minIntervalMs)}`,
    `Keyingi run: ${nextRunAt || '-'}`,
    `Hozir ishlayaptimi: ${state.isRunning ? 'ha' : 'yoq'}`,
    `Oxirgi muvaffaqiyat: ${state.lastSuccessAt || '-'}`,
  ];

  if (notice) {
    lines.unshift(notice, '');
  }

  if (lastSummary) {
    lines.push('');
    lines.push('Oxirgi natija:');
    lines.push(`- processed: ${lastSummary.processed ?? 0}/${lastSummary.totalTargets ?? 0}`);
    lines.push(`- succeeded: ${lastSummary.succeeded ?? 0}`);
    lines.push(`- failed: ${lastSummary.failed ?? 0}`);
    lines.push(`- skipped: ${lastSummary.skipped ?? 0}`);

    if (lastSummary.quotaLimited) {
      lines.push('- SolaX limitga tushgan');
    }
  }

  lines.push('');
  lines.push('Kerakli intervalni tanlang. Bu qiymat DBga saqlanadi va restartdan keyin ham qoladi.');

  return lines.join('\n');
}

function buildDeviceListText(devices, page, totalPages, title) {
  const start = page * DEVICE_PAGE_SIZE + 1;
  const end = start + devices.length - 1;
  const lines = [
    title,
    `Sahifa: ${page + 1}/${Math.max(totalPages, 1)}`,
    `Korinyapti: ${devices.length > 0 ? `${start}-${end}` : '0'} ta`,
    '',
  ];

  if (devices.length === 0) {
    lines.push('Qurilmalar topilmadi.');
    return lines.join('\n');
  }

  for (const device of devices) {
    const label = device.deviceName || device.plantName || device.userName || 'Nomsiz qurilma';
    lines.push(`${getStatusTag(device.onlineStatus)} ${device.registrationNo} | ${label}`);
  }

  lines.push('');
  lines.push('Batafsil korish uchun pastdagi tugmalardan foydalaning.');

  return lines.join('\n');
}

function buildDeviceDetailsText(device, insights, telegramUserId, appUser) {
  const telegramIds = parseTelegramIds(device.telegramIds);
  const lines = [
    `Qurilma: ${device.registrationNo}`,
    `Holati: ${device.onlineStatus || 'Unknown'}`,
    `Egasi: ${device.userName || '-'}`,
    `Plant: ${device.plantName || '-'}`,
    `Model: ${device.deviceModel || '-'}`,
    `SN: ${device.deviceSn || '-'}`,
    `Tracking: ${device.trackingEnabled ? 'yoqilgan' : 'ochirilgan'}`,
    `Oxirgi tekshiruv: ${device.lastCheckedAt || '-'}`,
    `Oxirgi online vaqti: ${device.lastSeenAt || '-'}`,
    `TG ID: ${telegramIds.length > 0 ? telegramIds.join(', ') : '-'}`,
    '',
    `History yozuvlari: ${insights.historyCount}`,
    `Oxirgi snapshot: ${insights.latestSnapshotMinute || '-'}`,
  ];

  if (insights.latestDaily) {
    lines.push(
      `Kunlik stat: ${insights.latestDaily.date} | Today=${insights.latestDaily.yieldToday ?? 0} | Total=${
        insights.latestDaily.yieldTotal ?? 0
      } | Power=${insights.latestDaily.acPower ?? 0}`,
    );
  }

  if (insights.latestMonthly) {
    lines.push(
      `Oylik stat: ${insights.latestMonthly.month} | Total=${insights.latestMonthly.totalYield ?? 0} | Avg=${
        insights.latestMonthly.avgYield ?? 0
      } | Max=${insights.latestMonthly.maxYield ?? 0}`,
    );
  }

  lines.push(`Alertlar: ${insights.totalAlerts} jami, ${insights.unreadAlerts} oqilmagan`);

  if (insights.recentAlerts.length > 0) {
    lines.push('');
    lines.push('Oxirgi alertlar:');
    for (const alert of insights.recentAlerts) {
      lines.push(`- ${alert.createdAt || '-'} | ${alert.type || 'alert'} | ${alert.message || '-'}`);
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

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await callTelegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || undefined,
      show_alert: false,
    });
  } catch (error) {
    console.error('[telegram-bot] callback answer xatosi:', error.message);
  }
}

export async function sendTelegramMessage(chatId, text, extra = {}) {
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
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
    return sendTelegramMessage(chatId, 'Qurilma topilmadi yoki sizda unga ruxsat yoq.');
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
      'Qurilma topilmadi yoki sizda unga ruxsat yoq.',
      [[{ text: BUTTONS.HOME, callback_data: 'm:home' }]],
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
    [{ text: BUTTONS.HOME, callback_data: 'm:home' }],
  ]);
}

async function editStatsMenu(callbackQuery, telegramUserId, appUser) {
  if (!hasAdminAccess(telegramUserId, appUser)) {
    return editTelegramMessage(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      'Bu bo lim faqat adminlar uchun.',
      [[{ text: BUTTONS.HOME, callback_data: 'm:home' }]],
    );
  }

  return editTelegramMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    buildStatsText(),
    [
      [{ text: BUTTONS.SYNC_SETTINGS, callback_data: 'm:realtime' }],
      [{ text: BUTTONS.HOME, callback_data: 'm:home' }],
    ],
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

function notifyRealtimeSyncResult(chatId, summary) {
  return sendTelegramMessage(
    chatId,
    [
      'Quvvat sync yakunlandi.',
      `Processed: ${summary.processed ?? 0}/${summary.totalTargets ?? 0}`,
      `Succeeded: ${summary.succeeded ?? 0}`,
      `Failed: ${summary.failed ?? 0}`,
      `Skipped: ${summary.skipped ?? 0}`,
      summary.quotaLimited ? 'SolaX limitga tushgan.' : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );
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
      `Qidiruv bo yicha natija topilmadi: ${query}`,
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
      `Qidiruv natijalari (${results.length} ta):`,
      ...results.map((device) => `${getStatusTag(device.onlineStatus)} ${device.registrationNo}`),
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

  if (text === BUTTONS.DEVICES) {
    clearUserSession(message.from.id);
    await sendDevicesMenu(message.chat.id, message.from.id, appUser, 0);
    return true;
  }

  if (text === BUTTONS.MY_ID) {
    clearUserSession(message.from.id);
    await sendInlinePanel(
      message.chat.id,
      buildMyIdText(message.from.id, appUser),
      buildHomeInlineKeyboard(appUser, message.from.id),
    );
    return true;
  }

  if (text === BUTTONS.HELP) {
    clearUserSession(message.from.id);
    await sendInlinePanel(
      message.chat.id,
      buildHelpText(message.from.id, appUser),
      buildHomeInlineKeyboard(appUser, message.from.id),
    );
    return true;
  }

  if (text === BUTTONS.SEARCH) {
    await promptDeviceSearch(message.chat.id, message.from.id, appUser);
    return true;
  }

  if (text === BUTTONS.STATS) {
    clearUserSession(message.from.id);
    await sendStatsMenu(message.chat.id, message.from.id, appUser);
    return true;
  }

  if (text === BUTTONS.SYNC_SETTINGS) {
    clearUserSession(message.from.id);
    await sendRealtimeSyncMenu(message.chat.id, message.from.id, appUser);
    return true;
  }

  if (text === BUTTONS.CANCEL) {
    clearUserSession(message.from.id);
    await sendInlinePanel(
      message.chat.id,
      'Joriy amal bekor qilindi.',
      buildHomeInlineKeyboard(appUser, message.from.id),
    );
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
    case 'menu':
      clearUserSession(message.from.id);
      await sendHomeMenu(message.chat.id, message.from.id, appUser);
      return true;
    case 'help':
      clearUserSession(message.from.id);
      await sendInlinePanel(
        message.chat.id,
        buildHelpText(message.from.id, appUser),
        buildHomeInlineKeyboard(appUser, message.from.id),
      );
      return true;
    case 'myid':
      clearUserSession(message.from.id);
      await sendInlinePanel(
        message.chat.id,
        buildMyIdText(message.from.id, appUser),
        buildHomeInlineKeyboard(appUser, message.from.id),
      );
      return true;
    case 'devices':
      clearUserSession(message.from.id);
      await sendDevicesMenu(message.chat.id, message.from.id, appUser, 0);
      return true;
    case 'device':
      clearUserSession(message.from.id);
      if (!parsedCommand.args) {
        await sendInlinePanel(
          message.chat.id,
          'Foydalanish: /device REGRAQAM',
          buildHomeInlineKeyboard(appUser, message.from.id),
        );
        return true;
      }
      await sendDeviceDetails(message.chat.id, message.from.id, appUser, parsedCommand.args, 0);
      return true;
    case 'search':
      await promptDeviceSearch(message.chat.id, message.from.id, appUser);
      return true;
    case 'stats':
      clearUserSession(message.from.id);
      await sendStatsMenu(message.chat.id, message.from.id, appUser);
      return true;
    case 'sync':
    case 'realtime':
      clearUserSession(message.from.id);
      await sendRealtimeSyncMenu(message.chat.id, message.from.id, appUser);
      return true;
    default:
      await sendInlinePanel(
        message.chat.id,
        `Noma lum buyruq: /${parsedCommand.command}\n/help ni yuboring.`,
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
    if (session?.mode === 'device_search') {
      await handleSearchQuery(message, appUser, text);
      return;
    }

    await sendInlinePanel(
      message.chat.id,
      [
        'Xabar qabul qilindi, lekin men uni buyruq sifatida tani olmadim.',
        'Inline tugmalardan foydalaning yoki /help ni yuboring.',
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

  try {
    if (parsed.group === 'm') {
      switch (parsed.action) {
        case 'home':
          clearUserSession(callbackQuery.from.id);
          await editHomeMenu(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Bosh menyu');
          return;
        case 'help':
          await editTelegramMessage(
            callbackQuery.message.chat.id,
            callbackQuery.message.message_id,
            buildHelpText(callbackQuery.from.id, appUser),
            buildHomeInlineKeyboard(appUser, callbackQuery.from.id),
          );
          await answerCallbackQuery(callbackQuery.id, 'Yordam');
          return;
        case 'id':
          await editTelegramMessage(
            callbackQuery.message.chat.id,
            callbackQuery.message.message_id,
            buildMyIdText(callbackQuery.from.id, appUser),
            buildHomeInlineKeyboard(appUser, callbackQuery.from.id),
          );
          await answerCallbackQuery(callbackQuery.id, 'Telegram ID');
          return;
        case 'list': {
          const page = Number.parseInt(parsed.parts[2] || '0', 10) || 0;
          await editDevicesMenu(callbackQuery, callbackQuery.from.id, appUser, page);
          await answerCallbackQuery(callbackQuery.id, `Sahifa ${page + 1}`);
          return;
        }
        case 'search':
          await editSearchPrompt(callbackQuery, callbackQuery.from.id);
          await answerCallbackQuery(callbackQuery.id, 'Qidiruv rejimi yoqildi');
          return;
        case 'cancel':
          clearUserSession(callbackQuery.from.id);
          await editHomeMenu(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Bekor qilindi');
          return;
        case 'stats':
          await editStatsMenu(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Admin statistika');
          return;
        case 'realtime':
          await editRealtimeSyncMenu(callbackQuery, callbackQuery.from.id, appUser);
          await answerCallbackQuery(callbackQuery.id, 'Quvvat sync sozlamalari');
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
        case 'run': {
          await answerCallbackQuery(callbackQuery.id, 'Manual sync boshlandi');
          await editRealtimeSyncMenu(callbackQuery, callbackQuery.from.id, appUser, 'Manual sync boshlandi.');
          runSolaxRealtimeSyncNow('telegram-bot')
            .then((summary) => notifyRealtimeSyncResult(callbackQuery.message.chat.id, summary))
            .catch((error) =>
              sendTelegramMessage(callbackQuery.message.chat.id, `Quvvat sync xatosi: ${error.message}`).catch(
                () => null,
              ),
            );
          return;
        }
        default:
          await answerCallbackQuery(callbackQuery.id, 'Noma lum sync amali');
          return;
      }
    }

    if (parsed.group === 'd') {
      const page = Number.parseInt(parsed.parts[2] || '0', 10) || 0;
      const registrationNo = decodeCallbackValue(parsed.parts[3] || '');

      switch (parsed.action) {
        case 'view':
          await editDeviceDetails(callbackQuery, callbackQuery.from.id, appUser, registrationNo, page);
          await answerCallbackQuery(callbackQuery.id, registrationNo);
          return;
        case 'refresh':
          await editDeviceDetails(callbackQuery, callbackQuery.from.id, appUser, registrationNo, page);
          await answerCallbackQuery(callbackQuery.id, 'Yangilandi');
          return;
        default:
          await answerCallbackQuery(callbackQuery.id, 'Noma lum qurilma amali');
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
      await handleIncomingMessage(update.message);
      state.lastHandledAt = new Date().toISOString();
      continue;
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
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
