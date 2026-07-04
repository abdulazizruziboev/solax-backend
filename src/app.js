import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { config } from './config.js';
import { getDb } from './db.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { apiLimiter, loginLimiter, authApiLimiter } from './middleware/rate-limit.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { devicesRouter } from './routes/devices.js';
import { reportsRouter } from './routes/reports.js';
import { usersRouter } from './routes/users.js';
import { monitoringRouter } from './routes/monitoring.js';
import { getHealthSnapshot } from './services/user-service.js';
import { getDailyReportSchedulerState } from './services/daily-report-service.js';
import { getDeviceSyncState } from './services/device-sync-service.js';
import { getSolaxRealtimeSyncState } from './services/solax-realtime-sync-service.js';
import { createSSEClient, getConnectedClients } from './services/sse-service.js';
import { requireAuth } from './middleware/auth.js';
import { verifyAccessToken } from './utils/jwt.js';
import { getUserById, assertActiveUser } from './services/user-service.js';
import { openApiSpec, swaggerUiHandler, swaggerUiSetup } from './swagger.js';

function buildCorsOptions() {
  if (config.corsOrigins.length === 1 && config.corsOrigins[0] === '*') {
    return { origin: true };
  }

  return {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS ruxsat bermadi: ${origin}`));
    },
  };
}

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}

function clearHttp3AltSvc(_req, res, next) {
  res.set('Alt-Svc', 'clear');
  next();
}

export function createApp() {
  getDb();

  const app = express();
  app.disable('x-powered-by');
  app.use(clearHttp3AltSvc);
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/', apiLimiter);

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      message: 'Solax backend ishlayapti',
      docs: '/docs',
      openapi: '/openapi.json',
    });
  });

  app.get('/openapi.json', noStore, (_req, res) => {
    res.json(openApiSpec);
  });

  app.use('/docs', noStore, swaggerUiHandler, swaggerUiSetup);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'solax-backend',
      telegramEnabled: config.telegramBotEnabled && Boolean(config.telegramBotToken),
      generatedAt: new Date().toISOString(),
      snapshot: getHealthSnapshot(),
      deviceSync: getDeviceSyncState(),
      solaxRealtimeSync: getSolaxRealtimeSyncState(),
      dailyReport: getDailyReportSchedulerState(),
      sseClients: getConnectedClients(),
    });
  });

  // SSE — real-time event stream (token query param orqali)
  app.get('/api/events', (req, res) => {
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ ok: false, message: 'Token kerak' });
    }
    try {
      const payload = verifyAccessToken(token);
      const user = assertActiveUser(getUserById(Number(payload.sub)));
      createSSEClient(req, res, user.id);
    } catch {
      res.status(401).json({ ok: false, message: 'Token yaroqsiz' });
    }
  });

  app.use('/api/auth', loginLimiter, authRouter);
  app.use('/api/admin', authApiLimiter, adminRouter);
  app.use('/api/devices', authApiLimiter, devicesRouter);
  app.use('/api/reports', authApiLimiter, reportsRouter);
  app.use('/api/users', authApiLimiter, usersRouter);
  app.use('/api/monitoring', authApiLimiter, monitoringRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
