import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const { createApp } = await import('./src/app.js');
const { config } = await import('./src/config.js');
const { startDeviceSyncScheduler, stopDeviceSyncScheduler } = await import(
  './src/services/device-sync-service.js'
);
const { startSolaxRealtimeSyncScheduler, stopSolaxRealtimeSyncScheduler } = await import(
  './src/services/solax-realtime-sync-service.js'
);
const { getTelegramBotState, startTelegramBot, stopTelegramBot } = await import(
  './src/services/telegram-bot-service.js'
);

let server = null;
let shuttingDown = false;

if (config.isDefaultJwtSecret) {
  console.warn("[security] JWT_SECRET default qiymatda turibdi. Productionda o'zgartiring.");
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const nextServer = app.listen(config.port, config.host);
    nextServer.once('listening', () => resolve(nextServer));
    nextServer.once('error', reject);
  });
}

function closeServer() {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    server.close((error) => {
      if (error) {
        console.error('[backend] Server yopishda xatolik:', error);
      }

      resolve();
    });
  });
}

async function startBackend() {
  const app = createApp();
  server = await listen(app);

  console.log(`[backend] ${config.publicUrl}`);
  console.log(`[backend-bind] ${config.host}:${config.port}`);
  console.log(`[swagger] ${config.publicUrl}/docs`);

  await startDeviceSyncScheduler();
  await startSolaxRealtimeSyncScheduler();
}

function startBot() {
  if (!config.telegramBotToken) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN sozlanmagan, bot ishga tushmadi.');
    return;
  }

  console.log('[telegram-bot] Bot ishga tushmoqda...');
  const pollingPromise = startTelegramBot();
  const state = getTelegramBotState();
  console.log('[telegram-bot] Long polling boshlandi.');
  console.log(`[telegram-bot] Enabled=${state.enabled}, running=${state.running}`);

  pollingPromise.catch((error) => {
    if (shuttingDown) {
      return;
    }

    console.error('[telegram-bot] Ishdan toxtadi:', error);
    shutdown('telegram-bot-error', 1).catch((shutdownError) => {
      console.error('[main] Shutdown xatosi:', shutdownError);
      process.exit(1);
    });
  });
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[main] ${signal} qabul qilindi, servislar to'xtatilmoqda`);

  stopDeviceSyncScheduler();
  stopSolaxRealtimeSyncScheduler();
  await stopTelegramBot().catch((error) => {
    console.error('[telegram-bot] Bot toxtatishda xatolik:', error);
  });
  await closeServer();

  process.exit(exitCode);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('[main] SIGINT shutdown xatosi:', error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('[main] SIGTERM shutdown xatosi:', error);
    process.exit(1);
  });
});

process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error);
  shutdown('uncaughtException', 1).catch(() => process.exit(1));
});

process.on('unhandledRejection', (error) => {
  console.error('[main] unhandledRejection:', error);
  shutdown('unhandledRejection', 1).catch(() => process.exit(1));
});

try {
  await startBackend();
  startBot();
} catch (error) {
  console.error('[main] Ishga tushmadi:', error);
  await shutdown('startup-error', 1);
}
