/**
 * Montagem da aplicação Express (infraestrutura HTTP): define por quais middlewares globais toda
 * requisição passa, e em que ordem, antes de chegar na rota do módulo.
 *
 * Quem chama: o server.ts (que sobe o servidor) e os testes de integração (supertest, sem abrir
 * porta). O que chama: os middlewares de config/ e de middlewares/ e o router do routes.ts.
 *
 * Middleware é uma função (req, res, next) que roda antes da rota: ela responde ou chama next()
 * para passar adiante. Ordem aqui: helmet, compression, cors, pino-http (log), métricas,
 * express.json (corpo), documentação e imagens, rate limit, manutenção, router, 404 e, por
 * último, o errorHandler, que pega o erro de qualquer etapa anterior.
 */
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
import { httpLogSerializers } from './utils/redact-url';

// Atrás do nginx e do Caddy, o IP de quem chamou vem no cabeçalho X-Forwarded-For; o TRUST_PROXY
// diz em quantos proxies confiar. Sem isso, o rate limit veria só o IP do proxy.
/** Converte a env TRUST_PROXY na forma aceita pelo Express. */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value; // número de hops ou preset ('loopback', subnet…)
}

// CORS é a regra do navegador que decide se um site de outro domínio pode ler a resposta da API.
// Origem fora da lista vira HttpError 403 'cors_origin', que o errorHandler devolve em JSON.
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
  // Tira o cabeçalho que contaria que o servidor é Express (menos pista para quem ataca).
  app.disable('x-powered-by');

  // Sem o upgrade-insecure-requests do CSP padrão: com ele, a página do Swagger aberta por http
  // fora do loopback (a demo pelo IP da máquina, uma VPS ainda sem TLS) ou no Safari pede os
  // próprios scripts por https e fica em branco. As respostas JSON não carregam sub-recursos, e a
  // produção já força https no proxy (com HSTS).
  // helmet põe os cabeçalhos de segurança (CSP, nosniff, frameguard); compression compacta as
  // respostas (gzip) para trafegar menos bytes.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  app.use(compression());
  // credentials deixa o navegador mandar credenciais (cookies) num pedido de outra origem;
  // exposedHeaders deixa o web ler o X-Account-Status (o authenticate põe nele o status da conta).
  app.use(
    cors({
      origin: corsOrigin(env.CORS_ORIGINS),
      credentials: true,
      exposedHeaders: ['X-Account-Status'],
    }),
  );

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
      // RNF-018: o IP de quem chamou (req.ip respeita o TRUST_PROXY; o remoteAddress é o do
      // nginx) e a recusa de acesso em warn, separada do tráfego normal.
      customProps: (req) => ({ ip: (req as express.Request).ip }),
      // Login com Google (RF-002): o código e o state da volta (query), o código de uso único do
      // web e os valores da ida (Location) e o estado da ida (Set-Cookie) saem censurados do log.
      serializers: httpLogSerializers,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode === 401 || res.statusCode === 403) return 'warn';
        return 'info';
      },
    }),
  );

  // Duração por rota declarada, para o Prometheus (ADR 59). O /metrics fica em outra porta.
  app.use(metricsMiddleware);

  // Lê o corpo JSON e põe em req.body. JSON malformado vira 400 e corpo acima do BODY_LIMIT
  // (1 MB por padrão) vira 413, os dois respondidos pelo errorHandler.
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

  // Daqui em diante, todo pedido em /api passa pelo limite por IP, pela manutenção e cai no router
  // (routes.ts), que entrega ao módulo certo: /api/contracts vai para o router de contratações.
  // Manutenção depois do rate limit (o limite protege até a resposta 503) e antes das rotas.
  app.use('/api', apiRateLimiter, maintenanceGate, router);

  // 404 padronizado
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Rota não encontrada' });
  });

  // Tratamento de erros sempre por último. O Express reconhece esse tipo de middleware pelos
  // quatro parâmetros (err, req, res, next) e chega nele quando alguém chama next(err).
  app.use(errorHandler);

  return app;
}
