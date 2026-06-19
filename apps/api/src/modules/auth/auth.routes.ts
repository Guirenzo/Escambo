import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { login, register } from './auth.controller';

export const authRoutes = Router();

authRoutes.post('/register', asyncHandler(register));
authRoutes.post('/login', asyncHandler(login));
