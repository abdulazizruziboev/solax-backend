import { setTimeout as delay } from 'node:timers/promises';

import { config } from '../config.js';
import { listRealtimeSyncTargets, saveDeviceRealtimeStats } from './device-service.js';
import { getSetting, setSetting } from './settings-service.js';

const SOLAX_REALTIME_SOURCE = 'solax-realtime-api';
const MAX_REPORTED_ERRORS = 20;
const SOLAX_REALTIME_INTERVAL_SETTING_KEY = 'solaxRealtimeSyncIntervalMs';
const MIN_SOLAX_REALTIME_INTERVAL_MS = 60 * 60 * 1000;
const SCHEDULE_RECHECK_MS = 60 * 1000;

let schedulerStarted = false;
let schedulerTimer = null;
let activeRunPromise = null;

const schedulerState = {
  enabled: config.solaxRealtimeSyncEnabled && Boolean(config.solaxRealtimeTokenId),
  intervalMs: config.solaxRealtimeSyncIntervalMs,
  apiUrl: config.solaxRealtimeApiUrl,
  startedAt: null,
  nextRunAt: null,
  isRunning: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastSummary: null,
};

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

function normaliseRealtimeIntervalMs(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error('Realtime sync interval noto\'g\'ri');
  }

  if (parsed < MIN_SOLAX_REALTIME_INTERVAL_MS) {
    throw new Error('Realtime sync interval kamida 1 soat bo\'lishi kerak');
  }

  return parsed;
}

function getRealtimeIntervalMs() {
  const storedInterval = getSetting(SOLAX_REALTIME_INTERVAL_SETTING_KEY, config.solaxRealtimeSyncIntervalMs);
  const intervalMs = normaliseRealtimeIntervalMs(storedInterval);
  schedulerState.intervalMs = intervalMs;
  return intervalMs;
}

function buildRealtimeUrl(deviceSn) {
  const url = new URL(config.solaxRealtimeApiUrl);
  url.searchParams.set('tokenId', config.solaxRealtimeTokenId);
  url.searchParams.set('sn', deviceSn);
  return url;
}

function getCaseInsensitiveValue(source, candidateKeys) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const entries = Object.entries(source);
  for (const candidateKey of candidateKeys) {
    const match = entries.find(([key]) => key.toLowerCase() === candidateKey.toLowerCase());
    if (match && match[1] !== undefined && match[1] !== null && match[1] !== '') {
      return match[1];
    }
  }

  return undefined;
}

function getNumberField(source, candidateKeys) {
  const value = getCaseInsensitiveValue(source, candidateKeys);
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function getDateField(source, candidateKeys) {
  const value = getCaseInsensitiveValue(source, candidateKeys);
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseRealtimePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('SolaX realtime javobi bosh yoki noto\'g\'ri');
  }

  if (payload.success === false) {
    throw new Error(
      payload.result || payload.exception || `SolaX API xatosi: code=${payload.code ?? 'unknown'}`,
    );
  }

  const result = payload.result ?? payload.data ?? payload;

  if (!result || typeof result !== 'object') {
    throw new Error('SolaX realtime result topilmadi');
  }

  if (result.success === false) {
    throw new Error(result.exception || `SolaX API xatosi: code=${result.code ?? 'unknown'}`);
  }

  const realtime = {
    acPower: getNumberField(result, [
      'acPower',
      'acpower',
      'pac',
      'power',
      'outputPower',
      'inverterPower',
    ]),
    yieldToday: getNumberField(result, [
      'yieldToday',
      'yieldtoday',
      'todayYield',
      'todayyield',
      'etoday',
      'eToday',
      'energyToday',
    ]),
    yieldTotal: getNumberField(result, [
      'yieldTotal',
      'yieldtotal',
      'totalYield',
      'totalyield',
      'etotal',
      'eTotal',
      'energyTotal',
    ]),
    uploadedAt: getDateField(result, [
      'uploadTime',
      'uploadtime',
      'updateTime',
      'updatedAt',
      'time',
      'timestamp',
      'lastUpdateTime',
    ]),
  };

  if (realtime.acPower === null && realtime.yieldToday === null && realtime.yieldTotal === null) {
    throw new Error('SolaX realtime power fieldlari topilmadi');
  }

  return realtime;
}

function isQuotaError(error) {
  return /maximum call threshold|quota|rate limit|too many/i.test(error?.message || '');
}

async function fetchRealtimeInfo(registrationNo) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.solaxRealtimeRequestTimeoutMs);

  try {
    const response = await fetch(buildRealtimeUrl(registrationNo), {
      method: 'GET',
      signal: controller.signal,
    });
    const payload = await response.json().catch(async () => {
      const text = await response.text().catch(() => '');
      return { success: false, exception: text || `HTTP ${response.status}` };
    });

    if (!response.ok) {
      throw new Error(`SolaX API HTTP ${response.status}`);
    }

    return parseRealtimePayload(payload);
  } finally {
    clearTimeout(timeout);
  }
}

function pushSummaryError(summary, target, error) {
  if (summary.errors.length >= MAX_REPORTED_ERRORS) {
    return;
  }

  summary.errors.push({
    registrationNo: target.registrationNo,
    deviceSn: target.deviceSn,
    message: error.message,
  });
}

async function executeSync(trigger) {
  if (!schedulerState.enabled) {
    return {
      trigger,
      enabled: false,
      message: 'SolaX realtime sync o\'chiq yoki token sozlanmagan',
    };
  }

  if (activeRunPromise) {
    return activeRunPromise;
  }

  activeRunPromise = (async () => {
    const startedAt = new Date().toISOString();
    const targets = listRealtimeSyncTargets();
    const summary = {
      trigger,
      source: SOLAX_REALTIME_SOURCE,
      syncedAt: startedAt,
      intervalMs: getRealtimeIntervalMs(),
      totalTargets: targets.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      quotaLimited: false,
      errors: [],
    };

    schedulerState.isRunning = true;
    schedulerState.lastRunAt = startedAt;

    try {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];

        try {
          const realtime = await fetchRealtimeInfo(target.registrationNo);
          saveDeviceRealtimeStats({
            registrationNo: target.registrationNo,
            deviceSn: target.deviceSn,
            collectedAt: startedAt,
            uploadedAt: realtime.uploadedAt,
            acPower: realtime.acPower,
            yieldToday: realtime.yieldToday,
            yieldTotal: realtime.yieldTotal,
            source: SOLAX_REALTIME_SOURCE,
          });
          summary.succeeded += 1;
        } catch (error) {
          summary.failed += 1;
          pushSummaryError(summary, target, error);

          if (isQuotaError(error)) {
            summary.quotaLimited = true;
            summary.skipped = targets.length - index - 1;
            break;
          }
        }

        summary.processed += 1;

        if (config.solaxRealtimeRequestDelayMs > 0 && index < targets.length - 1) {
          await delay(config.solaxRealtimeRequestDelayMs);
        }
      }

      schedulerState.lastSuccessAt = startedAt;
      schedulerState.lastErrorAt = null;
      schedulerState.lastError = null;
      schedulerState.lastSummary = summary;

      console.log(
        `[solax-realtime] ${trigger}: targets=${summary.totalTargets}, processed=${summary.processed}, succeeded=${summary.succeeded}, failed=${summary.failed}, skipped=${summary.skipped}`,
      );

      return summary;
    } catch (error) {
      schedulerState.lastErrorAt = startedAt;
      schedulerState.lastError = error.message;
      console.error('[solax-realtime] Sync ishlamadi', error);
      throw error;
    } finally {
      schedulerState.isRunning = false;
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

function scheduleNextRun() {
  if (!schedulerStarted || !schedulerState.enabled) {
    schedulerState.nextRunAt = null;
    return;
  }

  clearScheduledRun();

  const delayMs = getDelayUntilNextRun(getRealtimeIntervalMs());
  const timerDelayMs = Math.min(delayMs, SCHEDULE_RECHECK_MS);
  schedulerState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  schedulerTimer = setTimeout(() => {
    if (timerDelayMs < delayMs) {
      scheduleNextRun();
      return;
    }

    executeSync('schedule')
      .catch(() => null)
      .finally(() => {
        scheduleNextRun();
      });
  }, delayMs);

  schedulerTimer.unref?.();
}

export function getSolaxRealtimeSyncState() {
  if (schedulerState.enabled) {
    getRealtimeIntervalMs();
  }

  return {
    ...schedulerState,
    minIntervalMs: MIN_SOLAX_REALTIME_INTERVAL_MS,
  };
}

export async function runSolaxRealtimeSyncNow(trigger = 'manual') {
  const result = await executeSync(trigger);

  if (schedulerStarted) {
    scheduleNextRun();
  }

  return result;
}

export function setSolaxRealtimeSyncIntervalMs(intervalMs, { changedBy = null } = {}) {
  const nextIntervalMs = normaliseRealtimeIntervalMs(intervalMs);
  setSetting(SOLAX_REALTIME_INTERVAL_SETTING_KEY, nextIntervalMs, { updatedBy: changedBy });
  schedulerState.intervalMs = nextIntervalMs;

  if (schedulerStarted) {
    scheduleNextRun();
  }

  return getSolaxRealtimeSyncState();
}

export async function startSolaxRealtimeSyncScheduler() {
  if (schedulerStarted) {
    return getSolaxRealtimeSyncState();
  }

  schedulerStarted = true;
  schedulerState.enabled = config.solaxRealtimeSyncEnabled && Boolean(config.solaxRealtimeTokenId);
  schedulerState.startedAt = new Date().toISOString();
  schedulerState.intervalMs = getRealtimeIntervalMs();
  schedulerState.apiUrl = config.solaxRealtimeApiUrl;

  if (!schedulerState.enabled) {
    console.warn('[solax-realtime] Sync o\'chiq: SOLAX_TOKEN_ID sozlanmagan yoki sync disabled');
    return getSolaxRealtimeSyncState();
  }

  if (config.solaxRealtimeRunOnStart) {
    try {
      await executeSync('startup');
    } catch (_error) {
      // Server ishlashda davom etadi, keyingi intervalda yana urinib ko'riladi.
    }
  }

  scheduleNextRun();
  return getSolaxRealtimeSyncState();
}

export function stopSolaxRealtimeSyncScheduler() {
  schedulerStarted = false;
  clearScheduledRun();
  schedulerState.nextRunAt = null;
}
