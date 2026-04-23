import { Router } from 'express';

import { AppError, asyncHandler } from '../middleware/errors.js';
import {
  hasAnyPermission,
  hasPermission,
  requireAnyPermission,
  requireAuth,
  requirePermission,
  requireRoles,
} from '../middleware/auth.js';
import {
  createLocalUser,
  deleteUser,
  ensureUserCanCreateRole,
  getUserStatusSummary,
  listUsers,
  updateUserRole,
  updateUserStatus,
  updateUserPermissions,
} from '../services/user-service.js';

const usersRouter = Router();

usersRouter.use(requireAuth);
usersRouter.use(requireRoles('admin', 'super_admin'));

function parseUserId(value) {
  const userId = Number.parseInt(value, 10);
  if (!Number.isFinite(userId)) {
    throw new AppError(400, "Foydalanuvchi ID noto'g'ri");
  }

  return userId;
}

usersRouter.get(
  '/status',
  requireAnyPermission('users.block', 'admins.crud'),
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      status: getUserStatusSummary(),
    });
  }),
);

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { role, search } = req.query;
    const cleanRole = typeof role === 'string' ? role : undefined;

    if (cleanRole === 'super_admin' && req.auth.user.role !== 'super_admin') {
      return res.status(403).json({
        ok: false,
        message: "Super adminlar ro'yxatini ko'rish huquqi yo'q",
      });
    }

    if (cleanRole === 'admin' && !hasPermission(req.auth.user, 'admins.crud')) {
      return res.status(403).json({
        ok: false,
        message: "Adminlar ro'yxatini ko'rish huquqi yo'q",
      });
    }

    if (cleanRole === 'user' && !hasAnyPermission(req.auth.user, ['users.block', 'admins.crud'])) {
      return res.status(403).json({
        ok: false,
        message: "Userlar ro'yxatini ko'rish huquqi yo'q",
      });
    }

    if (!cleanRole && !hasPermission(req.auth.user, 'admins.crud')) {
      return res.status(403).json({
        ok: false,
        message: "Foydalanuvchilar ro'yxatini ko'rish huquqi yo'q",
      });
    }

    const payload = listUsers({
      role: cleanRole,
      search: typeof search === 'string' ? search : undefined,
    });

    res.json({
      ok: true,
      ...payload,
    });
  }),
);

usersRouter.post(
  '/',
  requirePermission('admins.crud'),
  asyncHandler(async (req, res) => {
    ensureUserCanCreateRole(req.auth.user.role, 'user');

    const { username, password, displayName } = req.body || {};
    const user = createLocalUser({
      username,
      password,
      displayName,
      role: 'user',
      createdBy: req.auth.user.id,
    });

    res.status(201).json({
      ok: true,
      user,
    });
  }),
);

usersRouter.post(
  '/admins',
  requirePermission('admins.crud'),
  asyncHandler(async (req, res) => {
    const { username, password, displayName } = req.body || {};
    const user = createLocalUser({
      username,
      password,
      displayName,
      role: 'admin',
      createdBy: req.auth.user.id,
    });

    res.status(201).json({
      ok: true,
      user,
    });
  }),
);

usersRouter.patch(
  '/:id/role',
  requirePermission('admins.crud'),
  asyncHandler(async (req, res) => {
    const targetUserId = parseUserId(req.params.id);

    const { role } = req.body || {};
    const user = updateUserRole({
      targetUserId,
      newRole: role,
      changedByUserId: req.auth.user.id,
      changedByRole: req.auth.user.role,
    });

    res.json({
      ok: true,
      user,
    });
  }),
);

usersRouter.patch(
  '/:id/status',
  requireAnyPermission('users.block', 'admins.crud'),
  asyncHandler(async (req, res) => {
    const targetUserId = parseUserId(req.params.id);

    const { status } = req.body || {};
    const user = updateUserStatus({
      targetUserId,
      newStatus: status,
      changedByUserId: req.auth.user.id,
      changedByRole: req.auth.user.role,
      canManageAdmins: hasPermission(req.auth.user, 'admins.crud'),
    });

    res.json({
      ok: true,
      user,
    });
  }),
);

usersRouter.patch(
  '/:id/permissions',
  requireRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const targetUserId = parseUserId(req.params.id);

    const { permissions } = req.body || {};
    const user = updateUserPermissions({
      targetUserId,
      permissions,
      changedByUserId: req.auth.user.id,
    });

    res.json({
      ok: true,
      user,
    });
  }),
);

usersRouter.delete(
  '/:id',
  requirePermission('admins.crud'),
  asyncHandler(async (req, res) => {
    const targetUserId = parseUserId(req.params.id);
    const result = deleteUser({
      targetUserId,
      deletedByUserId: req.auth.user.id,
      deletedByRole: req.auth.user.role,
      canManageAdmins: hasPermission(req.auth.user, 'admins.crud'),
    });

    res.json({
      ok: true,
      ...result,
    });
  }),
);

export { usersRouter };
