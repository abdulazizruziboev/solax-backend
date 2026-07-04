import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errors.js';
import { addDaysToChartDate, normaliseChartDate, toTashkentDate } from './device-service.js';
import { getEnergyReport } from './report-service.js';

let schedulerStarted = false;
let schedulerTimer = null;

const schedulerState = {
  enabled: config.reportEodEnabled,
  time: config.reportEodTime,
  startedAt: null,
  nextRunAt: null,
  lastRunAt: null,
  lastReportDate: null,
  lastError: null,
};

function msUntilNextRun() {
  const [hours, minutes] = schedulerState.time.split(':').map((part) => Number.parseInt(part, 10));
  // config.js process.env.TZ ni Asia/Tashkent qilib qo'ygan, shuning uchun local vaqt Toshkent vaqti
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

export function generateDailyReport(date = null, { trigger = 'manual' } = {}) {
  const cleanDate = normaliseChartDate(date);
  const today = toTashkentDate();

  if (cleanDate > today) {
    throw new AppError(400, "Kelajakdagi sana uchun hisobot yaratib bo'lmaydi");
  }

  const report = getEnergyReport({
    startDate: cleanDate,
    endDate: cleanDate,
    granularity: 'daily',
    registrationNos: null,
  });

  const bestDevice = report.devices.find((device) => device.total > 0) ?? null;
  const perDevice = report.devices.map((device) => ({
    registrationNo: device.registrationNo,
    deviceName: device.deviceName,
    userName: device.userName,
    plantName: device.plantName,
    total: device.total,
    sharePercent: device.sharePercent,
    onlineStatus: device.onlineStatus,
  }));

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  getDb()
    .prepare(`
      INSERT INTO daily_reports (
        date,
        generatedAt,
        generatedBy,
        totalYield,
        totalDevices,
        activeDevices,
        bestRegistrationNo,
        bestYield,
        perDevice
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        generatedAt = excluded.generatedAt,
        generatedBy = excluded.generatedBy,
        totalYield = excluded.totalYield,
        totalDevices = excluded.totalDevices,
        activeDevices = excluded.activeDevices,
        bestRegistrationNo = excluded.bestRegistrationNo,
        bestYield = excluded.bestYield,
        perDevice = excluded.perDevice
    `)
    .run(
      cleanDate,
      generatedAt,
      String(trigger || 'manual'),
      report.summary.total,
      report.summary.deviceCount,
      report.summary.activeDeviceCount,
      bestDevice?.registrationNo ?? null,
      bestDevice?.total ?? null,
      JSON.stringify(perDevice),
    );

  schedulerState.lastRunAt = generatedAt;
  schedulerState.lastReportDate = cleanDate;
  schedulerState.lastError = null;

  return getDailyReport(cleanDate);
}

export function getDailyReport(date, { generateIfMissing = false } = {}) {
  const cleanDate = normaliseChartDate(date);
  const row = getDb().prepare('SELECT * FROM daily_reports WHERE date = ?').get(cleanDate);

  if (!row) {
    if (generateIfMissing && cleanDate <= toTashkentDate()) {
      return generateDailyReport(cleanDate, { trigger: 'on-demand' });
    }

    return null;
  }

  return {
    date: row.date,
    generatedAt: row.generatedAt,
    generatedBy: row.generatedBy,
    totalYield: row.totalYield,
    totalDevices: row.totalDevices,
    activeDevices: row.activeDevices,
    bestRegistrationNo: row.bestRegistrationNo,
    bestYield: row.bestYield,
    perDevice: JSON.parse(row.perDevice || '[]'),
  };
}

export function listDailyReports({ limit = 30 } = {}) {
  const cleanLimit = Math.min(366, Math.max(1, Number.parseInt(limit, 10) || 30));

  return getDb()
    .prepare(`
      SELECT date, generatedAt, generatedBy, totalYield, totalDevices, activeDevices, bestRegistrationNo, bestYield
      FROM daily_reports
      ORDER BY date DESC
      LIMIT ?
    `)
    .all(cleanLimit);
}

function formatDailyReportMessage(report) {
  if (!report) return null;

  const lines = [
    `📊 *Kun oxiri hisoboti — ${report.date}*`,
    '',
    `⚡ Umumiy ishlab chiqarish: *${report.totalYield.toFixed(1)} kWh*`,
    `🔌 Faol qurilmalar: *${report.activeDevices} / ${report.totalDevices}*`,
  ];

  if (report.bestRegistrationNo) {
    lines.push(`🏆 Eng yaxshi qurilma: *${report.bestRegistrationNo}* (${report.bestYield.toFixed(1)} kWh)`);
  }

  if (report.perDevice && report.perDevice.length > 0) {
    lines.push('', '*Qurilmalar bo\'yicha:*');
    const sorted = [...report.perDevice].sort((a, b) => (b.total || 0) - (a.total || 0));
    for (const device of sorted.slice(0, 10)) {
      const name = device.deviceName || device.registrationNo;
      const status = device.onlineStatus === 'Online' ? '🟢' : '🔴';
      lines.push(`${status} ${name}: ${Number(device.total || 0).toFixed(1)} kWh (${device.sharePercent || 0}%)`);
    }
    if (sorted.length > 10) {
      lines.push(`... va yana ${sorted.length - 10} ta qurilma`);
    }
  }

  return lines.join('\n');
}

async function notifyDailyReportViaTelegram(report) {
  if (!config.telegramBotEnabled || !config.telegramBotToken) {
    return;
  }

  const message = formatDailyReportMessage(report);
  if (!message) return;

  try {
    const { sendTelegramMessageToMany } = await import('./telegram-bot-service.js');

    // Adminlarga xabar yuborish
    const admins = getDb()
      .prepare(`
        SELECT telegramId FROM app_users
        WHERE role IN ('admin', 'super_admin')
          AND telegramId IS NOT NULL
          AND telegramId != ''
      `)
      .all();

    const chatIds = admins.map((admin) => admin.telegramId).filter(Boolean);

    if (chatIds.length > 0) {
      await sendTelegramMessageToMany(chatIds, message);
      console.log(`[daily-report] Telegram xabar ${chatIds.length} ta admin'ga yuborildi`);
    }
  } catch (error) {
    console.error('[daily-report] Telegram xabar yuborish xatosi:', error.message);
  }
}

function runScheduledReport() {
  const today = toTashkentDate();

  try {
    const report = generateDailyReport(today, { trigger: 'schedule' });
    console.log(`[daily-report] ${today} uchun kun oxiri hisoboti yaratildi`);
    notifyDailyReportViaTelegram(report).catch((err) => {
      console.error('[daily-report] Telegram xabar yuborish xatosi:', err.message);
    });
  } catch (error) {
    schedulerState.lastError = error.message;
    console.error('[daily-report] EOD hisobot xatosi:', error);
  }
}

function scheduleNextRun() {
  if (!schedulerStarted || !schedulerState.enabled) {
    schedulerState.nextRunAt = null;
    return;
  }

  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
  }

  const delayMs = msUntilNextRun();
  schedulerState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  schedulerTimer = setTimeout(() => {
    runScheduledReport();
    scheduleNextRun();
  }, delayMs);

  schedulerTimer.unref?.();
}

function catchUpMissedReports() {
  const yesterday = addDaysToChartDate(toTashkentDate(), -1);
  const existing = getDb().prepare('SELECT date FROM daily_reports WHERE date = ?').get(yesterday);

  if (existing) {
    return;
  }

  const hasData = getDb()
    .prepare('SELECT 1 FROM daily_stats WHERE date = ? LIMIT 1')
    .get(yesterday);

  if (!hasData) {
    return;
  }

  try {
    generateDailyReport(yesterday, { trigger: 'catch-up' });
    console.log(`[daily-report] O'tkazib yuborilgan ${yesterday} hisoboti tiklandi`);
  } catch (error) {
    console.error('[daily-report] Catch-up xatosi:', error);
  }
}

export function getDailyReportSchedulerState() {
  return { ...schedulerState };
}

export function startDailyReportScheduler() {
  if (schedulerStarted) {
    return getDailyReportSchedulerState();
  }

  schedulerStarted = true;
  schedulerState.enabled = config.reportEodEnabled;
  schedulerState.startedAt = new Date().toISOString();

  if (!schedulerState.enabled) {
    console.warn('[daily-report] EOD hisobot scheduler o\'chiq (REPORT_EOD_ENABLED=false)');
    return getDailyReportSchedulerState();
  }

  catchUpMissedReports();
  scheduleNextRun();
  return getDailyReportSchedulerState();
}

export function stopDailyReportScheduler() {
  schedulerStarted = false;

  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  schedulerState.nextRunAt = null;
}
