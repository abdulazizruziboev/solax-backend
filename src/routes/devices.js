import { Router } from 'express';

import { requireAuth, requireRoles } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';
import {
  createDevice,
  deleteDevice,
  getDeviceByRegistrationNo,
  getDeviceTotals,
  listDevicesByTelegramId,
  listDevices,
  updateDevice,
} from '../services/device-service.js';
import { getDeviceSyncState, runDeviceSyncNow } from '../services/device-sync-service.js';
import {
  getSolaxRealtimeSyncState,
  runSolaxRealtimeSyncNow,
} from '../services/solax-realtime-sync-service.js';

const devicesRouter = Router();

devicesRouter.use(requireAuth);

const requireAdmin = requireRoles('admin', 'super_admin');

function hasAdminDeviceAccess(user) {
  return user?.role === 'admin' || user?.role === 'super_admin';
}

function canReadTelegramDevices(user, telegramId) {
  if (hasAdminDeviceAccess(user)) {
    return true;
  }

  return String(user?.telegramId || '').trim() === String(telegramId || '').trim();
}

devicesRouter.get(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
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
  requireAdmin,
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

devicesRouter.post(
  '/realtime/sync',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const realtimeSync = await runSolaxRealtimeSyncNow('manual-api');
    res.json({
      ok: true,
      realtimeSync,
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    const device = getDeviceByRegistrationNo(req.params.registrationNo);
    res.json({
      ok: true,
      device,
    });
  }),
);

devicesRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const device = createDevice(req.body || {});
    res.status(201).json({
      ok: true,
      device,
    });
  }),
);

devicesRouter.patch(
  '/:registrationNo',
  requireAdmin,
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
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = deleteDevice(req.params.registrationNo);
    res.json({
      ok: true,
      ...result,
    });
  }),
);

export { devicesRouter };
