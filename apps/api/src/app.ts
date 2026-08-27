import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './config/logger';
import { errorHandler } from './middlewares/error-handler';
import { apiRateLimiter } from './middlewares/rate-limit';
import { router } from './routes';

/** Cria e configura a aplicação Express (sem subir o servidor — facilita testes). */
export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(pinoHttp({ logger })); // log estruturado por requisição
  app.use(express.json());

  app.use('/api', apiRateLimiter, router);

  // 404 padronizado
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Rota não encontrada' });
  });

  app.use(errorHandler);

  return app;
}
