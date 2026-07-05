import { getDb } from '../db.js';
import { config } from '../config.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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
    return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Har bir realtime sync natijasi uchun chaqiriladi.
 * Qurilmaning OLDINGI quvvati bilan yangisini solishtiradi va keskin tushish
 * bo'lsa qurilma egasiga hamda barcha adminlarga Telegram xabar yuboradi.
 * Geolokatsiyaga bog'liq emas — faqat qurilmaning o'z holati bo'yicha ishlaydi.
 */
export async function checkAndNotifyPowerDrop(result) {
  try {
    if (!config.powerDropAlertEnabled) {
      return;
    }

    if (!config.telegramBotEnabled || !config.telegramBotToken) {
      return;
    }

    const prev = Number(result?.previousAcPower);
    const next = Number(result?.acPower);

    if (!Number.isFinite(prev) || !Number.isFinite(next)) {
      return;
    }

    // Faqat qurilma hali aloqada bo'lsa — offline bo'lsa bu boshqa hodisa (uzilish)
    if (result.onlineStatus !== 'Online') {
      return;
    }

    // Faqat kunduzi (quyosh ishlab turadigan soatlar) tekshiramiz —
    // kechqurun quvvatning nolga tushishi tabiiy holat, ogohlantirish kerak emas.
    const hour = new Date().getHours();
    if (hour < config.powerDropActiveStartHour || hour >= config.powerDropActiveEndHour) {
      return;
    }

    // Avval sezilarli quvvat ishlab turgan bo'lishi kerak (shovqindan saqlanish)
    const rated = Number(result?.ratedPower);
    const ratedFloor = Number.isFinite(rated) && rated > 0 ? rated * config.powerDropRatedFraction : 0;
    const floor = Math.max(config.powerDropMinKw, ratedFloor);
    if (prev < floor) {
      return;
    }

    const dropRatio = (prev - next) / prev;
    if (dropRatio < config.powerDropRatio) {
      return;
    }

    const db = getDb();

    // Cooldown — bir qurilma uchun belgilangan vaqt ichida qayta xabar yubormaymiz
    const recent = db
      .prepare(
        "SELECT 1 FROM alerts WHERE registrationNo = ? AND type = 'power_drop' AND createdAt >= datetime('now', ?) LIMIT 1",
      )
      .get(result.registrationNo, `-${config.powerDropCooldownMinutes} minutes`);
    if (recent) {
      return;
    }

    const dropPct = Math.round(dropRatio * 100);
    const label = result.deviceName || result.plantName || result.registrationNo;
    const messageLines = [
      '⚠️ <b>Quvvat keskin tushdi</b>',
      `🔌 Qurilma: <code>${escapeHtml(result.registrationNo)}</code>`,
      label !== result.registrationNo ? `🏭 ${escapeHtml(label)}` : null,
      result.userName ? `👤 Egasi: ${escapeHtml(result.userName)}` : null,
      `📉 ${prev.toFixed(1)} kW → ${next.toFixed(1)} kW (−${dropPct}%)`,
    ].filter(Boolean);
    const message = messageLines.join('\n');

    db.prepare("INSERT INTO alerts (registrationNo, type, message) VALUES (?, 'power_drop', ?)").run(
      result.registrationNo,
      `${prev.toFixed(1)} kW -> ${next.toFixed(1)} kW (-${dropPct}%)`,
    );

    // Qabul qiluvchilar: qurilma egasi (biriktirilgan telegramIds) + barcha adminlar
    const owners = parseTelegramIds(result.telegramIds);
    const admins = db
      .prepare(
        "SELECT telegramId FROM app_users WHERE role IN ('admin','super_admin') AND telegramId IS NOT NULL AND telegramId != ''",
      )
      .all()
      .map((row) => row.telegramId);

    const chatIds = [...new Set([...owners, ...admins].map((id) => String(id).trim()).filter(Boolean))];
    if (chatIds.length === 0) {
      return;
    }

    const { sendTelegramMessageToMany } = await import('./telegram-bot-service.js');
    await sendTelegramMessageToMany(chatIds, message);

    console.log(
      `[power-alert] ${result.registrationNo}: quvvat ${prev.toFixed(1)}→${next.toFixed(1)} kW (-${dropPct}%), ${chatIds.length} ta chatga yuborildi`,
    );
  } catch (error) {
    console.error('[power-alert] xato:', error.message);
  }
}
