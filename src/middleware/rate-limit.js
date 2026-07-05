import { rateLimit } from 'express-rate-limit';

// Umumiy API rate limit — DoS'dan himoya, real foydalanuvchi trafigiga
// halaqit bermasligi kerak (WebApp 30 soniyada bir necha so'rov yuboradi,
// va ngrok/Netlify orqali ko'p foydalanuvchi bitta IP ostida ko'rinishi
// mumkin, shuning uchun chegara yuqori qo'yilgan).
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "Juda ko'p so'rov yuborildi. 15 daqiqadan so'ng qayta urining.",
  },
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  },
});

// Login rate limit — 5 ta urinish / 15 daqiqa
const loginAttempts = new Map();

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "Juda ko'p login urinishi. 15 daqiqadan so'ng qayta urining.",
  },
  keyGenerator: (req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const username = req.body?.username || '';
    return `login:${ip}:${username}`;
  },
  skipSuccessfulRequests: true,
});

// Auth qilingan API uchun — har bir foydalanuvchi uchun alohida hisoblanadi
export const authApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "Juda ko'p so'rov. 15 daqiqadan so'ng qayta urining.",
  },
  keyGenerator: (req) => {
    return req.auth?.user?.id || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  },
});

// PDF export limit — 10 ta / soat
export const pdfExportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "Juda ko'p PDF so'rov. 1 soatdan so'ng qayta urining.",
  },
  keyGenerator: (req) => {
    return req.auth?.user?.id || req.headers['x-forwarded-for'] || 'unknown';
  },
});
