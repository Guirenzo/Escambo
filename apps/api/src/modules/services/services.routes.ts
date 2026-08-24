import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  createService,
  deleteService,
  getService,
  listServices,
  updateService,
} from './services.controller';

export const servicesRoutes = Router();

// Públicas (descoberta)
servicesRoutes.get('/', asyncHandler(listServices));
servicesRoutes.get('/:id', asyncHandler(getService));

// Protegidas (dono)
servicesRoutes.post('/', authenticate, asyncHandler(createService));
servicesRoutes.patch('/:id', authenticate, asyncHandler(updateService));
servicesRoutes.delete('/:id', authenticate, asyncHandler(deleteService));
