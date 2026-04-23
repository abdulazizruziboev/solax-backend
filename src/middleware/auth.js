import { AppError } from './errors.js';
import { getUserById, assertActiveUser } from '../services/user-service.js';
import { LEGACY_PERMISSION_ALIASES, USER_PERMISSIONS } from '../constants.js';
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

function getExpandedPermissions(user) {
  const permissions = new Set();

  if (!Array.isArray(user?.permissions)) {
    return permissions;
  }

  for (const permission of user.permissions) {
    const cleanPermission = String(permission || '').trim();
    const aliasPermissions = LEGACY_PERMISSION_ALIASES[cleanPermission];

    if (aliasPermissions) {
      for (const aliasPermission of aliasPermissions) {
        permissions.add(aliasPermission);
      }
      continue;
    }

    if (USER_PERMISSIONS.includes(cleanPermission)) {
      permissions.add(cleanPermission);
    }
  }

  return permissions;
}

export function hasPermission(user, permission) {
  if (user?.role === 'super_admin') {
    return true;
  }

  if (user?.role !== 'admin') {
    return false;
  }

  return getExpandedPermissions(user).has(permission);
}

export function hasAnyPermission(user, permissions) {
  return permissions.some((permission) => hasPermission(user, permission));
}

export function requireAnyPermission(...permissions) {
  return (req, _res, next) => {
    if (!req.auth?.user) {
      next(new AppError(401, 'Avval login qiling'));
      return;
    }

    if (!hasAnyPermission(req.auth.user, permissions)) {
      next(new AppError(403, "Bu amal uchun yetarli huquq yo'q"));
      return;
    }

    next();
  };
}

export function requirePermission(permission) {
  return requireAnyPermission(permission);
}
