import { Router } from 'express';

import { requireAuth, requireRoles } from '../middleware/auth.js';
import { AppError, asyncHandler } from '../middleware/errors.js';
import { pdfExportLimiter } from '../middleware/rate-limit.js';
import {
  areDevicesVisibleToAll,
  canUserReadDevice,
  getDeviceByRegistrationNo,
  listUserDeviceRegistrationNos,
} from '../services/device-service.js';
import { getEnergyReport } from '../services/report-service.js';
import {
  generateDailyReport,
  getDailyReport,
  getDailyReportSchedulerState,
  listDailyReports,
} from '../services/daily-report-service.js';
import {
  getDeviceEfficiency,
  getSystemEfficiencyTrend,
} from '../services/efficiency-score-service.js';
import {
  generateEnergyReportPdf,
  generateEfficiencyReportPdf,
} from '../services/pdf-export-service.js';
import { sendTelegramDocument } from '../services/telegram-bot-service.js';

const reportsRouter = Router();

reportsRouter.use(requireAuth);

const requireAdmin = requireRoles('admin', 'super_admin');

function hasAdminReportAccess(user) {
  return user?.role === 'admin' || user?.role === 'super_admin';
}

function resolveReportScope(req) {
  const user = req.auth.user;
  const registrationNo = String(req.query.registrationNo || '').trim();

  if (registrationNo) {
    const device = getDeviceByRegistrationNo(registrationNo);

    if (!canUserReadDevice(user, device)) {
      throw new AppError(403, "Bu qurilma hisobotini ko'rish huquqi yo'q");
    }

    return { registrationNos: [device.registrationNo], device };
  }

  if (hasAdminReportAccess(user) || areDevicesVisibleToAll()) {
    return { registrationNos: null, device: null };
  }

  return {
    registrationNos: listUserDeviceRegistrationNos({
      userId: user.id,
      telegramId: user.telegramId,
    }),
    device: null,
  };
}

reportsRouter.get(
  '/energy',
  asyncHandler(async (req, res) => {
    const scope = resolveReportScope(req);
    const report = getEnergyReport({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      granularity: req.query.granularity,
      registrationNos: scope.registrationNos,
    });

    res.json({
      ok: true,
      report,
      device: scope.device,
    });
  }),
);

reportsRouter.get(
  '/daily',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({
      ok: true,
      scheduler: getDailyReportSchedulerState(),
      reports: listDailyReports({ limit: req.query.limit }),
    });
  }),
);

reportsRouter.get(
  '/daily/:date',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const report = getDailyReport(req.params.date, { generateIfMissing: true });

    if (!report) {
      throw new AppError(404, 'Bu sana uchun hisobot topilmadi');
    }

    res.json({
      ok: true,
      report,
    });
  }),
);

reportsRouter.post(
  '/daily/generate',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const report = generateDailyReport(req.body?.date, {
      trigger: `manual:${req.auth.user.username || req.auth.user.id}`,
    });

    res.status(201).json({
      ok: true,
      report,
    });
  }),
);

reportsRouter.get(
  '/efficiency',
  asyncHandler(async (req, res) => {
    const scope = resolveReportScope(req);
    const report = getDeviceEfficiency({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      registrationNos: scope.registrationNos,
    });

    res.json({
      ok: true,
      report,
    });
  }),
);

reportsRouter.get(
  '/efficiency/trend',
  asyncHandler(async (req, res) => {
    const scope = resolveReportScope(req);
    const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
    const registrationNo = scope.registrationNos?.length === 1 ? scope.registrationNos[0] : null;

    const trend = getSystemEfficiencyTrend({
      days,
      registrationNo,
    });

    res.json({
      ok: true,
      trend,
    });
  }),
);

reportsRouter.get(
  '/export/energy',
  pdfExportLimiter,
  asyncHandler(async (req, res) => {
    const scope = resolveReportScope(req);
    const pdfBuffer = await generateEnergyReportPdf({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      granularity: req.query.granularity,
      registrationNos: scope.registrationNos,
      user: req.auth.user,
    });

    const filename = `solarpro-energy-${req.query.startDate || 'all'}-${req.query.endDate || 'all'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  }),
);

reportsRouter.get(
  '/export/efficiency',
  pdfExportLimiter,
  asyncHandler(async (req, res) => {
    const scope = resolveReportScope(req);
    const pdfBuffer = await generateEfficiencyReportPdf({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      registrationNos: scope.registrationNos,
      user: req.auth.user,
    });

    const filename = `solarpro-efficiency-${req.query.startDate || 'all'}-${req.query.endDate || 'all'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  }),
);

reportsRouter.post(
  '/export/:type/telegram',
  pdfExportLimiter,
  asyncHandler(async (req, res) => {
    const { type } = req.params;

    if (type !== 'energy' && type !== 'efficiency') {
      throw new AppError(400, "Noto'g'ri hisobot turi");
    }

    const user = req.auth.user;

    if (!user.telegramId) {
      throw new AppError(400, "Telegram ID topilmadi, PDF yuborib bo'lmadi");
    }

    const scope = resolveReportScope(req);
    const generatePdf = type === 'energy' ? generateEnergyReportPdf : generateEfficiencyReportPdf;
    const pdfBuffer = await generatePdf({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      granularity: type === 'energy' ? req.query.granularity : undefined,
      registrationNos: scope.registrationNos,
      user,
    });

    const filename = `solarpro-${type}-${req.query.startDate || 'all'}-${req.query.endDate || 'all'}.pdf`;

    await sendTelegramDocument(user.telegramId, pdfBuffer, filename, {
      caption: type === 'energy' ? 'Energiya hisobot' : 'Samaradorlik hisobot',
    });

    res.json({ ok: true, message: 'PDF Telegram orqali yuborildi' });
  }),
);

export { reportsRouter };
