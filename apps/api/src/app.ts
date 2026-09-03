import { randomUUID } from 'node:crypto';
import compression from 'compression';
import cors, { type CorsOptions } from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import { openapiDocument, swaggerHtml } from './config/openapi';
import { errorHandler } from './middlewares/error-handler';
import { apiRateLimiter } from './middlewares/rate-limit';
import { router } from './routes';

/** Converte a env TRUST_PROXY na forma aceita pelo Express. */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value; // número de hops ou preset ('loopback', subnet…)
}

/** Origens permitidas: '*' reflete a origem da requisição; senão, lista fixa. */
function corsOrigin(value: string): CorsOptions['origin'] {
  if (value.trim() === '*') return true;
  const allow = value.split(',').map((o) => o.trim()).filter(Boolean);
  return (origin, cb) => {
    if (!origin || allow.includes(origin)) return cb(null, true);
    cb(new Error('Origem não permitida pelo CORS'));
  };
}

/** Cria e configura a aplicação Express (sem subir o servidor — facilita testes). */
export function createApp() {
  const app = express();

  // Atrás de proxy reverso/load balancer: IP e rate-limit corretos (X-Forwarded-For).
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: corsOrigin(env.CORS_ORIGINS), credentials: true }));

  // Log estruturado por requisição, com id correlacionável (echo em X-Request-Id).
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );

  app.use(express.json({ limit: env.BODY_LIMIT }));

  // Documentação da API (RNF-010) — não passa pelo rate limiter.
  app.get('/api/openapi.json', (_req, res) => {
    res.json(openapiDocument);
  });
  app.get('/api/docs', (_req, res) => {
    res.type('html').send(swaggerHtml);
  });

  app.use('/api', apiRateLimiter, router);

  // 404 padronizado
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Rota não encontrada' });
  });

  app.use(errorHandler);

  return app;
}
