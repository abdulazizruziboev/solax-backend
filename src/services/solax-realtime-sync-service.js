import { setTimeout as delay } from 'node:timers/promises';

import { config } from '../config.js';
import {
  getRealtimeSyncTargetByRegistrationNo,
  listRealtimeSyncTargets,
  saveDeviceRealtimeStats,
} from './device-service.js';
import { getSetting, setSetting } from './settings-service.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { recordGapIfAny, getSyncGapSummary } from './gap-detection-service.js';

const SOLAX_REALTIME_SOURCE = 'solax-realtime-api';
const MAX_REPORTED_ERRORS = 20;
const SOLAX_REALTIME_INTERVAL_SETTING_KEY = 'solaxRealtimeSyncIntervalMs';
const MIN_SOLAX_REALTIME_INTERVAL_MS = 60 * 1000;
const SCHEDULE_RECHECK_MS = 60 * 1000;

let schedulerStarted = false;
let schedulerTimer = null;
let activeRunPromise = null;

const solaxBreaker = new CircuitBreaker({
  name: 'solax-api',
  failureThreshold: config.solaxCircuitFailureThreshold,
  openMs: config.solaxCircuitOpenMs,
});

const CIRCUIT_OPEN_CODE = 'CIRCUIT_OPEN';

// Jonli progress — sync paytida qaysi qurilma ishlanayotganini kuzatish uchun.
const liveProgress = {
  running: false,
  trigger: null,
  current: 0,
  total: 0,
  succeeded: 0,
  failed: 0,
  currentDevice: null,
  startedAt: null,
  finishedAt: null,
};

export function getSyncLiveProgress() {
  return { ...liveProgress };
}

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
    throw new Error('Realtime sync interval kamida 1 daqiqa bo\'lishi kerak');
  }

  return parsed;
}

function getRealtimeIntervalMs() {
  const storedInterval = getSetting(SOLAX_REALTIME_INTERVAL_SETTING_KEY, config.solaxRealtimeSyncIntervalMs);
  const intervalMs = normaliseRealtimeIntervalMs(storedInterval);
  schedulerState.intervalMs = intervalMs;
  return intervalMs;
}

function buildRealtimeUrl(registrationNo) {
  const cleanRegistrationNo = String(registrationNo || '').trim();

  if (!cleanRegistrationNo) {
    throw new Error('registrationNo bosh');
  }

  const url = new URL(config.solaxRealtimeApiUrl);
  url.searchParams.set('tokenId', config.solaxRealtimeTokenId);
  url.searchParams.set('sn', cleanRegistrationNo);
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

// SolaX Cloud "online" ni qurilma OXIRGI MARTA ma'lumot yuklagan vaqti bo'yicha
// aniqlaydi: yaqinda yuklagan bo'lsa — online, aks holda — offline.
// Biz ham aynan shu mantiqni ishlatamiz (inverterStatus'ga tayanmaymiz, chunki
// u eski qiymat bilan qolib "soxta online" berardi). Shu bilan sanog'imiz
// SolaX'nikiga 1:1 mos keladi.
function inferOnlineStatus(uploadedAt) {
  if (!uploadedAt) {
    return 'Offline';
  }

  const uploadedAtMs = new Date(uploadedAt).getTime();
  if (!Number.isFinite(uploadedAtMs)) {
    return 'Offline';
  }

  const diffMs = Math.abs(Date.now() - uploadedAtMs);
  const thresholdMs = config.solaxRealtimeOnlineThresholdMs || 30 * 60 * 1000;

  return diffMs <= thresholdMs ? 'Online' : 'Offline';
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

  const uploadedAt = getDateField(result, [
    'uploadTime',
    'uploadtime',
    'utcDateTime',
    'utcdatetime',
    'utcTime',
    'updateTime',
    'updatedAt',
    'time',
    'timestamp',
    'lastUpdateTime',
  ]);
  const realtime = {
    ratedPower: getNumberField(result, ['ratedPower', 'ratedpower']),
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
    uploadedAt,
    onlineStatus: inferOnlineStatus(uploadedAt),
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

function normaliseRegistrationNos(registrationNos) {
  return [
    ...new Set(
      (Array.isArray(registrationNos) ? registrationNos : [registrationNos])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  ];
}

async function syncRealtimeTarget(target, summary, syncedAt) {
  // Circuit ochiq bo'lsa — SolaX'ga urinmaymiz. Bazadagi (keshdagi) eng oxirgi
  // qiymat o'zgarishsiz qoladi va frontend o'shani ko'rsatishda davom etadi.
  if (!solaxBreaker.canAttempt()) {
    summary.skipped += 1;
    summary.processed += 1;
    summary.circuitOpen = true;
    const error = new Error("SolaX vaqtincha ishlamayapti (circuit ochiq)");
    error.code = CIRCUIT_OPEN_CODE;
    throw error;
  }

  try {
    const realtime = await fetchRealtimeInfo(target.registrationNo);
    solaxBreaker.recordSuccess();

    const saveResult = saveDeviceRealtimeStats({
      registrationNo: target.registrationNo,
      deviceSn: target.deviceSn,
      collectedAt: syncedAt,
      uploadedAt: realtime.uploadedAt,
      acPower: realtime.acPower,
      ratedPower: realtime.ratedPower,
      yieldToday: realtime.yieldToday,
      yieldTotal: realtime.yieldTotal,
      onlineStatus: realtime.onlineStatus,
      source: SOLAX_REALTIME_SOURCE,
    });

    // Ma'lumot bo'shlig'ini (gap) aniqlash va qayd etish — tez DB amali, inline
    recordGapIfAny(saveResult, getRealtimeIntervalMs());

    // Quvvat keskin tushishini tekshirish (egasi + adminlarga xabar) — sync'ni bloklamaydi
    import('./power-alert-service.js')
      .then(({ checkAndNotifyPowerDrop }) => checkAndNotifyPowerDrop(saveResult))
      .catch(() => {});

    // SSE broadcast
    try {
      const { broadcastToDevice } = await import('./sse-service.js');
      broadcastToDevice(target.registrationNo, 'device-update', {
        registrationNo: target.registrationNo,
        acPower: realtime.acPower,
        yieldToday: realtime.yieldToday,
        yieldTotal: realtime.yieldTotal,
        onlineStatus: realtime.onlineStatus,
      });
    } catch {
      // SSE xatosini e'tiborsiz qoldiramiz
    }

    summary.succeeded += 1;
  } catch (error) {
    summary.failed += 1;
    pushSummaryError(summary, target, error);

    if (isQuotaError(error)) {
      // Quota — bu vaqtinchalik kunlik limit, xizmat nosozligi emas.
      // Circuit'ni ochmaymiz, faqat navbatdagi urinishlarni to'xtatamiz.
      summary.quotaLimited = true;
      throw error;
    }

    // Haqiqiy nosozlik (timeout, 5xx, tarmoq) — circuit breaker'ga yozamiz
    solaxBreaker.recordFailure();
  } finally {
    summary.processed += 1;
  }
}

async function executeTargetsSync(trigger, targets, { requestedTargets = targets.length, skipped = 0 } = {}) {
  const startedAt = new Date().toISOString();
  const summary = {
    trigger,
    source: SOLAX_REALTIME_SOURCE,
    syncedAt: startedAt,
    intervalMs: getRealtimeIntervalMs(),
    requestedTargets,
    totalTargets: targets.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped,
    quotaLimited: false,
    circuitOpen: false,
    errors: [],
  };

  schedulerState.isRunning = true;
  schedulerState.lastRunAt = startedAt;

  liveProgress.running = true;
  liveProgress.trigger = trigger;
  liveProgress.total = targets.length;
  liveProgress.current = 0;
  liveProgress.succeeded = 0;
  liveProgress.failed = 0;
  liveProgress.currentDevice = null;
  liveProgress.startedAt = startedAt;
  liveProgress.finishedAt = null;

  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];

      // Progress: shu qurilma hozir ishlanmoqda
      liveProgress.current = index + 1;
      liveProgress.currentDevice = target.registrationNo;

      try {
        await syncRealtimeTarget(target, summary, startedAt);
      } catch (error) {
        if (isQuotaError(error)) {
          summary.skipped += targets.length - index - 1;
          break;
        }

        // Circuit ochilib ketdi — qolgan qurilmalarni ham urinmaymiz, keshdagi
        // ma'lumot bilan ishlashda davom etamiz (SolaX'ni bo'shatib qo'yamiz).
        if (error.code === CIRCUIT_OPEN_CODE) {
          summary.circuitOpen = true;
          summary.skipped += targets.length - index - 1;
          break;
        }
      }

      liveProgress.succeeded = summary.succeeded;
      liveProgress.failed = summary.failed;

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
    liveProgress.running = false;
    liveProgress.currentDevice = null;
    liveProgress.finishedAt = new Date().toISOString();
    activeRunPromise = null;
  }
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
    const targets = listRealtimeSyncTargets();
    return executeTargetsSync(trigger, targets);
  })();

  return activeRunPromise;
}

async function executeSelectedSync(trigger, registrationNos) {
  if (!schedulerState.enabled) {
    return {
      trigger,
      enabled: false,
      message: 'SolaX realtime sync o\'chiq yoki token sozlanmagan',
    };
  }

  if (activeRunPromise) {
    await activeRunPromise.catch(() => null);
  }

  const cleanRegistrationNos = normaliseRegistrationNos(registrationNos);
  const targets = cleanRegistrationNos
    .map((registrationNo) => getRealtimeSyncTargetByRegistrationNo(registrationNo))
    .filter(Boolean);

  activeRunPromise = executeTargetsSync(trigger, targets, {
    requestedTargets: cleanRegistrationNos.length,
    skipped: cleanRegistrationNos.length - targets.length,
  });

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
    // Chegara hali 60s dan uzoq bo'lsa — qayta tekshiramiz (recheck).
    // Chegaraga yetganda (delayMs <= recheck) — sync'ni ishga tushiramiz.
    if (timerDelayMs < delayMs) {
      scheduleNextRun();
      return;
    }

    executeSync('schedule')
      .catch(() => null)
      .finally(() => {
        scheduleNextRun();
      });
  }, timerDelayMs);

  schedulerTimer.unref?.();
}

export function isSolaxQuotaError(error) {
  return isQuotaError(error);
}

export async function verifySolaxSerialNumber(serialNumber) {
  const cleanSerialNumber = String(serialNumber || '').trim();

  if (!cleanSerialNumber) {
    throw new Error('serialNumber bosh');
  }

  if (!config.solaxRealtimeTokenId) {
    const error = new Error('SolaX token sozlanmagan');
    error.code = 'SOLAX_TOKEN_MISSING';
    throw error;
  }

  return fetchRealtimeInfo(cleanSerialNumber);
}

export function getSolaxRealtimeSyncState() {
  if (schedulerState.enabled) {
    getRealtimeIntervalMs();
  }

  return {
    ...schedulerState,
    minIntervalMs: MIN_SOLAX_REALTIME_INTERVAL_MS,
    circuit: solaxBreaker.getState(),
    gaps: getSyncGapSummary(),
  };
}

export async function runSolaxRealtimeSyncNow(trigger = 'manual') {
  const result = await executeSync(trigger);

  if (schedulerStarted) {
    scheduleNextRun();
  }

  return result;
}

export async function runSolaxRealtimeSyncForDevices(registrationNos, trigger = 'device-created') {
  const result = await executeSelectedSync(trigger, registrationNos);

  if (schedulerStarted) {
    scheduleNextRun();
  }

  return result;
}

export function runSolaxRealtimeSyncForDevice(registrationNo, trigger = 'device-created') {
  return runSolaxRealtimeSyncForDevices([registrationNo], trigger);
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
