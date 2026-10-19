import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireAdmin } from '../../middlewares/require-admin';
import { asyncHandler } from '../../utils/async-handler';
import { HttpError } from '../../utils/http-error';
import { supportController as c } from './support.controller';

export const supportRoutes = Router();
supportRoutes.use(authenticate);
supportRoutes.get('/', asyncHandler(c.list));
supportRoutes.post('/', asyncHandler(c.create));
supportRoutes.get('/:id', asyncHandler(c.detail));
supportRoutes.post('/:id/messages', asyncHandler(c.reply));
supportRoutes.post('/:id/close', asyncHandler(c.close));

export const adminSupportRoutes = Router();
adminSupportRoutes.use(authenticate, requireAdmin);
adminSupportRoutes.use((req, _res, next) => {
  if (req.user?.status !== 'active') {
    throw new HttpError(403, 'Acesso restrito a administradores ativos', 'admin_only');
  }
  next();
});
adminSupportRoutes.get('/', asyncHandler(c.adminList));
adminSupportRoutes.get('/:id', asyncHandler(c.adminDetail));
adminSupportRoutes.post('/:id/messages', asyncHandler(c.adminReply));
adminSupportRoutes.patch('/:id', asyncHandler(c.update));
