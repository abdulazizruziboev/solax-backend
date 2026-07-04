import { createApp } from './app.js';
import { config } from './config.js';
import {
  startDailyReportScheduler,
  stopDailyReportScheduler,
} from './services/daily-report-service.js';
import { startDeviceSyncScheduler, stopDeviceSyncScheduler } from './services/device-sync-service.js';
import {
  startSolaxRealtimeSyncScheduler,
  stopSolaxRealtimeSyncScheduler,
} from './services/solax-realtime-sync-service.js';
import { startBackupScheduler, stopBackupScheduler, createBackup } from './services/backup-service.js';

if (config.isDefaultJwtSecret) {
  console.warn("[security] JWT_SECRET default qiymatda turibdi. Productionda o'zgartiring.");
}

const app = createApp();

const server = app.listen(config.port, config.host, async () => {
  console.log(`[backend] ${config.publicUrl}`);
  console.log(`[backend-bind] ${config.host}:${config.port}`);
  console.log(`[swagger] ${config.publicUrl}/docs`);
  await startDeviceSyncScheduler();
  await startSolaxRealtimeSyncScheduler();
  startDailyReportScheduler();
  startBackupScheduler();
});

async function shutdown(signal) {
  console.log(`[backend] ${signal} qabul qilindi, server to'xtatilmoqda`);
  stopDeviceSyncScheduler();
  stopSolaxRealtimeSyncScheduler();
  stopDailyReportScheduler();
  stopBackupScheduler();

  try {
    await createBackup();
  } catch (error) {
    console.error('[backup] Shutdown backup xatosi:', error.message);
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
