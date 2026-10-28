import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { loginRateLimiter } from '../../middlewares/rate-limit';
import { asyncHandler } from '../../utils/async-handler';
import { appealDropout, myDropouts } from '../dropouts/dropouts.controller';
import {
  addPortfolioItem,
  getMyCpf,
  getMyPortfolio,
  getMyProfiles,
  getPublicCompany,
  getPublicFreelancer,
  putClientProfile,
  putCompanyProfile,
  putFreelancerProfile,
  putMyCpf,
  removePortfolioItem,
  reorderPortfolio,
  updatePortfolioItem,
} from './profiles.controller';

export const profilesRoutes = Router();

// Públicas: perfil de um freelancer (com nota e nível) e de uma empresa (RF-018)
profilesRoutes.get('/freelancer/:ulid', asyncHandler(getPublicFreelancer));
profilesRoutes.get('/company/:ulid', asyncHandler(getPublicCompany));

// Protegidas (meu perfil)
profilesRoutes.get('/me', authenticate, asyncHandler(getMyProfiles));
profilesRoutes.get('/me/dropouts', authenticate, asyncHandler(myDropouts));
profilesRoutes.post('/me/dropouts/:id/appeal', authenticate, asyncHandler(appealDropout));
profilesRoutes.put('/freelancer', authenticate, asyncHandler(putFreelancerProfile));
profilesRoutes.put('/client', authenticate, asyncHandler(putClientProfile));
profilesRoutes.put('/company', authenticate, asyncHandler(putCompanyProfile));
// CPF do freelancer (RF-020): situação e validação. A validação tem o limite do login: a resposta
// diz se o CPF já está em outra conta, e testar CPF atrás de CPF não pode sair de graça.
profilesRoutes.get('/me/cpf', authenticate, asyncHandler(getMyCpf));
profilesRoutes.put('/me/cpf', authenticate, loginRateLimiter, asyncHandler(putMyCpf));

// Portfólio do freelancer (o público sai junto com GET /freelancer/:ulid)
profilesRoutes.get('/portfolio', authenticate, asyncHandler(getMyPortfolio));
profilesRoutes.post('/portfolio', authenticate, asyncHandler(addPortfolioItem));
// A ordem vem antes de /portfolio/:id, senão "order" cairia como id.
profilesRoutes.put('/portfolio/order', authenticate, asyncHandler(reorderPortfolio));
profilesRoutes.put('/portfolio/:id', authenticate, asyncHandler(updatePortfolioItem));
profilesRoutes.delete('/portfolio/:id', authenticate, asyncHandler(removePortfolioItem));
