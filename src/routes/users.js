import { Router } from 'express';

import { AppError, asyncHandler } from '../middleware/errors.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import {
  createLocalUser,
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

usersRouter.get(
  '/status',
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
    const payload = listUsers({
      role: typeof role === 'string' ? role : undefined,
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
  requireRoles('super_admin'),
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
  requireRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const targetUserId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetUserId)) {
      throw new AppError(400, "Foydalanuvchi ID noto'g'ri");
    }

    const { role } = req.body || {};
    const user = updateUserRole({
      targetUserId,
      newRole: role,
      changedByUserId: req.auth.user.id,
    });

    res.json({
      ok: true,
      user,
    });
  }),
);

usersRouter.patch(
  '/:id/status',
  requireRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const targetUserId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetUserId)) {
      throw new AppError(400, "Foydalanuvchi ID noto'g'ri");
    }

    const { status } = req.body || {};
    const user = updateUserStatus({
      targetUserId,
      newStatus: status,
      changedByUserId: req.auth.user.id,
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
    const targetUserId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetUserId)) {
      throw new AppError(400, "Foydalanuvchi ID noto'g'ri");
    }

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

export { usersRouter };
