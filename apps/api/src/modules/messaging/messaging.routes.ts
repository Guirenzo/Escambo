import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { uploadRateLimiter } from '../../middlewares/rate-limit';
import { singleFile } from '../../middlewares/upload';
import { asyncHandler } from '../../utils/async-handler';
import {
  getAttachment,
  getMessages,
  postAttachment,
  postMessage,
  postRead,
} from './messaging.controller';

export const messagingRoutes = Router();

messagingRoutes.use(authenticate);

messagingRoutes.get('/contracts/:id', asyncHandler(getMessages));
messagingRoutes.post('/contracts/:id', asyncHandler(postMessage));
// Leitura (RF-059): o web chama quando a conversa está visível, com a última mensagem exibida.
messagingRoutes.post('/contracts/:id/read', asyncHandler(postRead));
// Anexo (imagem, PDF, ZIP): multipart com o arquivo em `file` e a legenda opcional em `content`.
messagingRoutes.post(
  '/contracts/:id/attachments',
  uploadRateLimiter,
  singleFile('file'),
  asyncHandler(postAttachment),
);
messagingRoutes.get('/attachments/:id', asyncHandler(getAttachment));
