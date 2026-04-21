import { AppError } from './errors.js';
import { getUserById, assertActiveUser } from '../services/user-service.js';
import { verifyAccessToken } from '../utils/jwt.js';

function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token.trim();
}

export function requireAuth(req, _res, next) {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw new AppError(401, 'Bearer token yuborilishi kerak');
    }

    const payload = verifyAccessToken(token);
    const user = assertActiveUser(getUserById(Number(payload.sub)));

    req.auth = {
      token,
      user,
      payload,
    };

    next();
  } catch {
    next(new AppError(401, 'Sessiya yaroqsiz yoki muddati tugagan'));
  }
}

export function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!req.auth?.user) {
      next(new AppError(401, 'Avval login qiling'));
      return;
    }

    if (!roles.includes(req.auth.user.role)) {
      next(new AppError(403, "Bu amal uchun yetarli huquq yo'q"));
      return;
    }

    next();
  };
}
