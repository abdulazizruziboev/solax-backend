import { getDb } from '../db.js';
import { config } from '../config.js';

/**
 * Ma'lumot bo'shlig'ini (gap) aniqlash.
 *
 * Muhim jihat: SolaX realtime API (`getRealtimeInfo`) faqat AYNI DAMDAGI
 * holatni beradi, tarixiy egri chiziqni bermaydi. Shu sababli bo'shliqdagi
 * daqiqama-daqiqa quvvat egri chizig'ini qayta tiklab bo'lmaydi.
 *
 * Ammo `yieldToday`/`yieldTotal` — YIG'INDI (cumulative) hisoblagichlar.
 * Ular keyingi muvaffaqiyatli o'qishda bo'shliq davomida ishlab chiqarilgan
 * energiyani ham o'z ichiga oladi. Shu bois KUNLIK/UMUMIY energiya raqamlari
 * bo'shliqdan zarar ko'rmaydi — `daily_stats` upsert'i MAX bilan yig'indini
 * to'g'ri saqlaydi (o'z-o'zini "davolash").
 *
 * Ushbu xizmat esa bo'shliqning O'ZINI aniqlab, qayd etib boradi — shunda
 * qamrov (coverage) qachon uzilgani ko'rinib turadi.
 */

/**
 * Bitta qurilma uchun oxirgi muvaffaqiyatli yig'ilishdan buyon o'tgan vaqt
 * belgilangan chegaradan katta bo'lsa — bo'shliqni qayd etadi.
 *
 * @param {object} saveResult saveDeviceRealtimeStats natijasi
 * @param {number} intervalMs joriy sync intervali
 * @returns {{registrationNo: string, missedMinutes: number}|null}
 */
export function recordGapIfAny(saveResult, intervalMs) {
  try {
    if (!config.syncGapDetectionEnabled) {
      return null;
    }

    const prev = saveResult?.previousCollectedAt;
    const curr = saveResult?.lastCheckedAt;
    if (!prev || !curr) {
      return null; // birinchi yig'ilish — solishtirishga narsa yo'q
    }

    const db = getDb();

    // Ikkala vaqt ham bir xil formatda (toSqlDateTime), shuning uchun
    // julianday farqi vaqt mintaqasidan qat'i nazar aniq bo'ladi.
    const diff = db
      .prepare('SELECT (julianday(?) - julianday(?)) * 86400000.0 AS ms')
      .get(curr, prev);
    const elapsedMs = Number(diff?.ms);
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return null;
    }

    const threshold = Math.max(config.syncGapMinMs, 2 * Number(intervalMs || 0));
    if (elapsedMs < threshold) {
      return null;
    }

    const missedMinutes = Math.round(elapsedMs / 60000);

    db.prepare(
      'INSERT INTO sync_gaps (registrationNo, gapStart, gapEnd, missedMinutes) VALUES (?, ?, ?, ?)',
    ).run(saveResult.registrationNo, prev, curr, missedMinutes);

    console.warn(
      `[gap] ${saveResult.registrationNo}: ${missedMinutes} daqiqa ma'lumot bo'shlig'i (${prev} -> ${curr}). ` +
        `Energiya yig'indisi saqlanib qoldi (cumulative), faqat egri chiziq tiklanmaydi.`,
    );

    return { registrationNo: saveResult.registrationNo, missedMinutes };
  } catch (error) {
    console.error('[gap] aniqlashda xato:', error.message);
    return null;
  }
}

/** So'nggi bo'shliqlar ro'yxati (monitoring uchun). */
export function getRecentSyncGaps(limit = 50) {
  const cleanLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 50));
  return getDb()
    .prepare(
      'SELECT registrationNo, gapStart, gapEnd, missedMinutes, detectedAt FROM sync_gaps ORDER BY detectedAt DESC LIMIT ?',
    )
    .all(cleanLimit);
}

/** So'nggi 24 soatdagi bo'shliqlar soni (qisqa xulosa uchun). */
export function getSyncGapSummary() {
  const db = getDb();
  const last24h = db
    .prepare("SELECT COUNT(*) AS c FROM sync_gaps WHERE detectedAt >= datetime('now', '-24 hours')")
    .get();
  const total = db.prepare('SELECT COUNT(*) AS c FROM sync_gaps').get();
  return {
    last24h: last24h?.c ?? 0,
    total: total?.c ?? 0,
  };
}
