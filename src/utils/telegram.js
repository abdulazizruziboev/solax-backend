import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';
import { AppError } from '../middleware/errors.js';

function safeEqualHex(expectedHex, actualHex) {
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(actualHex, 'hex');

    if (expected.length === 0 || expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function verifyTelegramInitData(initData) {
  if (!config.telegramBotToken) {
    throw new AppError(503, 'Telegram bot token sozlanmagan');
  }

  if (!initData || typeof initData !== 'string') {
    throw new AppError(400, 'initData yuborilishi kerak');
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));

  if (!receivedHash) {
    throw new AppError(400, 'Telegram hash topilmadi');
  }

  if (!Number.isFinite(authDate)) {
    throw new AppError(400, "auth_date noto'g'ri");
  }

  const currentUnixTime = Math.floor(Date.now() / 1000);
  const ageSeconds = currentUnixTime - authDate;

  if (ageSeconds > config.telegramInitDataTtl) {
    throw new AppError(401, 'Telegram sessiyasi eskirgan');
  }

  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!safeEqualHex(expectedHash, receivedHash)) {
    throw new AppError(401, 'Telegram initData tasdiqlanmadi');
  }

  const telegramUserRaw = params.get('user');

  if (!telegramUserRaw) {
    throw new AppError(400, "Telegram foydalanuvchi ma'lumoti topilmadi");
  }

  let telegramUser;

  try {
    telegramUser = JSON.parse(telegramUserRaw);
  } catch {
    throw new AppError(400, 'Telegram user JSON xato');
  }

  if (!telegramUser?.id) {
    throw new AppError(400, 'Telegram user id topilmadi');
  }

  return {
    authDate,
    queryId: params.get('query_id'),
    user: telegramUser,
  };
}
