import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import {
  requireVerifiedEmail,
  requireVerifiedEmailWhen,
} from '../../middlewares/require-verified-email';
import { asyncHandler } from '../../utils/async-handler';
import {
  createService,
  deleteService,
  getService,
  listMyServices,
  listServices,
  updateService,
} from './services.controller';

export const servicesRoutes = Router();

// Do dono: antes de /:id, senão "mine" seria lido como id.
servicesRoutes.get('/mine', authenticate, asyncHandler(listMyServices));

// Públicas (descoberta)
servicesRoutes.get('/', asyncHandler(listServices));
servicesRoutes.get('/:id', asyncHandler(getService));

// Protegidas (dono). Publicar exige e-mail confirmado (RF-006): criar, e no PATCH deixar o serviço
// no ar (reativar um pausado); editar, pausar e remover, não.
servicesRoutes.post('/', authenticate, requireVerifiedEmail, asyncHandler(createService));
servicesRoutes.patch(
  '/:id',
  authenticate,
  requireVerifiedEmailWhen(
    (req) => (req.body as { isActive?: unknown } | undefined)?.isActive === true,
  ),
  asyncHandler(updateService),
);
servicesRoutes.delete('/:id', authenticate, asyncHandler(deleteService));
