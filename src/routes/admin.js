import { Router } from 'express';

import { requireAuth, requireRoles } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';
import { getAdminStatusSummary } from '../services/user-service.js';

const adminRouter = Router();

adminRouter.use(requireAuth);
adminRouter.use(requireRoles('admin', 'super_admin'));

adminRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      status: getAdminStatusSummary(),
    });
  }),
);

export { adminRouter };
