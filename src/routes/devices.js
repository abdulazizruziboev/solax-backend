import { Router } from 'express';

import { requireAuth, requirePermission, requireRoles } from '../middleware/auth.js';
import { AppError, asyncHandler } from '../middleware/errors.js';
import {
  areDevicesVisibleToAll,
  canUserReadDevice,
  claimDevice,
  createDevice,
  deleteDevice,
  findDeviceBySerial,
  getDailyEnergySeries,
  getEnergyChart,
  getDeviceByRegistrationNo,
  getDeviceTotals,
  getDeviceVisibilitySettings,
  listDevicesByTelegramId,
  listDevicesForUser,
  listDevices,
  setDevicesVisibleToAll,
  unclaimDevice,
  updateDevice,
} from '../services/device-service.js';
import { getDeviceSyncState, runDeviceSyncNow } from '../services/device-sync-service.js';
import {
  getSolaxRealtimeSyncState,
  isSolaxQuotaError,
  runSolaxRealtimeSyncForDevice,
  runSolaxRealtimeSyncNow,
  verifySolaxSerialNumber,
} from '../services/solax-realtime-sync-service.js';

const devicesRouter = Router();

devicesRouter.use(requireAuth);

const requireAdmin = requireRoles('admin', 'super_admin');
const requireDeviceCrud = requirePermission('devices.crud');

function hasAdminDeviceAccess(user) {
  return user?.role === 'admin' || user?.role === 'super_admin';
}

function canReadTelegramDevices(user, telegramId) {
  if (hasAdminDeviceAccess(user) || areDevicesVisibleToAll()) {
    return true;
  }

  return String(user?.telegramId || '').trim() === String(telegramId || '').trim();
}

function canReadDevice(user, device) {
  return canUserReadDevice(user, device);
}

devicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!hasAdminDeviceAccess(req.auth?.user) && !areDevicesVisibleToAll()) {
      return res.status(403).json({
        ok: false,
        message: "Device ro'yxatini ko'rish huquqi yo'q",
      });
    }

    const payload = listDevices({
      search: req.query.search,
      status: req.query.status,
      source: req.query.source,
      trackingEnabled: req.query.trackingEnabled,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });

    res.json({
      ok: true,
      ...payload,
    });
  }),
);

devicesRouter.get(
  '/status',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      status: getDeviceTotals(),
      sync: getDeviceSyncState(),
    });
  }),
);

devicesRouter.get(
  '/visibility',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      visibility: getDeviceVisibilitySettings(),
    });
  }),
);

devicesRouter.patch(
  '/visibility',
  requireDeviceCrud,
  asyncHandler(async (req, res) => {
    const visibility = setDevicesVisibleToAll(req.body?.devicesVisibleToAll ?? req.body?.visibleToAll ?? req.body?.enabled, {
      updatedBy: req.auth?.user?.id,
    });

    res.json({
      ok: true,
      visibility,
    });
  }),
);

devicesRouter.get(
  '/sync/status',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      sync: getDeviceSyncState(),
    });
  }),
);

devicesRouter.post(
  '/sync',
  requireDeviceCrud,
  asyncHandler(async (_req, res) => {
    const sync = await runDeviceSyncNow('manual-api');
    res.json({
      ok: true,
      sync,
    });
  }),
);

devicesRouter.get(
  '/realtime/status',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      realtimeSync: getSolaxRealtimeSyncState(),
    });
  }),
);

devicesRouter.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const payload = listDevicesForUser({
      userId: req.auth.user.id,
      telegramId: req.auth.user.telegramId,
    });

    res.json({
      ok: true,
      ...payload,
    });
  }),
);

devicesRouter.post(
  '/claim',
  asyncHandler(async (req, res) => {
    const serialNumber = String(req.body?.serialNumber ?? req.body?.sn ?? '').trim();

    if (!serialNumber) {
      throw new AppError(400, 'serialNumber yuborilishi kerak');
    }

    let device = findDeviceBySerial(serialNumber);
    let created = false;

    if (!device) {
      try {
        await verifySolaxSerialNumber(serialNumber);
      } catch (error) {
        console.error('[devices] SN tekshiruvi muvaffaqiyatsiz:', serialNumber, error.message);

        if (error.code === 'SOLAX_TOKEN_MISSING' || isSolaxQuotaError(error)) {
          throw new AppError(
            503,
            "Hozircha SN ni tekshirib bo'lmadi. Birozdan so'ng qayta urining.",
          );
        }

        throw new AppError(
          404,
          "Bu seriya raqami bo'yicha qurilma topilmadi. SN ni tekshirib qayta urining.",
        );
      }

      device = createDevice({
        registrationNo: serialNumber,
        source: 'user-claim',
      });
      created = true;
    }

    const claimedDevice = claimDevice({
      userId: req.auth.user.id,
      registrationNo: device.registrationNo,
      telegramId: req.auth.user.telegramId,
      claimedVia: 'sn-claim',
    });

    runSolaxRealtimeSyncForDevice(device.registrationNo, 'device-claimed').catch((error) => {
      console.error('[devices] Claim realtime sync xatosi:', error);
    });

    res.status(201).json({
      ok: true,
      created,
      device: claimedDevice,
    });
  }),
);

devicesRouter.delete(
  '/claim/:registrationNo',
  asyncHandler(async (req, res) => {
    const result = unclaimDevice({
      userId: req.auth.user.id,
      registrationNo: req.params.registrationNo,
      telegramId: req.auth.user.telegramId,
    });

    res.json({
      ok: true,
      ...result,
    });
  }),
);

devicesRouter.get(
  '/energy/today',
  asyncHandler(async (req, res) => {
    if (!hasAdminDeviceAccess(req.auth?.user) && !areDevicesVisibleToAll()) {
      return res.status(403).json({
        ok: false,
        message: "Umumiy chartni ko'rish huquqi yo'q",
      });
    }

    const chart = getEnergyChart({
      registrationNo: req.query.registrationNo,
      date: req.query.date,
    });

    res.json({
      ok: true,
      chart,
      data: chart.data,
    });
  }),
);

devicesRouter.get(
  '/energy/daily',
  asyncHandler(async (req, res) => {
    if (!hasAdminDeviceAccess(req.auth?.user) && !areDevicesVisibleToAll()) {
      return res.status(403).json({
        ok: false,
        message: "Umumiy chartni ko'rish huquqi yo'q",
      });
    }

    const chart = getDailyEnergySeries({
      registrationNo: req.query.registrationNo,
      endDate: req.query.endDate ?? req.query.date,
      days: req.query.days,
    });

    res.json({
      ok: true,
      chart,
      data: chart.data,
    });
  }),
);

devicesRouter.post(
  '/realtime/sync',
  requireDeviceCrud,
  asyncHandler(async (_req, res) => {
    const realtimeSync = await runSolaxRealtimeSyncNow('manual-api');
    res.json({
      ok: true,
      realtimeSync,
    });
  }),
);

devicesRouter.get(
  '/:registrationNo/energy/today',
  asyncHandler(async (req, res) => {
    const chart = getEnergyChart({
      registrationNo: req.params.registrationNo,
      date: req.query.date,
    });

    if (!canReadDevice(req.auth?.user, chart.device)) {
      return res.status(403).json({
        ok: false,
        message: "Bu qurilma chartini ko'rish huquqi yo'q",
      });
    }

    res.json({
      ok: true,
      chart,
      data: chart.data,
    });
  }),
);

devicesRouter.get(
  '/:registrationNo/energy/daily',
  asyncHandler(async (req, res) => {
    const chart = getDailyEnergySeries({
      registrationNo: req.params.registrationNo,
      endDate: req.query.endDate ?? req.query.date,
      days: req.query.days,
    });

    if (!canReadDevice(req.auth?.user, chart.device)) {
      return res.status(403).json({
        ok: false,
        message: "Bu qurilma chartini ko'rish huquqi yo'q",
      });
    }

    res.json({
      ok: true,
      chart,
      data: chart.data,
    });
  }),
);

devicesRouter.get(
  ['/telegram/:telegramId', '/telegam/:telegramId'],
  asyncHandler(async (req, res) => {
    if (!canReadTelegramDevices(req.auth?.user, req.params.telegramId)) {
      return res.status(403).json({
        ok: false,
        message: "Bu Telegram ID bo'yicha qurilmalarni ko'rish huquqi yo'q",
      });
    }

    const payload = listDevicesByTelegramId(req.params.telegramId);
    res.json({
      ok: true,
      ...payload,
    });
  }),
);

devicesRouter.get(
  '/:registrationNo',
  asyncHandler(async (req, res) => {
    const device = getDeviceByRegistrationNo(req.params.registrationNo);

    if (!canReadDevice(req.auth?.user, device)) {
      return res.status(403).json({
        ok: false,
        message: "Bu qurilmani ko'rish huquqi yo'q",
      });
    }

    res.json({
      ok: true,
      device,
    });
  }),
);

devicesRouter.post(
  '/',
  requireDeviceCrud,
  asyncHandler(async (req, res) => {
    const device = createDevice(req.body || {});
    runSolaxRealtimeSyncForDevice(device.registrationNo, 'device-created-api').catch((error) => {
      console.error('[devices] Yangi device realtime sync xatosi:', error);
    });

    res.status(201).json({
      ok: true,
      device,
      realtimeSyncQueued: true,
    });
  }),
);

devicesRouter.patch(
  ['/:registrationNo/telegram', '/:registrationNo/telegram-ids'],
  requireDeviceCrud,
  asyncHandler(async (req, res) => {
    const device = updateDevice(req.params.registrationNo, req.body || {});
    res.json({
      ok: true,
      device,
    });
  }),
);

devicesRouter.post(
  ['/:registrationNo/telegram', '/:registrationNo/telegram-ids'],
  requireDeviceCrud,
  asyncHandler(async (req, res) => {
    const device = updateDevice(req.params.registrationNo, req.body || {});
    res.json({
      ok: true,
      device,
    });
  }),
);

devicesRouter.patch(
  '/:registrationNo',
  requireDeviceCrud,
  asyncHandler(async (req, res) => {
    const device = updateDevice(req.params.registrationNo, req.body || {});
    res.json({
      ok: true,
      device,
    });
  }),
);

devicesRouter.delete(
  '/:registrationNo',
  requireDeviceCrud,
  asyncHandler(async (req, res) => {
    const result = deleteDevice(req.params.registrationNo);
    res.json({
      ok: true,
      ...result,
    });
  }),
);

export { devicesRouter };
