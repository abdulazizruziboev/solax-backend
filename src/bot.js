import { getTelegramBotState, startTelegramBot, stopTelegramBot } from './services/telegram-bot-service.js';
import { config } from './config.js';

async function shutdown(signal) {
  console.log(`[telegram-bot] ${signal} qabul qilindi, bot to'xtatilmoqda`);
  await stopTelegramBot();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('[telegram-bot] SIGINT shutdown xatosi:', error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('[telegram-bot] SIGTERM shutdown xatosi:', error);
    process.exit(1);
  });
});

try {
  if (!config.telegramBotEnabled) {
    console.warn('[telegram-bot] TELEGRAM_BOT_ENABLED=false, bot ishga tushmadi.');
    process.exit(0);
  }

  console.log('[telegram-bot] Bot ishga tushmoqda...');
  const pollingPromise = startTelegramBot();
  const state = getTelegramBotState();
  console.log('[telegram-bot] Long polling boshlandi.');
  console.log(`[telegram-bot] Enabled=${state.enabled}, running=${state.running}`);
  await pollingPromise;
} catch (error) {
  console.error('[telegram-bot] Ishga tushmadi:', error);
  process.exit(1);
}
