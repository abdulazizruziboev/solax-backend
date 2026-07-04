import { getDb } from '../db.js';
import { AppError } from '../middleware/errors.js';
import { normaliseChartDate, toTashkentDate, addDaysToChartDate } from './device-service.js';

// O'zbekiston uchun taxminiy quyoshli soatlar (oylik o'rtacha)
const UZBEKISTAN_PEAK_SUN_HOURS = Object.freeze({
  1: 2.8, 2: 3.5, 3: 4.5, 4: 5.5, 5: 6.5, 6: 7.2,
  7: 7.5, 8: 6.8, 9: 5.8, 10: 4.5, 11: 3.2, 12: 2.5,
});

// Har bir oy uchun taxminiy radiatsiya (kWh/m²/day)
const MONTHLY_IRRADIANCE = Object.freeze({
  1: 2.2, 2: 2.8, 3: 3.8, 4: 4.8, 5: 5.8, 6: 6.5,
  7: 6.8, 8: 6.0, 9: 5.0, 10: 3.8, 11: 2.6, 12: 2.0,
});

// Samaradorlik chegaralari
const EFFICIENCY_THRESHOLDS = Object.freeze({
  excellent: 85,
  good: 70,
  average: 50,
  poor: 30,
  critical: 0,
});

function getPeakSunHours(dateText) {
  const month = Number.parseInt(dateText.slice(5, 7), 10);
  return UZBEKISTAN_PEAK_SUN_HOURS[month] ?? 5.0;
}

function getMonthlyIrradiance(dateText) {
  const month = Number.parseInt(dateText.slice(5, 7), 10);
  return MONTHLY_IRRADIANCE[month] ?? 4.0;
}

function calculateEfficiencyScore(actualYield, ratedPower, peakSunHours) {
  if (!ratedPower || ratedPower <= 0 || !peakSunHours || peakSunHours <= 0) {
    return null;
  }
  const expectedYield = ratedPower * peakSunHours;
  const efficiency = (actualYield / expectedYield) * 100;
  return Math.round(efficiency * 10) / 10;
}

function getEfficiencyGrade(score) {
  if (score === null || score === undefined) return 'unknown';
  if (score >= EFFICIENCY_THRESHOLDS.excellent) return 'excellent';
  if (score >= EFFICIENCY_THRESHOLDS.good) return 'good';
  if (score >= EFFICIENCY_THRESHOLDS.average) return 'average';
  if (score >= EFFICIENCY_THRESHOLDS.poor) return 'poor';
  return 'critical';
}

function getEfficiencyColor(grade) {
  const colors = {
    excellent: '#10b981',
    good: '#3b82f6',
    average: '#f59e0b',
    poor: '#f97316',
    critical: '#ef4444',
    unknown: '#9ca3af',
  };
  return colors[grade] || colors.unknown;
}

function detectAnomalies(devices) {
  if (devices.length < 3) return [];

  const validScores = devices
    .filter((d) => d.efficiencyScore !== null && d.efficiencyScore !== undefined)
    .map((d) => d.efficiencyScore);

  if (validScores.length < 3) return [];

  const mean = validScores.reduce((sum, s) => sum + s, 0) / validScores.length;
  const variance = validScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / validScores.length;
  const stdDev = Math.sqrt(variance);

  const anomalies = [];
  const anomalyThreshold = 2;

  for (const device of devices) {
    if (device.efficiencyScore === null || device.efficiencyScore === undefined) continue;

    const zScore = stdDev > 0 ? (device.efficiencyScore - mean) / stdDev : 0;

    if (zScore < -anomalyThreshold) {
      anomalies.push({
        registrationNo: device.registrationNo,
        deviceName: device.deviceName,
        plantName: device.plantName,
        efficiencyScore: device.efficiencyScore,
        expectedRange: {
          min: Math.round((mean - 2 * stdDev) * 10) / 10,
          max: Math.round((mean + 2 * stdDev) * 10) / 10,
        },
        deviation: Math.round(zScore * 10) / 10,
        reason: 'Me\'yordan past — texnik muammo yoki soya tushishi mumkin',
      });
    }
  }

  return anomalies;
}

export function getDeviceEfficiency({
  startDate = null,
  endDate = null,
  registrationNos = null,
} = {}) {
  const db = getDb();
  const cleanEndDate = normaliseChartDate(endDate);
  const cleanStartDate = startDate === null || startDate === undefined || startDate === ''
    ? addDaysToChartDate(cleanEndDate, -29)
    : normaliseChartDate(startDate);

  if (cleanStartDate > cleanEndDate) {
    throw new AppError(400, "startDate endDate dan katta bo'lishi mumkin emas");
  }

  const today = toTashkentDate();
  if (cleanStartDate > today) {
    throw new AppError(400, "Kelajakdagi sana uchun hisobot olinmaydi");
  }

  // Scope filter
  let scopeFilter = '';
  let scopeParams = [];
  if (registrationNos && registrationNos.length > 0) {
    const placeholders = registrationNos.map(() => '?').join(', ');
    scopeFilter = ` AND d.registrationNo IN (${placeholders})`;
    scopeParams = registrationNos;
  }

  // Qurilmalar ro'yxati
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
        d.ratedPower,
        d.latitude,
        d.longitude,
        d.address
      FROM devices d
      WHERE 1=1${scopeFilter}
      ORDER BY d.registrationNo ASC
    `)
    .all(...scopeParams);

  // Kunlik statistika
  const dailyStats = db
    .prepare(`
      SELECT
        registrationNo,
        SUM(COALESCE(yieldToday, 0)) AS totalYield,
        COUNT(CASE WHEN COALESCE(yieldToday, 0) > 0 THEN 1 END) AS activeDays,
        MAX(COALESCE(yieldToday, 0)) AS bestDayYield,
        AVG(COALESCE(yieldToday, 0)) AS avgDailyYield
      FROM daily_stats
      WHERE date BETWEEN ? AND ?${scopeFilter.replace(/d\./g, '')}
      GROUP BY registrationNo
    `)
    .all(cleanStartDate, cleanEndDate, ...scopeParams);

  const statsByDevice = new Map(dailyStats.map((s) => [s.registrationNo, s]));

  // O'rtacha kunlar soni (efficiency hisoblash uchun)
  const spanDays = Math.round((new Date(cleanEndDate).getTime() - new Date(cleanStartDate).getTime()) / 86400000) + 1;

  // Har bir qurilma uchun samaradorlik
  const deviceResults = devices.map((device) => {
    const stats = statsByDevice.get(device.registrationNo);
    const totalYield = stats?.totalYield ?? 0;
    const activeDays = stats?.activeDays ?? 0;
    const bestDayYield = stats?.bestDayYield ?? 0;
    const avgDailyYield = stats?.avgDailyYield ?? 0;

    // O'rtacha quyoshli soat (sana oralig'iga qarab)
    const startMonth = Number.parseInt(cleanStartDate.slice(5, 7), 10);
    const endMonth = Number.parseInt(cleanEndDate.slice(5, 7), 10);
    let avgPeakSunHours = 0;
    if (startMonth === endMonth) {
      avgPeakSunHours = getPeakSunHours(cleanStartDate);
    } else {
      const months = new Set();
      for (let d = new Date(cleanStartDate); d <= new Date(cleanEndDate); d.setDate(d.getDate() + 1)) {
        months.add(d.getMonth() + 1);
      }
      avgPeakSunHours = [...months].reduce((sum, m) => sum + (UZBEKISTAN_PEAK_SUN_HOURS[m] ?? 5), 0) / months.size;
    }

    // Samaradorlik
    const efficiencyScore = calculateEfficiencyScore(
      totalYield,
      device.ratedPower,
      avgPeakSunHours * spanDays,
    );

    const grade = getEfficiencyGrade(efficiencyScore);

    // Kunlik o'rtacha vs kutilgan
    const expectedDailyYield = device.ratedPower ? device.ratedPower * avgPeakSunHours : null;
    const yieldRatio = expectedDailyYield ? Math.round((avgDailyYield / expectedDailyYield) * 100) / 10 : null;

    return {
      registrationNo: device.registrationNo,
      deviceSn: device.deviceSn,
      deviceName: device.deviceName,
      userName: device.userName,
      plantName: device.plantName,
      deviceModel: device.deviceModel,
      onlineStatus: device.onlineStatus,
      ratedPower: device.ratedPower,
      latitude: device.latitude,
      longitude: device.longitude,
      address: device.address,
      stats: {
        totalYield: Math.round(totalYield * 100) / 100,
        activeDays,
        spanDays,
        bestDayYield: Math.round(bestDayYield * 100) / 100,
        avgDailyYield: Math.round(avgDailyYield * 100) / 100,
        yieldRatio,
      },
      efficiency: {
        score: efficiencyScore,
        grade,
        color: getEfficiencyColor(grade),
        avgPeakSunHours: Math.round(avgPeakSunHours * 10) / 10,
        expectedTotalYield: device.ratedPower
          ? Math.round(device.ratedPower * avgPeakSunHours * spanDays * 100) / 100
          : null,
      },
    };
  });

  // Reyting (efficiency bo'yicha)
  const ranked = [...deviceResults]
    .filter((d) => d.efficiency.score !== null)
    .sort((a, b) => b.efficiency.score - a.efficiency.score);

  ranked.forEach((device, index) => {
    device.rank = index + 1;
  });

  // Anomaliyalar
  const anomalies = detectAnomalies(deviceResults);

  // Umumiy statistika
  const allScores = deviceResults
    .filter((d) => d.efficiency.score !== null)
    .map((d) => d.efficiency.score);

  const systemEfficiency = allScores.length > 0
    ? Math.round((allScores.reduce((s, v) => s + v, 0) / allScores.length) * 10) / 10
    : null;

  const totalSystemYield = deviceResults.reduce((sum, d) => sum + d.stats.totalYield, 0);
  const totalRatedPower = deviceResults.reduce((sum, d) => sum + (d.ratedPower || 0), 0);

  return {
    startDate: cleanStartDate,
    endDate: cleanEndDate,
    spanDays,
    timeZone: 'Asia/Tashkent',
    summary: {
      deviceCount: deviceResults.length,
      devicesWithScore: allScores.length,
      systemEfficiency,
      totalYield: Math.round(totalSystemYield * 100) / 100,
      totalRatedPower: Math.round(totalRatedPower * 100) / 100,
      anomalyCount: anomalies.length,
    },
    devices: deviceResults,
    anomalies,
  };
}

export function getSystemEfficiencyTrend({
  days = 30,
  registrationNo = null,
} = {}) {
  const db = getDb();
  const cleanDays = Math.min(365, Math.max(1, days));
  const today = toTashkentDate();
  const startDate = addDaysToChartDate(today, -(cleanDays - 1));

  let scopeFilter = '';
  let scopeParams = [];
  if (registrationNo) {
    scopeFilter = ' AND d.registrationNo = ?';
    scopeParams = [registrationNo];
  }

  const dailyData = db
    .prepare(`
      SELECT
        ds.date,
        ds.registrationNo,
        ds.yieldToday,
        d.ratedPower
      FROM daily_stats ds
      JOIN devices d ON d.registrationNo = ds.registrationNo
      WHERE ds.date BETWEEN ? AND ?
        AND d.ratedPower IS NOT NULL
        AND d.ratedPower > 0
        ${scopeFilter}
      ORDER BY ds.date ASC, ds.registrationNo ASC
    `)
    .all(startDate, today, ...scopeParams);

  // Kunlik samaradorlik trendi
  const byDate = new Map();
  for (const row of dailyData) {
    if (!byDate.has(row.date)) {
      byDate.set(row.date, { totalYield: 0, totalRatedPower: 0, deviceCount: 0 });
    }
    const bucket = byDate.get(row.date);
    bucket.totalYield += row.yieldToday || 0;
    bucket.totalRatedPower += row.ratedPower;
    bucket.deviceCount += 1;
  }

  const trend = [];
  for (let i = 0; i < cleanDays; i++) {
    const date = addDaysToChartDate(startDate, i);
    const bucket = byDate.get(date);
    const month = Number.parseInt(date.slice(5, 7), 10);
    const peakSunHours = UZBEKISTAN_PEAK_SUN_HOURS[month] ?? 5;

    let efficiency = null;
    if (bucket && bucket.totalRatedPower > 0) {
      const expected = bucket.totalRatedPower * peakSunHours;
      efficiency = Math.round((bucket.totalYield / expected) * 1000) / 10;
    }

    trend.push({
      date,
      efficiency,
      yield: bucket ? Math.round(bucket.totalYield * 100) / 100 : 0,
      deviceCount: bucket?.deviceCount ?? 0,
    });
  }

  return {
    startDate,
    endDate: today,
    days: cleanDays,
    trend,
  };
}
