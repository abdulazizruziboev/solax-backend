import { Router } from 'express';

import { AppError, asyncHandler } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { assertActiveUser, authenticateLocalUser, serializeUser, upsertTelegramUser } from '../services/user-service.js';
import { createAccessToken } from '../utils/jwt.js';
import { verifyTelegramInitData } from '../utils/telegram.js';

const authRouter = Router();

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new AppError(400, 'username va password yuborilishi kerak');
    }

    const user = authenticateLocalUser(username, password);
    const token = createAccessToken(user);

    res.json({
      ok: true,
      token,
      user,
    });
  }),
);

authRouter.post(
  '/telegram',
  asyncHandler(async (req, res) => {
    const { initData } = req.body || {};
    const telegramAuth = verifyTelegramInitData(initData);
    const user = assertActiveUser(upsertTelegramUser(telegramAuth.user));
    const token = createAccessToken(user);

    res.json({
      ok: true,
      token,
      user,
    });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({
      ok: true,
      user: serializeUser(req.auth.user),
    });
  }),
);

export { authRouter };
