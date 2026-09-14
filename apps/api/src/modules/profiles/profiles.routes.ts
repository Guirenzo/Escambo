import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  addPortfolioItem,
  getMyPortfolio,
  getMyProfiles,
  getPublicFreelancer,
  putClientProfile,
  putFreelancerProfile,
  removePortfolioItem,
  updatePortfolioItem,
} from './profiles.controller';

export const profilesRoutes = Router();

// Pública: perfil de um freelancer (com nota e nível)
profilesRoutes.get('/freelancer/:ulid', asyncHandler(getPublicFreelancer));

// Protegidas (meu perfil)
profilesRoutes.get('/me', authenticate, asyncHandler(getMyProfiles));
profilesRoutes.put('/freelancer', authenticate, asyncHandler(putFreelancerProfile));
profilesRoutes.put('/client', authenticate, asyncHandler(putClientProfile));

// Portfólio do freelancer (o público sai junto com GET /freelancer/:ulid)
profilesRoutes.get('/portfolio', authenticate, asyncHandler(getMyPortfolio));
profilesRoutes.post('/portfolio', authenticate, asyncHandler(addPortfolioItem));
profilesRoutes.put('/portfolio/:id', authenticate, asyncHandler(updatePortfolioItem));
profilesRoutes.delete('/portfolio/:id', authenticate, asyncHandler(removePortfolioItem));
