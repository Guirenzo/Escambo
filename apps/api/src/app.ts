import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import compression from 'compression';
import cors, { type CorsOptions } from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import { metricsMiddleware } from './config/metrics';
import {
  openapiDocument,
  SWAGGER_UI_FILES,
  swaggerHtml,
  swaggerInitJs,
  swaggerUiDistDir,
} from './config/openapi';
import { errorHandler } from './middlewares/error-handler';
import { maintenanceGate } from './middlewares/maintenance';
import { apiRateLimiter } from './middlewares/rate-limit';
import { router } from './routes';
import { serveMedia } from './modules/media/media.controller';
import { asyncHandler } from './utils/async-handler';
import { HttpError } from './utils/http-error';

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
  const allow = value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return (origin, cb) => {
    if (!origin || allow.includes(origin)) return cb(null, true);
    cb(new HttpError(403, 'Origem não permitida pelo CORS', 'cors_origin'));
  };
}

/** Cria e configura a aplicação Express (sem subir o servidor — facilita testes). */
export function createApp() {
  const app = express();

  // Atrás de proxy reverso/load balancer: IP e rate-limit corretos (X-Forwarded-For).
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  app.disable('x-powered-by');

  // Sem o upgrade-insecure-requests do CSP padrão: com ele, a página do Swagger aberta por http
  // fora do loopback (a demo pelo IP da máquina, uma VPS ainda sem TLS) ou no Safari pede os
  // próprios scripts por https e fica em branco. As respostas JSON não carregam sub-recursos, e a
  // produção já força https no proxy (com HSTS).
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
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

  // Duração por rota declarada, para o Prometheus (ADR 59). O /metrics fica em outra porta.
  app.use(metricsMiddleware);

  app.use(express.json({ limit: env.BODY_LIMIT }));

  // Documentação da API (RNF-010) — não passa pelo rate limiter.
  app.get('/api/openapi.json', (_req, res) => {
    res.json(openapiDocument);
  });
  app.get('/api/docs', (_req, res) => {
    res.type('html').send(swaggerHtml);
  });
  // O Swagger UI e a inicialização dele saem daqui, e não de CDN nem inline: o CSP da API
  // (script-src 'self') continua o mesmo para todas as rotas, a página inclusive.
  app.get('/api/docs/swagger-init.js', (_req, res) => {
    res.type('js').send(swaggerInitJs);
  });
  const swaggerDir = swaggerUiDistDir();
  if (swaggerDir) {
    for (const file of SWAGGER_UI_FILES) {
      app.get(`/api/docs/${file}`, (_req, res) => {
        res.sendFile(join(swaggerDir, file));
      });
    }
  }

  // Imagens públicas de perfil e portfólio (ADR 36): servidas como arquivo estático, fora do
  // rate limit e da manutenção. O nome é um ULID imutável, então o cache é longo.
  app.get('/api/media/:year/:month/:file', asyncHandler(serveMedia));

  // Manutenção depois do rate limit (o limite protege até a resposta 503) e antes das rotas.
  app.use('/api', apiRateLimiter, maintenanceGate, router);

  // 404 padronizado
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Rota não encontrada' });
  });

  app.use(errorHandler);

  return app;
}
