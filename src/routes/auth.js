import { Router } from 'express';

import { AppError, asyncHandler } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rate-limit.js';
import { assertActiveUser, authenticateLocalUser, serializeUser, upsertTelegramUser } from '../services/user-service.js';
import { createAccessToken } from '../utils/jwt.js';
import { verifyTelegramInitData } from '../utils/telegram.js';

const authRouter = Router();

// Faqat username/parol bilan login qilish uchun qattiq cheklov - Telegram
// auth (/telegram) HMAC bilan tasdiqlangani uchun "parolni taxmin qilish"
// xavfi yo'q, va ko'p foydalanuvchi bir xil IP (ngrok/Netlify) orqali
// kirgani uchun shu cheklovni ular bilan bo'lishmasligi kerak edi.
authRouter.post(
  '/login',
  loginLimiter,
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
