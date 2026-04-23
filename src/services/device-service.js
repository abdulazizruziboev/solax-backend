import { getDb } from '../db.js';
import { DEVICE_STATUSES } from '../constants.js';
import { AppError } from '../middleware/errors.js';
import { getSetting, setSetting } from './settings-service.js';

const DEVICES_VISIBLE_TO_ALL_SETTING_KEY = 'devices.visibleToAll';
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const ENERGY_CHART_POINTS = Object.freeze([
  ...Array.from({ length: 20 }, (_item, index) => {
    const hour = index + 4;
    return {
      time: `${String(hour).padStart(2, '0')}:00`,
      minute: hour * 60,
    };
  }),
  { time: '23:59', minute: 23 * 60 + 59 },
]);
const TELEGRAM_ID_PAYLOAD_KEYS = Object.freeze([
  'telegramIds',
  'telegramId',
  'telegram_id',
  'tgId',
  'tg_id',
  'userTelegramId',
  'userTelegramIds',
]);
const USER_ID_PAYLOAD_KEYS = Object.freeze([
  'userId',
  'userIds',
  'appUserId',
  'appUserIds',
  'assignedUserId',
  'assignedUserIds',
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasAnyOwn(object, keys) {
  return keys.some((key) => hasOwn(object, key));
}

function getFirstOwnValue(object, keys) {
  for (const key of keys) {
    if (hasOwn(object, key)) {
      return object[key];
    }
  }

  return undefined;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function parseDateInput(value) {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'number') {
    return new Date(value);
  }

  const text = String(value || '').trim();
  const localDateTimeMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );

  if (localDateTimeMatch) {
    const [, year, month, day, hour = '00', minute = '00', second = '00'] = localDateTimeMatch;
    return new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour) - 5,
        Number(minute),
        Number(second),
      ),
    );
  }

  return new Date(value);
}

function toTashkentSqlDateTime(value) {
  const date = parseDateInput(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError(400, `Sana noto'g'ri: ${value}`);
  }

  return new Date(date.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

function toTashkentDate(value = Date.now()) {
  return toTashkentSqlDateTime(value).slice(0, 10);
}

function toSqlDateTime(value) {
  return toTashkentSqlDateTime(value);
}

function normaliseText(value, { label, required = false, maxLength = 255 } = {}) {
  const text = String(value ?? '').trim();

  if (!text) {
    if (required) {
      throw new AppError(400, `${label} yuborilishi kerak`);
    }

    return null;
  }

  if (text.length > maxLength) {
    throw new AppError(400, `${label} juda uzun`);
  }

  return text;
}

function normaliseStatus(value, fallback = 'Unknown') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const status = String(value).trim();
  if (!DEVICE_STATUSES.includes(status)) {
    throw new AppError(400, `onlineStatus faqat ${DEVICE_STATUSES.join(', ')} bo'lishi mumkin`);
  }

  return status;
}

function normaliseOptionalDate(value, label) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === '') {
    return null;
  }

  return toSqlDateTime(value);
}

function normaliseOptionalInteger(value, label) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === '') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new AppError(400, `${label} butun son bo'lishi kerak`);
  }

  return parsed;
}

function normaliseTrackingEnabled(value, fallback = 1) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (value === 1 || value === '1' || value === 'true') {
    return 1;
  }

  if (value === 0 || value === '0' || value === 'false') {
    return 0;
  }

  throw new AppError(400, "trackingEnabled true/false yoki 1/0 bo'lishi kerak");
}

function normaliseBooleanFlag(value, label) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 1 || value === '1' || value === 'true' || value === 'on') {
    return true;
  }

  if (value === 0 || value === '0' || value === 'false' || value === 'off') {
    return false;
  }

  throw new AppError(400, `${label} true/false yoki 1/0 bo'lishi kerak`);
}

function normaliseTelegramId(value) {
  const text = String(value ?? '').trim();

  if (!text) {
    return null;
  }

  if (!/^-?\d{5,20}$/.test(text)) {
    throw new AppError(400, "Telegram ID faqat raqamlardan iborat bo'lishi kerak");
  }

  return text;
}

function resolveTelegramIdFromUserId(userId) {
  const cleanUserId = normaliseOptionalInteger(userId, 'userId');

  if (!cleanUserId) {
    return null;
  }

  const user = getDb()
    .prepare(
      `
        SELECT id, telegramId, status
        FROM app_users
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(cleanUserId);

  if (!user) {
    throw new AppError(404, 'Foydalanuvchi topilmadi');
  }

  if (user.status !== 'active') {
    throw new AppError(400, 'Bloklangan foydalanuvchini devicega biriktirib bo\'lmaydi');
  }

  if (!user.telegramId) {
    throw new AppError(400, 'Foydalanuvchida Telegram ID yo\'q');
  }

  return normaliseTelegramId(user.telegramId);
}

function normaliseTelegramIdsFromUserIds(value) {
  if (value === undefined) {
    return undefined;
  }

  const source = Array.isArray(value) ? value : [value];
  const deduped = [];

  for (const item of source) {
    const normalised = resolveTelegramIdFromUserId(item);
    if (normalised && !deduped.includes(normalised)) {
      deduped.push(normalised);
    }
  }

  return deduped;
}

function normaliseTelegramIdCandidate(value) {
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return normaliseTelegramId(value);
  }

  if (hasAnyOwn(value, TELEGRAM_ID_PAYLOAD_KEYS)) {
    return normaliseTelegramId(getFirstOwnValue(value, TELEGRAM_ID_PAYLOAD_KEYS));
  }

  if (hasAnyOwn(value, USER_ID_PAYLOAD_KEYS)) {
    return resolveTelegramIdFromUserId(getFirstOwnValue(value, USER_ID_PAYLOAD_KEYS));
  }

  if (hasOwn(value, 'id')) {
    return resolveTelegramIdFromUserId(value.id);
  }

  throw new AppError(400, 'Telegram ID yoki userId yuborilishi kerak');
}

function normaliseTelegramIds(value) {
  if (value === undefined) {
    return undefined;
  }

  const source = Array.isArray(value) ? value : [value];
  const deduped = [];

  for (const item of source) {
    const normalised = normaliseTelegramIdCandidate(item);
    if (normalised && !deduped.includes(normalised)) {
      deduped.push(normalised);
    }
  }

  return deduped;
}

function normaliseTelegramIdsFromPayload(payload, fallback = undefined) {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  if (hasAnyOwn(payload, TELEGRAM_ID_PAYLOAD_KEYS)) {
    return normaliseTelegramIds(getFirstOwnValue(payload, TELEGRAM_ID_PAYLOAD_KEYS)) ?? [];
  }

  if (hasAnyOwn(payload, USER_ID_PAYLOAD_KEYS)) {
    return normaliseTelegramIdsFromUserIds(getFirstOwnValue(payload, USER_ID_PAYLOAD_KEYS)) ?? [];
  }

  return fallback;
}

function serialiseTelegramIds(value) {
  return JSON.stringify(normaliseTelegramIds(value) ?? []);
}

function parseTelegramIds(value) {
  if (!value) {
    return [];
  }

  try {
    return normaliseTelegramIds(JSON.parse(value)) ?? [];
  } catch (_error) {
    return [];
  }
}

function toMinuteBucket(value) {
  const date = parseDateInput(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError(400, `Sana noto'g'ri: ${value}`);
  }

  date.setUTCSeconds(0, 0);
  return toSqlDateTime(date);
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundChartValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }

  return Number(Math.max(0, number).toFixed(2));
}

function normaliseChartDate(value = null) {
  if (value === undefined || value === null || value === '') {
    return toTashkentDate();
  }

  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const date = parseDateInput(text);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError(400, "date YYYY-MM-DD formatida bo'lishi kerak");
  }

  return toTashkentDate(date);
}

function minuteOfDay(value) {
  const match = String(value || '').match(/\b(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

function normalisePowerValue(value) {
  const number = toNumberOrNull(value);
  if (number === null) {
    return null;
  }

  // SolaX may return acPower in W on some accounts and kW on others.
  const kilowatts = Math.abs(number) > 1000 ? number / 1000 : number;
  return roundChartValue(kilowatts);
}

function getNearestPowerValue(rows, minute) {
  let nearestRow = null;
  let nearestDistance = Number.MAX_SAFE_INTEGER;

  for (const row of rows) {
    const rowMinute = minuteOfDay(row.snapshotMinute);
    if (rowMinute === null) {
      continue;
    }

    const distance = Math.abs(rowMinute - minute);
    if (distance < nearestDistance) {
      nearestRow = row;
      nearestDistance = distance;
    }
  }

  return normalisePowerValue(nearestRow?.acPower) ?? 0;
}

function buildActualEnergyChartData(rows) {
  const cleanRows = rows.filter((row) => normalisePowerValue(row.acPower) !== null);
  if (cleanRows.length < 3) {
    return null;
  }

  return ENERGY_CHART_POINTS.map((point) => ({
    time: point.time,
    value: getNearestPowerValue(cleanRows, point.minute),
  }));
}

function buildEstimatedEnergyChartData(totalEnergy) {
  return ENERGY_CHART_POINTS.map((point) => ({
    time: point.time,
    value: point.time === '23:59' ? roundChartValue(totalEnergy) : 0,
  }));
}

function groupYieldRowsByDevice(rows) {
  const groupedRows = new Map();

  for (const row of rows) {
    const key = String(row.registrationNo || '').trim();
    if (!key) {
      continue;
    }

    const value = toNumberOrNull(row.yieldToday);
    const minute = minuteOfDay(row.snapshotMinute);
    if (value === null || minute === null) {
      continue;
    }

    if (!groupedRows.has(key)) {
      groupedRows.set(key, []);
    }

    groupedRows.get(key).push({
      minute,
      value,
    });
  }

  for (const deviceRows of groupedRows.values()) {
    deviceRows.sort((left, right) => left.minute - right.minute);
  }

  return groupedRows;
}

function getCumulativeYieldAt(groupedRows, minute) {
  let total = 0;

  for (const deviceRows of groupedRows.values()) {
    let latestValue = 0;

    for (const row of deviceRows) {
      if (row.minute > minute) {
        break;
      }

      latestValue = row.value;
    }

    total += latestValue;
  }

  return roundChartValue(total);
}

function getCurrentTashkentMinute() {
  const time = toTashkentSqlDateTime(Date.now()).slice(11, 16);
  return minuteOfDay(time) ?? 0;
}

function buildLatestTotalEnergyChartData(totalEnergy) {
  const currentMinute = getCurrentTashkentMinute();
  let totalAssigned = false;

  return ENERGY_CHART_POINTS.map((point) => {
    const shouldAssignTotal = !totalAssigned && point.minute >= currentMinute;
    if (shouldAssignTotal) {
      totalAssigned = true;
    }

    return {
      time: point.time,
      value: shouldAssignTotal || (!totalAssigned && point.time === '23:59') ? roundChartValue(totalEnergy) : 0,
    };
  });
}

function buildHourlyYieldChartData(rows, totalEnergy) {
  const groupedRows = groupYieldRowsByDevice(rows);
  if (groupedRows.size === 0) {
    return buildLatestTotalEnergyChartData(totalEnergy);
  }

  let previousCumulative = getCumulativeYieldAt(groupedRows, 0);

  return ENERGY_CHART_POINTS.map((point) => {
    const cumulative = getCumulativeYieldAt(groupedRows, point.minute);
    const value = roundChartValue(Math.max(0, cumulative - previousCumulative));
    previousCumulative = cumulative;

    return {
      time: point.time,
      value,
    };
  });
}

function getDailyEnergyTotal(db, date, registrationNo = null) {
  if (registrationNo) {
    const dailyRow = db
      .prepare(
        `
          SELECT COALESCE(yieldToday, 0) AS total
          FROM daily_stats
          WHERE registrationNo = ?
            AND date = ?
          LIMIT 1
        `,
      )
      .get(registrationNo, date);

    if (dailyRow && Number(dailyRow.total) > 0) {
      return roundChartValue(dailyRow.total);
    }

    const historyRow = db
      .prepare(
        `
          SELECT COALESCE(MAX(yieldToday), 0) AS total
          FROM device_status_history
          WHERE registrationNo = ?
            AND DATE(snapshotMinute) = ?
        `,
      )
      .get(registrationNo, date);

    return roundChartValue(historyRow?.total ?? 0);
  }

  const dailyRow = db
    .prepare(
      `
        SELECT COALESCE(SUM(COALESCE(yieldToday, 0)), 0) AS total
        FROM daily_stats
        WHERE date = ?
      `,
    )
    .get(date);

  if (dailyRow && Number(dailyRow.total) > 0) {
    return roundChartValue(dailyRow.total);
  }

  const historyRow = db
    .prepare(
      `
        SELECT COALESCE(SUM(total), 0) AS total
        FROM (
          SELECT registrationNo, MAX(yieldToday) AS total
          FROM device_status_history
          WHERE DATE(snapshotMinute) = ?
          GROUP BY registrationNo
        )
      `,
    )
    .get(date);

  return roundChartValue(historyRow?.total ?? 0);
}

function getPowerHistoryRows(db, date, registrationNo = null) {
  if (registrationNo) {
    return db
      .prepare(
        `
          SELECT snapshotMinute, acPower
          FROM device_status_history
          WHERE registrationNo = ?
            AND DATE(snapshotMinute) = ?
            AND acPower IS NOT NULL
          ORDER BY snapshotMinute ASC
        `,
      )
      .all(registrationNo, date);
  }

  return db
    .prepare(
      `
        SELECT snapshotMinute, SUM(acPower) AS acPower
        FROM device_status_history
        WHERE DATE(snapshotMinute) = ?
          AND acPower IS NOT NULL
        GROUP BY snapshotMinute
        ORDER BY snapshotMinute ASC
      `,
    )
    .all(date);
}

function getYieldHistoryRows(db, date, registrationNo = null) {
  if (registrationNo) {
    return db
      .prepare(
        `
          SELECT registrationNo, snapshotMinute, yieldToday
          FROM device_status_history
          WHERE registrationNo = ?
            AND DATE(snapshotMinute) = ?
            AND yieldToday IS NOT NULL
          ORDER BY registrationNo ASC, snapshotMinute ASC
        `,
      )
      .all(registrationNo, date);
  }

  return db
    .prepare(
      `
        SELECT registrationNo, snapshotMinute, yieldToday
        FROM device_status_history
        WHERE DATE(snapshotMinute) = ?
          AND yieldToday IS NOT NULL
        ORDER BY registrationNo ASC, snapshotMinute ASC
      `,
    )
    .all(date);
}

function getEnergyChartDeviceCount(db, registrationNo = null) {
  if (registrationNo) {
    return 1;
  }

  const row = db.prepare('SELECT COUNT(*) AS count FROM devices').get();
  return row?.count ?? 0;
}

function getEnergyChartDataDeviceCount(db, date, registrationNo = null) {
  if (registrationNo) {
    const row = db
      .prepare(
        `
          SELECT
            (
              EXISTS(
                SELECT 1
                FROM daily_stats
                WHERE registrationNo = ?
                  AND date = ?
              )
              OR EXISTS(
                SELECT 1
                FROM device_status_history
                WHERE registrationNo = ?
                  AND DATE(snapshotMinute) = ?
                  AND (yieldToday IS NOT NULL OR acPower IS NOT NULL)
              )
            ) AS hasData
        `,
      )
      .get(registrationNo, date, registrationNo, date);

    return row?.hasData ? 1 : 0;
  }

  const row = db
    .prepare(
      `
        SELECT COUNT(DISTINCT registrationNo) AS count
        FROM (
          SELECT registrationNo
          FROM daily_stats
          WHERE date = ?
            AND yieldToday IS NOT NULL
          UNION
          SELECT registrationNo
          FROM device_status_history
          WHERE DATE(snapshotMinute) = ?
            AND (yieldToday IS NOT NULL OR acPower IS NOT NULL)
        )
      `,
    )
    .get(date, date);

  return row?.count ?? 0;
}

function resolveSyncedTextField(rawDevice, keys, existingValue, options) {
  if (!rawDevice || !hasAnyOwn(rawDevice, keys)) {
    return existingValue ?? null;
  }

  return normaliseText(getFirstOwnValue(rawDevice, keys), options);
}

function resolveSyncedIntegerField(rawDevice, keys, existingValue, label, fallbackValue = null) {
  if (!rawDevice || !hasAnyOwn(rawDevice, keys)) {
    return existingValue ?? fallbackValue;
  }

  return normaliseOptionalInteger(getFirstOwnValue(rawDevice, keys), label);
}

function buildSyncedDevicePayload(rawDevice, existingDevice, { registrationNo, syncedAt, source }) {
  const onlineStatus = normaliseStatus(
    firstDefined(rawDevice?.onlineStatus, rawDevice?.status, existingDevice?.onlineStatus, 'Unknown'),
    'Unknown',
  );
  const explicitLastSeenAt =
    rawDevice && hasAnyOwn(rawDevice, ['lastSeenAt', 'last_seen_at'])
      ? normaliseOptionalDate(getFirstOwnValue(rawDevice, ['lastSeenAt', 'last_seen_at']), 'lastSeenAt')
      : undefined;
  const existingLastSeenAt = existingDevice?.lastSeenAt ?? null;
  const nextLastSeenAt =
    explicitLastSeenAt !== undefined
      ? explicitLastSeenAt
      : onlineStatus === 'Online'
        ? syncedAt
        : existingLastSeenAt;
  const existingTelegramIds = parseTelegramIds(existingDevice?.telegramIds);
  const nextTelegramIds =
    rawDevice && hasAnyOwn(rawDevice, ['telegramIds', 'telegramId', 'tgId', 'telegram_id'])
      ? normaliseTelegramIds(
          firstDefined(
            rawDevice.telegramIds,
            rawDevice.telegramId,
            rawDevice.tgId,
            rawDevice.telegram_id,
          ),
        ) ?? []
      : existingTelegramIds;

  return {
    registrationNo,
    deviceSn: resolveSyncedTextField(rawDevice, ['deviceSn', 'deviceSN'], existingDevice?.deviceSn, {
      label: 'deviceSn',
      maxLength: 100,
    }),
    userName: resolveSyncedTextField(rawDevice, ['userName', 'username'], existingDevice?.userName, {
      label: 'userName',
      maxLength: 150,
    }),
    plantName: resolveSyncedTextField(rawDevice, ['plantName', 'plant_name'], existingDevice?.plantName, {
      label: 'plantName',
      maxLength: 255,
    }),
    deviceModel: resolveSyncedTextField(rawDevice, ['deviceModel', 'model'], existingDevice?.deviceModel, {
      label: 'deviceModel',
      maxLength: 100,
    }),
    telegramIds: nextTelegramIds,
    onlineStatus,
    lastSeenAt: nextLastSeenAt,
    lastCheckedAt: syncedAt,
    addedAt: existingDevice?.addedAt ?? syncedAt,
    deviceNo: resolveSyncedIntegerField(rawDevice, ['deviceNo', 'no'], existingDevice?.deviceNo, 'deviceNo'),
    deviceName: resolveSyncedTextField(rawDevice, ['deviceName', 'name'], existingDevice?.deviceName, {
      label: 'deviceName',
      maxLength: 100,
    }),
    source:
      resolveSyncedTextField(rawDevice, ['source'], existingDevice?.source, {
        label: 'source',
        maxLength: 50,
      }) ?? source,
    trackingEnabled:
      rawDevice && hasOwn(rawDevice, 'trackingEnabled')
        ? normaliseTrackingEnabled(rawDevice.trackingEnabled, existingDevice?.trackingEnabled ?? 1)
        : existingDevice?.trackingEnabled ?? 1,
  };
}

function serializeDevice(device) {
  if (!device) {
    return null;
  }

  return {
    registrationNo: device.registrationNo,
    deviceSn: device.deviceSn,
    userName: device.userName,
    plantName: device.plantName,
    deviceModel: device.deviceModel,
    telegramIds: parseTelegramIds(device.telegramIds),
    onlineStatus: device.onlineStatus,
    lastSeenAt: device.lastSeenAt,
    lastCheckedAt: device.lastCheckedAt,
    addedAt: device.addedAt,
    deviceNo: device.deviceNo,
    deviceName: device.deviceName,
    source: device.source,
    trackingEnabled: Boolean(device.trackingEnabled),
    yieldToday: hasOwn(device, 'yieldToday') ? roundChartValue(device.yieldToday) : undefined,
    yieldTotal: hasOwn(device, 'yieldTotal') ? roundChartValue(device.yieldTotal) : undefined,
    acPower: hasOwn(device, 'acPower') ? roundChartValue(device.acPower) : undefined,
    realtimeUpdatedAt: hasOwn(device, 'realtimeUpdatedAt') ? device.realtimeUpdatedAt : undefined,
    statsDate: hasOwn(device, 'statsDate') ? device.statsDate : undefined,
    hasTodayStats: hasOwn(device, 'hasTodayStats') ? Boolean(device.hasTodayStats) : undefined,
  };
}

function getDeviceRow(registrationNo) {
  return getDb()
    .prepare(
      `
        SELECT
          d.*,
          COALESCE(ds.yieldToday, 0) AS yieldToday,
          ds.yieldTotal,
          ds.acPower,
          ds.updatedAt AS realtimeUpdatedAt,
          ds.date AS statsDate,
          CASE WHEN ds.registrationNo IS NULL THEN 0 ELSE 1 END AS hasTodayStats
        FROM devices d
        LEFT JOIN daily_stats ds
          ON ds.registrationNo = d.registrationNo
          AND ds.date = ?
        WHERE d.registrationNo = ?
      `,
    )
    .get(toTashkentDate(), registrationNo);
}

function getNextDeviceNo() {
  const row = getDb().prepare('SELECT COALESCE(MAX(deviceNo), 0) + 1 AS nextDeviceNo FROM devices').get();
  return row.nextDeviceNo;
}

export function getDeviceTotals() {
  const totals = getDb().prepare(`
    SELECT
      COUNT(*) AS totalDevices,
      COALESCE(SUM(CASE WHEN onlineStatus = 'Online' THEN 1 ELSE 0 END), 0) AS onlineDevices,
      COALESCE(SUM(CASE WHEN onlineStatus = 'Offline' THEN 1 ELSE 0 END), 0) AS offlineDevices,
      COALESCE(SUM(CASE WHEN onlineStatus = 'Unknown' OR onlineStatus IS NULL OR onlineStatus = '' THEN 1 ELSE 0 END), 0) AS unknownDevices
    FROM devices
  `).get();

  return {
    totalDevices: totals.totalDevices ?? 0,
    onlineDevices: totals.onlineDevices ?? 0,
    offlineDevices: totals.offlineDevices ?? 0,
    unknownDevices: totals.unknownDevices ?? 0,
  };
}

export function areDevicesVisibleToAll() {
  return getSetting(DEVICES_VISIBLE_TO_ALL_SETTING_KEY, 'false') === 'true';
}

export function getDeviceVisibilitySettings() {
  return {
    devicesVisibleToAll: areDevicesVisibleToAll(),
  };
}

export function setDevicesVisibleToAll(value, { updatedBy = null } = {}) {
  const enabled = normaliseBooleanFlag(value, 'devicesVisibleToAll');
  setSetting(DEVICES_VISIBLE_TO_ALL_SETTING_KEY, enabled ? 'true' : 'false', { updatedBy });
  return getDeviceVisibilitySettings();
}

export function listDevices({ search, status, source, trackingEnabled, page = 1, pageSize = 25 }) {
  const db = getDb();
  const filters = [];
  const params = [];

  if (search) {
    const wildcard = `%${String(search).trim()}%`;
    filters.push(`
      (
        d.registrationNo LIKE ?
        OR COALESCE(d.deviceSn, '') LIKE ?
        OR COALESCE(d.userName, '') LIKE ?
        OR COALESCE(d.plantName, '') LIKE ?
        OR COALESCE(d.deviceModel, '') LIKE ?
        OR COALESCE(d.deviceName, '') LIKE ?
        OR COALESCE(d.telegramIds, '') LIKE ?
      )
    `);
    params.push(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard);
  }

  if (status) {
    params.push(normaliseStatus(status));
    filters.push('d.onlineStatus = ?');
  }

  if (source) {
    params.push(String(source).trim());
    filters.push('d.source = ?');
  }

  if (trackingEnabled !== undefined) {
    params.push(normaliseTrackingEnabled(trackingEnabled));
    filters.push('d.trackingEnabled = ?');
  }

  const cleanPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const cleanPageSize = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 25));
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS count FROM devices d ${whereClause}`).get(...params).count;
  const statsDate = toTashkentDate();
  const rows = db.prepare(`
    SELECT
      d.registrationNo,
      d.deviceSn,
      d.userName,
      d.plantName,
      d.deviceModel,
      d.telegramIds,
      d.onlineStatus,
      d.lastSeenAt,
      d.lastCheckedAt,
      d.addedAt,
      d.deviceNo,
      d.deviceName,
      d.source,
      d.trackingEnabled,
      COALESCE(ds.yieldToday, 0) AS yieldToday,
      ds.yieldTotal,
      ds.acPower,
      ds.updatedAt AS realtimeUpdatedAt,
      ds.date AS statsDate,
      CASE WHEN ds.registrationNo IS NULL THEN 0 ELSE 1 END AS hasTodayStats
    FROM devices d
    LEFT JOIN daily_stats ds
      ON ds.registrationNo = d.registrationNo
      AND ds.date = ?
    ${whereClause}
    ORDER BY COALESCE(d.deviceNo, 999999999) ASC, d.registrationNo ASC
    LIMIT ? OFFSET ?
  `).all(statsDate, ...params, cleanPageSize, (cleanPage - 1) * cleanPageSize);

  return {
    visibility: getDeviceVisibilitySettings(),
    pagination: {
      page: cleanPage,
      pageSize: cleanPageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / cleanPageSize)),
    },
    devices: rows.map(serializeDevice),
  };
}

export function listDevicesByTelegramId(telegramId) {
  const cleanTelegramId = normaliseTelegramId(telegramId);

  if (!cleanTelegramId) {
    throw new AppError(400, 'telegramId yuborilishi kerak');
  }

  const statsDate = toTashkentDate();

  if (areDevicesVisibleToAll()) {
    const rows = getDb()
      .prepare(`
        SELECT
          d.registrationNo,
          d.deviceSn,
          d.userName,
          d.plantName,
          d.deviceModel,
          d.telegramIds,
          d.onlineStatus,
          d.lastSeenAt,
          d.lastCheckedAt,
          d.addedAt,
          d.deviceNo,
          d.deviceName,
          d.source,
          d.trackingEnabled,
          COALESCE(ds.yieldToday, 0) AS yieldToday,
          ds.yieldTotal,
          ds.acPower,
          ds.updatedAt AS realtimeUpdatedAt,
          ds.date AS statsDate,
          CASE WHEN ds.registrationNo IS NULL THEN 0 ELSE 1 END AS hasTodayStats
        FROM devices d
        LEFT JOIN daily_stats ds
          ON ds.registrationNo = d.registrationNo
          AND ds.date = ?
        ORDER BY COALESCE(d.deviceNo, 999999999) ASC, d.registrationNo ASC
      `)
      .all(statsDate);

    return {
      telegramId: cleanTelegramId,
      scope: 'all-devices',
      visibility: getDeviceVisibilitySettings(),
      total: rows.length,
      devices: rows.map(serializeDevice),
    };
  }

  const rows = getDb()
    .prepare(`
      SELECT
        d.registrationNo,
        d.deviceSn,
        d.userName,
        d.plantName,
        d.deviceModel,
        d.telegramIds,
        d.onlineStatus,
        d.lastSeenAt,
        d.lastCheckedAt,
        d.addedAt,
        d.deviceNo,
        d.deviceName,
        d.source,
        d.trackingEnabled,
        COALESCE(ds.yieldToday, 0) AS yieldToday,
        ds.yieldTotal,
        ds.acPower,
        ds.updatedAt AS realtimeUpdatedAt,
        ds.date AS statsDate,
        CASE WHEN ds.registrationNo IS NULL THEN 0 ELSE 1 END AS hasTodayStats
      FROM devices d
      LEFT JOIN daily_stats ds
        ON ds.registrationNo = d.registrationNo
        AND ds.date = ?
      WHERE COALESCE(d.telegramIds, '') LIKE ?
      ORDER BY COALESCE(d.deviceNo, 999999999) ASC, d.registrationNo ASC
    `)
    .all(statsDate, `%${cleanTelegramId}%`)
    .filter((row) => parseTelegramIds(row.telegramIds).includes(cleanTelegramId));

  return {
    telegramId: cleanTelegramId,
    scope: 'telegram',
    visibility: getDeviceVisibilitySettings(),
    total: rows.length,
    devices: rows.map(serializeDevice),
  };
}

export function getDeviceByRegistrationNo(registrationNo) {
  const cleanRegistrationNo = normaliseText(registrationNo, {
    label: 'registrationNo',
    required: true,
    maxLength: 100,
  });

  const device = getDeviceRow(cleanRegistrationNo);
  if (!device) {
    throw new AppError(404, 'Device topilmadi');
  }

  return serializeDevice(device);
}

export function getEnergyChart({ registrationNo = null, date = null } = {}) {
  const db = getDb();
  const cleanDate = normaliseChartDate(date);
  const cleanRegistrationNo =
    registrationNo === null || registrationNo === undefined || registrationNo === ''
      ? null
      : normaliseText(registrationNo, {
          label: 'registrationNo',
          required: true,
          maxLength: 100,
        });

  let device = null;
  if (cleanRegistrationNo) {
    device = getDeviceRow(cleanRegistrationNo);
    if (!device) {
      throw new AppError(404, 'Device topilmadi');
    }
  }

  const total = getDailyEnergyTotal(db, cleanDate, cleanRegistrationNo);
  const yieldRows = getYieldHistoryRows(db, cleanDate, cleanRegistrationNo);
  const data = buildHourlyYieldChartData(yieldRows, total);

  return {
    scope: cleanRegistrationNo ? 'device' : 'all-devices',
    date: cleanDate,
    registrationNo: cleanRegistrationNo,
    total,
    unit: 'kWh',
    valueUnit: 'kWh',
    source: 'device_status_history.yieldToday',
    deviceCount: getEnergyChartDeviceCount(db, cleanRegistrationNo),
    dataDeviceCount: getEnergyChartDataDeviceCount(db, cleanDate, cleanRegistrationNo),
    timeZone: 'Asia/Tashkent',
    offset: '+05:00',
    data,
    device: device ? serializeDevice(device) : null,
  };
}

export function listRealtimeSyncTargets() {
  return getDb()
    .prepare(`
      SELECT
        registrationNo,
        deviceSn,
        onlineStatus,
        trackingEnabled
      FROM devices
      WHERE trackingEnabled = 1
        AND COALESCE(deviceSn, '') != ''
      ORDER BY COALESCE(deviceNo, 999999999) ASC, registrationNo ASC
    `)
    .all()
    .map((row) => ({
      registrationNo: row.registrationNo,
      deviceSn: row.deviceSn,
      onlineStatus: row.onlineStatus,
      trackingEnabled: Boolean(row.trackingEnabled),
    }));
}

export function saveDeviceRealtimeStats({
  registrationNo,
  deviceSn,
  collectedAt = Date.now(),
  uploadedAt,
  acPower,
  yieldToday,
  yieldTotal,
  source = 'solax-realtime-api',
}) {
  const cleanRegistrationNo = normaliseText(registrationNo, {
    label: 'registrationNo',
    required: true,
    maxLength: 100,
  });
  const cleanDeviceSn = normaliseText(deviceSn, { label: 'deviceSn', maxLength: 100 });
  const collectedAtSql = toSqlDateTime(collectedAt);
  const realtimeUpdatedAtSql = uploadedAt ? toSqlDateTime(uploadedAt) : collectedAtSql;
  const snapshotMinute = toMinuteBucket(realtimeUpdatedAtSql);
  const date = realtimeUpdatedAtSql.slice(0, 10);
  const month = date.slice(0, 7);
  const nextAcPower = toNumberOrNull(acPower);
  const nextYieldToday = toNumberOrNull(yieldToday);
  const nextYieldTotal = toNumberOrNull(yieldTotal);
  const db = getDb();

  db.exec('BEGIN');

  try {
    db.prepare(`
      INSERT INTO daily_stats (
        registrationNo,
        date,
        yieldToday,
        yieldTotal,
        acPower,
        updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(registrationNo, date) DO UPDATE SET
        yieldToday = excluded.yieldToday,
        yieldTotal = excluded.yieldTotal,
        acPower = excluded.acPower,
        updatedAt = excluded.updatedAt
    `).run(cleanRegistrationNo, date, nextYieldToday, nextYieldTotal, nextAcPower, realtimeUpdatedAtSql);

    db.prepare(`
      INSERT INTO device_status_history (
        registrationNo,
        snapshotMinute,
        onlineStatus,
        lastSeenAt,
        lastCheckedAt,
        deviceSn,
        userName,
        plantName,
        deviceModel,
        telegramIds,
        deviceName,
        deviceNo,
        source,
        trackingEnabled,
        acPower,
        yieldToday,
        yieldTotal,
        realtimeUpdatedAt
      )
      SELECT
        d.registrationNo,
        ?,
        d.onlineStatus,
        d.lastSeenAt,
        ?,
        COALESCE(?, d.deviceSn),
        d.userName,
        d.plantName,
        d.deviceModel,
        d.telegramIds,
        d.deviceName,
        d.deviceNo,
        ?,
        d.trackingEnabled,
        ?,
        ?,
        ?,
        ?
      FROM devices d
      WHERE d.registrationNo = ?
      ON CONFLICT(registrationNo, snapshotMinute) DO UPDATE SET
        acPower = excluded.acPower,
        yieldToday = excluded.yieldToday,
        yieldTotal = excluded.yieldTotal,
        realtimeUpdatedAt = excluded.realtimeUpdatedAt,
        lastCheckedAt = excluded.lastCheckedAt,
        deviceSn = COALESCE(excluded.deviceSn, device_status_history.deviceSn),
        source = excluded.source
    `).run(
      snapshotMinute,
      realtimeUpdatedAtSql,
      cleanDeviceSn,
      source,
      nextAcPower,
      nextYieldToday,
      nextYieldTotal,
      realtimeUpdatedAtSql,
      cleanRegistrationNo,
    );

    db.prepare(`
      INSERT INTO monthly_summary (
        registrationNo,
        month,
        totalYield,
        avgYield,
        maxYield,
        activeDays,
        updatedAt
      )
      SELECT
        registrationNo,
        ?,
        COALESCE(SUM(COALESCE(yieldToday, 0)), 0),
        COALESCE(AVG(COALESCE(yieldToday, 0)), 0),
        COALESCE(MAX(COALESCE(yieldToday, 0)), 0),
        COUNT(*),
        ?
      FROM daily_stats
      WHERE registrationNo = ?
        AND date LIKE ?
      GROUP BY registrationNo
      ON CONFLICT(registrationNo, month) DO UPDATE SET
        totalYield = excluded.totalYield,
        avgYield = excluded.avgYield,
        maxYield = excluded.maxYield,
        activeDays = excluded.activeDays,
        updatedAt = excluded.updatedAt
    `).run(month, realtimeUpdatedAtSql, cleanRegistrationNo, `${month}-%`);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    registrationNo: cleanRegistrationNo,
    deviceSn: cleanDeviceSn,
    date,
    month,
    snapshotMinute,
    acPower: nextAcPower,
    yieldToday: nextYieldToday,
    yieldTotal: nextYieldTotal,
    updatedAt: realtimeUpdatedAtSql,
  };
}

export function createDevice(payload) {
  const registrationNo = normaliseText(payload?.registrationNo, {
    label: 'registrationNo',
    required: true,
    maxLength: 100,
  });

  if (getDeviceRow(registrationNo)) {
    throw new AppError(409, 'Bu registrationNo allaqachon mavjud');
  }

  const device = {
    registrationNo,
    deviceSn: normaliseText(payload?.deviceSn, { label: 'deviceSn', maxLength: 100 }),
    userName: normaliseText(payload?.userName, { label: 'userName', maxLength: 150 }),
    plantName: normaliseText(payload?.plantName, { label: 'plantName', maxLength: 255 }),
    deviceModel: normaliseText(payload?.deviceModel, { label: 'deviceModel', maxLength: 100 }),
    telegramIds: normaliseTelegramIdsFromPayload(payload, []),
    onlineStatus: normaliseStatus(payload?.onlineStatus, 'Unknown'),
    lastSeenAt: normaliseOptionalDate(payload?.lastSeenAt, 'lastSeenAt') ?? null,
    lastCheckedAt: normaliseOptionalDate(payload?.lastCheckedAt, 'lastCheckedAt') ?? null,
    addedAt: payload?.addedAt ? toSqlDateTime(payload.addedAt) : toSqlDateTime(Date.now()),
    deviceNo: normaliseOptionalInteger(payload?.deviceNo, 'deviceNo') ?? getNextDeviceNo(),
    deviceName: normaliseText(payload?.deviceName, { label: 'deviceName', maxLength: 100 }),
    source: normaliseText(payload?.source, { label: 'source', maxLength: 50 }) ?? 'manual',
    trackingEnabled: normaliseTrackingEnabled(payload?.trackingEnabled, 1),
  };

  getDb().prepare(`
    INSERT INTO devices (
      registrationNo,
      deviceSn,
      userName,
      plantName,
      deviceModel,
      telegramIds,
      onlineStatus,
      lastSeenAt,
      lastCheckedAt,
      addedAt,
      deviceNo,
      deviceName,
      source,
      trackingEnabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    device.registrationNo,
    device.deviceSn,
    device.userName,
    device.plantName,
    device.deviceModel,
    serialiseTelegramIds(device.telegramIds),
    device.onlineStatus,
    device.lastSeenAt,
    device.lastCheckedAt,
    device.addedAt,
    device.deviceNo,
    device.deviceName,
    device.source,
    device.trackingEnabled,
  );

  return getDeviceByRegistrationNo(registrationNo);
}

export function syncDevicesSnapshot(rawDevices, { syncedAt = Date.now(), source = 'devices-json' } = {}) {
  if (!Array.isArray(rawDevices)) {
    throw new AppError(400, 'Sync uchun devices array bo\'lishi kerak');
  }

  const db = getDb();
  const syncedAtSql = toSqlDateTime(syncedAt);
  const snapshotMinute = toMinuteBucket(syncedAtSql);
  const selectStatement = db.prepare('SELECT * FROM devices WHERE registrationNo = ?');
  const insertStatement = db.prepare(`
    INSERT INTO devices (
      registrationNo,
      deviceSn,
      userName,
      plantName,
      deviceModel,
      telegramIds,
      onlineStatus,
      lastSeenAt,
      lastCheckedAt,
      addedAt,
      deviceNo,
      deviceName,
      source,
      trackingEnabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStatement = db.prepare(`
    UPDATE devices
    SET
      deviceSn = ?,
      userName = ?,
      plantName = ?,
      deviceModel = ?,
      telegramIds = ?,
      onlineStatus = ?,
      lastSeenAt = ?,
      lastCheckedAt = ?,
      deviceNo = ?,
      deviceName = ?,
      source = ?,
      trackingEnabled = ?
    WHERE registrationNo = ?
  `);
  const historyInsertStatement = db.prepare(`
    INSERT OR IGNORE INTO device_status_history (
      registrationNo,
      snapshotMinute,
      onlineStatus,
      lastSeenAt,
      lastCheckedAt,
      deviceSn,
      userName,
      plantName,
      deviceModel,
      telegramIds,
      deviceName,
      deviceNo,
      source,
      trackingEnabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const summary = {
    syncedAt: syncedAtSql,
    snapshotMinute,
    totalReceived: rawDevices.length,
    processed: 0,
    inserted: 0,
    updated: 0,
    historyInserted: 0,
    failed: 0,
    errors: [],
  };

  db.exec('BEGIN');

  try {
    for (const rawDevice of rawDevices) {
      try {
        const registrationNo = normaliseText(
          firstDefined(rawDevice?.registrationNo, rawDevice?.registration_no),
          {
            label: 'registrationNo',
            required: true,
            maxLength: 100,
          },
        );
        const existingDevice = selectStatement.get(registrationNo);
        const nextDevice = buildSyncedDevicePayload(rawDevice, existingDevice, {
          registrationNo,
          syncedAt: syncedAtSql,
          source,
        });

        if (existingDevice) {
          updateStatement.run(
            nextDevice.deviceSn,
            nextDevice.userName,
            nextDevice.plantName,
            nextDevice.deviceModel,
            serialiseTelegramIds(nextDevice.telegramIds),
            nextDevice.onlineStatus,
            nextDevice.lastSeenAt,
            nextDevice.lastCheckedAt,
            nextDevice.deviceNo,
            nextDevice.deviceName,
            nextDevice.source,
            nextDevice.trackingEnabled,
            registrationNo,
          );
          summary.updated += 1;
        } else {
          insertStatement.run(
            nextDevice.registrationNo,
            nextDevice.deviceSn,
            nextDevice.userName,
            nextDevice.plantName,
            nextDevice.deviceModel,
            serialiseTelegramIds(nextDevice.telegramIds),
            nextDevice.onlineStatus,
            nextDevice.lastSeenAt,
            nextDevice.lastCheckedAt,
            nextDevice.addedAt,
            nextDevice.deviceNo,
            nextDevice.deviceName,
            nextDevice.source,
            nextDevice.trackingEnabled,
          );
          summary.inserted += 1;
        }

        if (nextDevice.trackingEnabled) {
          const historyInsertResult = historyInsertStatement.run(
            nextDevice.registrationNo,
            snapshotMinute,
            nextDevice.onlineStatus,
            nextDevice.lastSeenAt,
            nextDevice.lastCheckedAt,
            nextDevice.deviceSn,
            nextDevice.userName,
            nextDevice.plantName,
            nextDevice.deviceModel,
            serialiseTelegramIds(nextDevice.telegramIds),
            nextDevice.deviceName,
            nextDevice.deviceNo,
            nextDevice.source,
            nextDevice.trackingEnabled,
          );
          summary.historyInserted += Number(historyInsertResult.changes || 0);
        }

        summary.processed += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({
          registrationNo: rawDevice?.registrationNo ?? rawDevice?.registration_no ?? null,
          message: error.message,
        });
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return summary;
}

export function updateDevice(registrationNo, payload) {
  const cleanRegistrationNo = normaliseText(registrationNo, {
    label: 'registrationNo',
    required: true,
    maxLength: 100,
  });

  const existing = getDeviceRow(cleanRegistrationNo);
  if (!existing) {
    throw new AppError(404, 'Device topilmadi');
  }

  if (payload && hasOwn(payload, 'registrationNo') && String(payload.registrationNo).trim() !== cleanRegistrationNo) {
    throw new AppError(400, "registrationNo path orqali boshqariladi va o'zgartirilmaydi");
  }

  const nextDevice = {
    deviceSn: hasOwn(payload, 'deviceSn')
      ? normaliseText(payload.deviceSn, { label: 'deviceSn', maxLength: 100 })
      : existing.deviceSn,
    userName: hasOwn(payload, 'userName')
      ? normaliseText(payload.userName, { label: 'userName', maxLength: 150 })
      : existing.userName,
    plantName: hasOwn(payload, 'plantName')
      ? normaliseText(payload.plantName, { label: 'plantName', maxLength: 255 })
      : existing.plantName,
    deviceModel: hasOwn(payload, 'deviceModel')
      ? normaliseText(payload.deviceModel, { label: 'deviceModel', maxLength: 100 })
      : existing.deviceModel,
    telegramIds: hasAnyOwn(payload, [...TELEGRAM_ID_PAYLOAD_KEYS, ...USER_ID_PAYLOAD_KEYS])
      ? normaliseTelegramIdsFromPayload(payload, [])
      : parseTelegramIds(existing.telegramIds),
    onlineStatus: hasOwn(payload, 'onlineStatus')
      ? normaliseStatus(payload.onlineStatus, existing.onlineStatus || 'Unknown')
      : existing.onlineStatus,
    lastSeenAt: hasOwn(payload, 'lastSeenAt')
      ? normaliseOptionalDate(payload.lastSeenAt, 'lastSeenAt')
      : existing.lastSeenAt,
    lastCheckedAt: hasOwn(payload, 'lastCheckedAt')
      ? normaliseOptionalDate(payload.lastCheckedAt, 'lastCheckedAt')
      : existing.lastCheckedAt,
    deviceNo: hasOwn(payload, 'deviceNo')
      ? normaliseOptionalInteger(payload.deviceNo, 'deviceNo')
      : existing.deviceNo,
    deviceName: hasOwn(payload, 'deviceName')
      ? normaliseText(payload.deviceName, { label: 'deviceName', maxLength: 100 })
      : existing.deviceName,
    source: hasOwn(payload, 'source')
      ? normaliseText(payload.source, { label: 'source', maxLength: 50 })
      : existing.source,
    trackingEnabled: hasOwn(payload, 'trackingEnabled')
      ? normaliseTrackingEnabled(payload.trackingEnabled, existing.trackingEnabled)
      : existing.trackingEnabled,
  };

  getDb().prepare(`
    UPDATE devices
    SET
      deviceSn = ?,
      userName = ?,
      plantName = ?,
      deviceModel = ?,
      telegramIds = ?,
      onlineStatus = ?,
      lastSeenAt = ?,
      lastCheckedAt = ?,
      deviceNo = ?,
      deviceName = ?,
      source = ?,
      trackingEnabled = ?
    WHERE registrationNo = ?
  `).run(
    nextDevice.deviceSn,
    nextDevice.userName,
    nextDevice.plantName,
    nextDevice.deviceModel,
    serialiseTelegramIds(nextDevice.telegramIds),
    nextDevice.onlineStatus,
    nextDevice.lastSeenAt,
    nextDevice.lastCheckedAt,
    nextDevice.deviceNo,
    nextDevice.deviceName,
    nextDevice.source,
    nextDevice.trackingEnabled,
    cleanRegistrationNo,
  );

  return getDeviceByRegistrationNo(cleanRegistrationNo);
}

export function deleteDevice(registrationNo) {
  const cleanRegistrationNo = normaliseText(registrationNo, {
    label: 'registrationNo',
    required: true,
    maxLength: 100,
  });

  const db = getDb();
  if (!getDeviceRow(cleanRegistrationNo)) {
    throw new AppError(404, 'Device topilmadi');
  }

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM alerts WHERE registrationNo = ?').run(cleanRegistrationNo);
    db.prepare('DELETE FROM daily_stats WHERE registrationNo = ?').run(cleanRegistrationNo);
    db.prepare('DELETE FROM monthly_summary WHERE registrationNo = ?').run(cleanRegistrationNo);
    db.prepare('DELETE FROM device_status_history WHERE registrationNo = ?').run(cleanRegistrationNo);
    db.prepare('DELETE FROM devices WHERE registrationNo = ?').run(cleanRegistrationNo);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    registrationNo: cleanRegistrationNo,
    deleted: true,
  };
}
