import cors from 'cors';
import express from 'express';

import { config } from './config.js';
import { getDb } from './db.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { devicesRouter } from './routes/devices.js';
import { usersRouter } from './routes/users.js';
import { getHealthSnapshot } from './services/user-service.js';
import { getDeviceSyncState } from './services/device-sync-service.js';
import { getSolaxRealtimeSyncState } from './services/solax-realtime-sync-service.js';
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

export function createApp() {
  getDb();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      message: 'Solax backend ishlayapti',
      docs: '/docs',
      openapi: '/openapi.json',
    });
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });

  app.use('/docs', swaggerUiHandler, swaggerUiSetup);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'solax-backend',
      telegramEnabled: Boolean(config.telegramBotToken),
      generatedAt: new Date().toISOString(),
      snapshot: getHealthSnapshot(),
      deviceSync: getDeviceSyncState(),
      solaxRealtimeSync: getSolaxRealtimeSyncState(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/users', usersRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
