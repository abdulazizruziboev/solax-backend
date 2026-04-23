import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';
import { syncDevicesSnapshot } from './device-service.js';
import { runSolaxRealtimeSyncForDevices } from './solax-realtime-sync-service.js';

const DEVICE_SYNC_SOURCE = 'devices-json';

let schedulerStarted = false;
let schedulerTimer = null;
let activeRunPromise = null;

const schedulerState = {
  enabled: true,
  intervalMs: config.deviceSyncIntervalMs,
  sourcePath: null,
  startedAt: null,
  nextRunAt: null,
  isRunning: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastSummary: null,
};

function getBackendRoot() {
  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), '..', '..');
}

function resolveDeviceSourcePath() {
  return path.resolve(getBackendRoot(), config.deviceSyncSourcePath);
}

function clearScheduledRun() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

function getDelayUntilNextRun(intervalMs) {
  const now = Date.now();
  const remainder = now % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
}

async function loadSourceDevices() {
  const sourcePath = resolveDeviceSourcePath();
  schedulerState.sourcePath = sourcePath;

  const payload = await fs.readFile(sourcePath, 'utf8');
  const parsed = JSON.parse(payload);

  if (!Array.isArray(parsed)) {
    throw new Error(`Device source array bo'lishi kerak: ${sourcePath}`);
  }

  return parsed;
}

async function executeSync(trigger) {
  if (activeRunPromise) {
    return activeRunPromise;
  }

  activeRunPromise = (async () => {
    const startedAt = new Date().toISOString();

    schedulerState.isRunning = true;
    schedulerState.lastRunAt = startedAt;
    schedulerState.sourcePath = resolveDeviceSourcePath();

    try {
      const sourceDevices = await loadSourceDevices();
      const summary = syncDevicesSnapshot(sourceDevices, {
        syncedAt: startedAt,
        source: DEVICE_SYNC_SOURCE,
      });
      const enrichedSummary = {
        ...summary,
        trigger,
        source: DEVICE_SYNC_SOURCE,
        sourcePath: schedulerState.sourcePath,
      };

      schedulerState.lastSuccessAt = startedAt;
      schedulerState.lastErrorAt = null;
      schedulerState.lastError = null;
      schedulerState.lastSummary = enrichedSummary;

      if (enrichedSummary.insertedRegistrationNos.length > 0) {
        runSolaxRealtimeSyncForDevices(enrichedSummary.insertedRegistrationNos, `${trigger}-new-devices`).catch(
          (error) => {
            console.error('[device-sync] Yangi device realtime sync xatosi:', error);
          },
        );
      }

      console.log(
        `[device-sync] ${trigger}: processed=${summary.processed}, inserted=${summary.inserted}, updated=${summary.updated}, history=${summary.historyInserted}, failed=${summary.failed}`,
      );

      return enrichedSummary;
    } catch (error) {
      schedulerState.lastErrorAt = startedAt;
      schedulerState.lastError = error.message;
      console.error('[device-sync] Sync ishlamadi', error);
      throw error;
    } finally {
      schedulerState.isRunning = false;
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

function scheduleNextRun() {
  if (!schedulerStarted) {
    schedulerState.nextRunAt = null;
    return;
  }

  clearScheduledRun();

  const delayMs = getDelayUntilNextRun(config.deviceSyncIntervalMs);
  schedulerState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  schedulerTimer = setTimeout(() => {
    executeSync('schedule')
      .catch(() => null)
      .finally(() => {
        scheduleNextRun();
      });
  }, delayMs);

  schedulerTimer.unref?.();
}

export function getDeviceSyncState() {
  return {
    ...schedulerState,
  };
}

export async function runDeviceSyncNow(trigger = 'manual') {
  const result = await executeSync(trigger);

  if (schedulerStarted) {
    scheduleNextRun();
  }

  return result;
}

export async function startDeviceSyncScheduler() {
  if (schedulerStarted) {
    return getDeviceSyncState();
  }

  schedulerStarted = true;
  schedulerState.startedAt = new Date().toISOString();
  schedulerState.intervalMs = config.deviceSyncIntervalMs;
  schedulerState.sourcePath = resolveDeviceSourcePath();

  try {
    await executeSync('startup');
  } catch (_error) {
    // Server ishlashda davom etadi, keyingi intervalda yana urinib ko'riladi.
  } finally {
    scheduleNextRun();
  }

  return getDeviceSyncState();
}

export function stopDeviceSyncScheduler() {
  schedulerStarted = false;
  clearScheduledRun();
  schedulerState.nextRunAt = null;
}
