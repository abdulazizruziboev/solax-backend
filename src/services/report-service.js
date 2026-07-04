import { getDb } from '../db.js';
import { AppError } from '../middleware/errors.js';
import {
  addDaysToChartDate,
  normaliseChartDate,
  roundChartValue,
  toTashkentDate,
} from './device-service.js';

const GRANULARITIES = Object.freeze(['hourly', 'daily', 'weekly', 'monthly']);
const MAX_SCOPE_DEVICES = 2000;
const MAX_DAILY_SPAN_DAYS = 400;
const MAX_WEEKLY_SPAN_DAYS = 1100;
const MAX_MONTHLY_SPAN_DAYS = 1900;
const UZ_MONTH_LABELS = Object.freeze([
  'Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyn', 'Iyl', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek',
]);

function parseSqlDate(dateText) {
  return new Date(`${dateText}T00:00:00.000Z`);
}

function diffInDays(startDate, endDate) {
  const startMs = parseSqlDate(startDate).getTime();
  const endMs = parseSqlDate(endDate).getTime();
  return Math.round((endMs - startMs) / 86400000);
}

function formatDayLabel(dateText) {
  return `${dateText.slice(8, 10)}.${dateText.slice(5, 7)}`;
}

function formatMonthLabel(monthText) {
  const monthIndex = Number.parseInt(monthText.slice(5, 7), 10) - 1;
  const monthLabel = UZ_MONTH_LABELS[monthIndex] ?? monthText.slice(5, 7);
  return `${monthLabel} ${monthText.slice(0, 4)}`;
}

function nextMonthFirstDay(monthText) {
  const year = Number.parseInt(monthText.slice(0, 4), 10);
  const month = Number.parseInt(monthText.slice(5, 7), 10);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

function getWeekStart(dateText) {
  const date = parseSqlDate(dateText);
  // Dushanba haftaning birinchi kuni
  const weekday = (date.getUTCDay() + 6) % 7;
  return addDaysToChartDate(dateText, -weekday);
}

function normaliseScope(registrationNos) {
  if (registrationNos === null || registrationNos === undefined) {
    return null;
  }

  if (!Array.isArray(registrationNos)) {
    throw new AppError(400, "registrationNos array bo'lishi kerak");
  }

  const cleanList = [
    ...new Set(registrationNos.map((item) => String(item || '').trim()).filter(Boolean)),
  ];

  if (cleanList.length > MAX_SCOPE_DEVICES) {
    throw new AppError(400, `Bir hisobotda ko'pi bilan ${MAX_SCOPE_DEVICES} ta qurilma bo'lishi mumkin`);
  }

  return cleanList;
}

function buildScopeFilter(scope, column = 'registrationNo') {
  if (scope === null) {
    return { clause: '', params: [] };
  }

  const placeholders = scope.map(() => '?').join(', ');
  return { clause: ` AND ${column} IN (${placeholders})`, params: scope };
}

function resolveGranularity(granularity, spanDays) {
  if (granularity === null || granularity === undefined || granularity === '') {
    if (spanDays <= 1) return 'hourly';
    if (spanDays <= 45) return 'daily';
    if (spanDays <= 240) return 'weekly';
    return 'monthly';
  }

  const cleanGranularity = String(granularity).trim().toLowerCase();
  if (!GRANULARITIES.includes(cleanGranularity)) {
    throw new AppError(400, `granularity ${GRANULARITIES.join('|')} dan biri bo'lishi kerak`);
  }

  if (cleanGranularity === 'hourly' && spanDays > 1) {
    throw new AppError(400, "Soatlik hisobot faqat bitta kun uchun olinadi (startDate = endDate)");
  }

  if (cleanGranularity === 'daily' && spanDays > MAX_DAILY_SPAN_DAYS) {
    throw new AppError(400, `Kunlik hisobot oralig'i ko'pi bilan ${MAX_DAILY_SPAN_DAYS} kun`);
  }

  if (cleanGranularity === 'weekly' && spanDays > MAX_WEEKLY_SPAN_DAYS) {
    throw new AppError(400, `Haftalik hisobot oralig'i ko'pi bilan ${MAX_WEEKLY_SPAN_DAYS} kun`);
  }

  return cleanGranularity;
}

function getDailyTotalsRows(db, startDate, endDate, scope) {
  const filter = buildScopeFilter(scope);

  return db
    .prepare(`
      SELECT date, COALESCE(SUM(COALESCE(yieldToday, 0)), 0) AS value
      FROM daily_stats
      WHERE date BETWEEN ? AND ?${filter.clause}
      GROUP BY date
      ORDER BY date ASC
    `)
    .all(startDate, endDate, ...filter.params);
}

function buildDailySeries(db, startDate, endDate, spanDays, scope) {
  const valuesByDate = new Map(
    getDailyTotalsRows(db, startDate, endDate, scope).map((row) => [row.date, roundChartValue(row.value)]),
  );

  return Array.from({ length: spanDays }, (_item, index) => {
    const date = addDaysToChartDate(startDate, index);
    return {
      key: date,
      label: formatDayLabel(date),
      startDate: date,
      endDate: date,
      value: valuesByDate.get(date) ?? 0,
    };
  });
}

function buildWeeklySeries(db, startDate, endDate, scope) {
  const rows = getDailyTotalsRows(db, startDate, endDate, scope);
  const totalsByWeek = new Map();

  for (const row of rows) {
    const weekStart = getWeekStart(row.date);
    totalsByWeek.set(weekStart, (totalsByWeek.get(weekStart) ?? 0) + Number(row.value || 0));
  }

  const series = [];
  let cursor = getWeekStart(startDate);

  while (cursor <= endDate) {
    const weekEnd = addDaysToChartDate(cursor, 6);
    const clampedStart = cursor < startDate ? startDate : cursor;
    const clampedEnd = weekEnd > endDate ? endDate : weekEnd;

    series.push({
      key: cursor,
      label: `${formatDayLabel(clampedStart)}–${formatDayLabel(clampedEnd)}`,
      startDate: clampedStart,
      endDate: clampedEnd,
      value: roundChartValue(totalsByWeek.get(cursor) ?? 0),
    });

    cursor = addDaysToChartDate(cursor, 7);
  }

  return series;
}

function buildMonthlySeries(db, startDate, endDate, scope) {
  const filter = buildScopeFilter(scope);
  const rows = db
    .prepare(`
      SELECT SUBSTR(date, 1, 7) AS month, COALESCE(SUM(COALESCE(yieldToday, 0)), 0) AS value
      FROM daily_stats
      WHERE date BETWEEN ? AND ?${filter.clause}
      GROUP BY SUBSTR(date, 1, 7)
      ORDER BY month ASC
    `)
    .all(startDate, endDate, ...filter.params);

  const valuesByMonth = new Map(rows.map((row) => [row.month, roundChartValue(row.value)]));
  const series = [];
  let month = startDate.slice(0, 7);

  while (month <= endDate.slice(0, 7)) {
    const monthFirstDay = `${month}-01`;
    const nextFirstDay = nextMonthFirstDay(month);
    const monthLastDay = addDaysToChartDate(nextFirstDay, -1);

    series.push({
      key: month,
      label: formatMonthLabel(month),
      startDate: monthFirstDay < startDate ? startDate : monthFirstDay,
      endDate: monthLastDay > endDate ? endDate : monthLastDay,
      value: valuesByMonth.get(month) ?? 0,
    });

    month = nextFirstDay.slice(0, 7);
  }

  return series;
}

function getYieldHistoryRowsForScope(db, date, scope) {
  const filter = buildScopeFilter(scope);

  return db
    .prepare(`
      SELECT registrationNo, snapshotMinute, yieldToday
      FROM device_status_history
      WHERE DATE(snapshotMinute) = ?
        AND yieldToday IS NOT NULL${filter.clause}
      ORDER BY registrationNo ASC, snapshotMinute ASC
    `)
    .all(date, ...filter.params);
}

function buildHourlySeries(db, date, scope) {
  const rows = getYieldHistoryRowsForScope(db, date, scope);
  const rowsByDevice = new Map();

  for (const row of rows) {
    const minuteMatch = String(row.snapshotMinute || '').match(/\b(\d{2}):(\d{2})/);
    const value = Number.parseFloat(row.yieldToday);

    if (!minuteMatch || !Number.isFinite(value)) {
      continue;
    }

    const minute = Number.parseInt(minuteMatch[1], 10) * 60 + Number.parseInt(minuteMatch[2], 10);
    if (!rowsByDevice.has(row.registrationNo)) {
      rowsByDevice.set(row.registrationNo, []);
    }
    rowsByDevice.get(row.registrationNo).push({ minute, value });
  }

  for (const deviceRows of rowsByDevice.values()) {
    deviceRows.sort((left, right) => left.minute - right.minute);
  }

  const cumulativeAt = (minute) => {
    let total = 0;
    for (const deviceRows of rowsByDevice.values()) {
      let latest = 0;
      for (const row of deviceRows) {
        if (row.minute > minute) break;
        latest = row.value;
      }
      total += latest;
    }
    return total;
  };

  let previousCumulative = cumulativeAt(0);

  return Array.from({ length: 24 }, (_item, hour) => {
    const cumulative = cumulativeAt((hour + 1) * 60 - 1);
    const value = roundChartValue(Math.max(0, cumulative - previousCumulative));
    previousCumulative = cumulative;

    return {
      key: `${String(hour).padStart(2, '0')}:00`,
      label: `${String(hour).padStart(2, '0')}:00`,
      startDate: date,
      endDate: date,
      value,
    };
  });
}

function buildDeviceBreakdown(db, startDate, endDate, scope) {
  const filter = buildScopeFilter(scope, 'd.registrationNo');
  const devices = db
    .prepare(`
      SELECT
        d.registrationNo,
        d.deviceSn,
        d.deviceName,
        d.userName,
        d.plantName,
        d.deviceModel,
        d.onlineStatus,
        COALESCE(stats.total, 0) AS total,
        COALESCE(stats.activeDays, 0) AS activeDays,
        COALESCE(stats.bestDayYield, 0) AS bestDayYield,
        stats.bestDate
      FROM devices d
      LEFT JOIN (
        SELECT
          registrationNo,
          SUM(COALESCE(yieldToday, 0)) AS total,
          SUM(CASE WHEN COALESCE(yieldToday, 0) > 0 THEN 1 ELSE 0 END) AS activeDays,
          MAX(COALESCE(yieldToday, 0)) AS bestDayYield,
          (
            SELECT ds2.date
            FROM daily_stats ds2
            WHERE ds2.registrationNo = daily_stats.registrationNo
              AND ds2.date BETWEEN ? AND ?
            ORDER BY COALESCE(ds2.yieldToday, 0) DESC, ds2.date ASC
            LIMIT 1
          ) AS bestDate
        FROM daily_stats
        WHERE date BETWEEN ? AND ?
        GROUP BY registrationNo
      ) stats ON stats.registrationNo = d.registrationNo
      WHERE 1 = 1${filter.clause}
      ORDER BY COALESCE(stats.total, 0) DESC, d.registrationNo ASC
    `)
    .all(startDate, endDate, startDate, endDate, ...filter.params);

  const grandTotal = devices.reduce((sum, device) => sum + Number(device.total || 0), 0);

  return devices.map((device) => ({
    registrationNo: device.registrationNo,
    deviceSn: device.deviceSn,
    deviceName: device.deviceName,
    userName: device.userName,
    plantName: device.plantName,
    deviceModel: device.deviceModel,
    onlineStatus: device.onlineStatus,
    total: roundChartValue(device.total),
    activeDays: Number(device.activeDays || 0),
    bestDayYield: roundChartValue(device.bestDayYield),
    bestDate: device.bestDate ?? null,
    sharePercent: grandTotal > 0 ? Math.round((Number(device.total || 0) / grandTotal) * 1000) / 10 : 0,
  }));
}

function buildSummary(series, deviceBreakdown, granularity) {
  const total = roundChartValue(series.reduce((sum, point) => sum + Number(point.value || 0), 0));
  const activePoints = series.filter((point) => Number(point.value || 0) > 0);
  const bestPoint = series.reduce(
    (best, point) => (Number(point.value || 0) > Number(best?.value || 0) ? point : best),
    null,
  );

  return {
    total,
    unit: 'kWh',
    points: series.length,
    activePoints: activePoints.length,
    averagePerActivePoint:
      activePoints.length > 0 ? roundChartValue(total / activePoints.length) : 0,
    best: bestPoint && Number(bestPoint.value || 0) > 0
      ? { key: bestPoint.key, label: bestPoint.label, value: bestPoint.value }
      : null,
    deviceCount: deviceBreakdown.length,
    activeDeviceCount: deviceBreakdown.filter((device) => device.total > 0).length,
    granularity,
  };
}

export function getEnergyReport({
  startDate = null,
  endDate = null,
  granularity = null,
  registrationNos = null,
} = {}) {
  const db = getDb();
  const scope = normaliseScope(registrationNos);
  const cleanEndDate = normaliseChartDate(endDate);
  const cleanStartDate = startDate === null || startDate === undefined || startDate === ''
    ? addDaysToChartDate(cleanEndDate, -6)
    : normaliseChartDate(startDate);

  if (cleanStartDate > cleanEndDate) {
    throw new AppError(400, "startDate endDate dan katta bo'lishi mumkin emas");
  }

  const today = toTashkentDate();
  if (cleanStartDate > today) {
    throw new AppError(400, "startDate kelajakda bo'lishi mumkin emas");
  }

  const spanDays = diffInDays(cleanStartDate, cleanEndDate) + 1;

  if (spanDays > MAX_MONTHLY_SPAN_DAYS) {
    throw new AppError(400, `Hisobot oralig'i ko'pi bilan ${MAX_MONTHLY_SPAN_DAYS} kun bo'lishi mumkin`);
  }

  const cleanGranularity = resolveGranularity(granularity, spanDays);

  // Bo'sh scope — foydalanuvchining hech qanday qurilmasi yo'q
  if (scope !== null && scope.length === 0) {
    return {
      startDate: cleanStartDate,
      endDate: cleanEndDate,
      granularity: cleanGranularity,
      scope: 'user',
      unit: 'kWh',
      timeZone: 'Asia/Tashkent',
      summary: buildSummary([], [], cleanGranularity),
      series: [],
      devices: [],
    };
  }

  let series;
  if (cleanGranularity === 'hourly') {
    series = buildHourlySeries(db, cleanStartDate, scope);
  } else if (cleanGranularity === 'daily') {
    series = buildDailySeries(db, cleanStartDate, cleanEndDate, spanDays, scope);
  } else if (cleanGranularity === 'weekly') {
    series = buildWeeklySeries(db, cleanStartDate, cleanEndDate, scope);
  } else {
    series = buildMonthlySeries(db, cleanStartDate, cleanEndDate, scope);
  }

  const deviceBreakdown = buildDeviceBreakdown(db, cleanStartDate, cleanEndDate, scope);

  return {
    startDate: cleanStartDate,
    endDate: cleanEndDate,
    granularity: cleanGranularity,
    scope: scope === null ? 'all-devices' : 'user',
    unit: 'kWh',
    timeZone: 'Asia/Tashkent',
    summary: buildSummary(series, deviceBreakdown, cleanGranularity),
    series,
    devices: deviceBreakdown,
  };
}
