import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { errorHandler } from './middlewares/error-handler';
import { router } from './routes';

/** Cria e configura a aplicação Express (sem subir o servidor — facilita testes). */
export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.use('/api', router);

  // 404 padronizado
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Rota não encontrada' });
  });

  app.use(errorHandler);

  return app;
}
