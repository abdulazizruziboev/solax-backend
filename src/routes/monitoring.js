import { Router } from 'express';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';
import { getMonitoringDashboard, getSystemAlerts } from '../services/monitoring-service.js';
import { createBackup, getBackupStatus } from '../services/backup-service.js';

const monitoringRouter = Router();

monitoringRouter.use(requireAuth);
monitoringRouter.use(requireRoles('admin', 'super_admin'));

monitoringRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const dashboard = getMonitoringDashboard();
    const alerts = getSystemAlerts();
    res.json({ ok: true, dashboard, alerts });
  }),
);

monitoringRouter.get(
  '/alerts',
  asyncHandler(async (_req, res) => {
    const alerts = getSystemAlerts();
    res.json({ ok: true, alerts });
  }),
);

monitoringRouter.get(
  '/backup',
  asyncHandler(async (_req, res) => {
    const status = getBackupStatus();
    res.json({ ok: true, backup: status });
  }),
);

monitoringRouter.post(
  '/backup',
  asyncHandler(async (_req, res) => {
    const backupPath = createBackup();
    res.json({
      ok: true,
      backup: backupPath ? { path: backupPath } : null,
      status: getBackupStatus(),
    });
  }),
);

export { monitoringRouter };
