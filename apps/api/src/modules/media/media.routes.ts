import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { uploadRateLimiter } from '../../middlewares/rate-limit';
import { singleFile } from '../../middlewares/upload';
import { asyncHandler } from '../../utils/async-handler';
import { uploadMedia } from './media.controller';
import { MEDIA_MAX_BYTES } from './media.storage';

export const mediaRoutes = Router();

// Envio autenticado (multipart `file`, até 5 MB). A leitura é pública e fica em app.ts, fora do
// rate limit geral, como um arquivo estático.
mediaRoutes.post(
  '/',
  authenticate,
  uploadRateLimiter,
  singleFile('file', MEDIA_MAX_BYTES),
  asyncHandler(uploadMedia),
);
