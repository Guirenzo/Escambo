import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  getMyProfiles,
  getPublicFreelancer,
  putClientProfile,
  putFreelancerProfile,
} from './profiles.controller';

export const profilesRoutes = Router();

// Pública: perfil de um freelancer (com nota e nível)
profilesRoutes.get('/freelancer/:ulid', asyncHandler(getPublicFreelancer));

// Protegidas (meu perfil)
profilesRoutes.get('/me', authenticate, asyncHandler(getMyProfiles));
profilesRoutes.put('/freelancer', authenticate, asyncHandler(putFreelancerProfile));
profilesRoutes.put('/client', authenticate, asyncHandler(putClientProfile));
