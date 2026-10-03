import { createServer, type Server } from 'node:http';
import type { RequestHandler } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import { buildInfo } from './build-info';

/**
 * Métricas no formato do Prometheus (ADR 59). O /metrics fica num servidor HTTP à parte
 * (METRICS_PORT), fora do Express, do rate limit e do Caddy: só a rede interna do compose o alcança.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'escambo_' });

new Gauge({
  name: 'escambo_build_info',
  help: 'Versão e commit no ar (valor sempre 1)',
  labelNames: ['version', 'commit'],
  registers: [registry],
}).set({ version: buildInfo.version, commit: buildInfo.commit }, 1);

export const httpDuration = new Histogram({
  name: 'escambo_http_request_duration_seconds',
  help: 'Duração das requisições HTTP, pela rota declarada (nunca a URL crua)',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * O rótulo é `job_name`, e não `job`: `job` é o rótulo que o Prometheus dá ao alvo raspado e
 * sobrescreveria o nome do job em todas as séries.
 */
export const jobRuns = new Counter({
  name: 'escambo_job_runs_total',
  help: 'Rodadas dos jobs em background, por resultado',
  labelNames: ['job_name', 'outcome'],
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'escambo_job_duration_seconds',
  help: 'Duração de cada job em background',
  labelNames: ['job_name'],
  buckets: [0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
  registers: [registry],
});

/**
 * As séries de um job nascem em zero. Sem isso, a primeira falha depois de cada subida aparece já
 * valendo 1 e o `increase()` do Prometheus, que precisa de duas amostras, não a enxerga.
 */
export function registerJobMetrics(names: readonly string[]): void {
  for (const name of names) {
    jobRuns.inc({ job_name: name, outcome: 'ok' }, 0);
    jobRuns.inc({ job_name: name, outcome: 'error' }, 0);
  }
}

/**
 * Rota para o rótulo: o padrão declarado no Express (`/api/contracts/:id`), para a série não
 * explodir com um id por URL. O que não casou com rota nenhuma vira `unmatched`.
 */
export function routeLabel(baseUrl: string, routePath: unknown): string {
  if (typeof routePath !== 'string') return 'unmatched';
  // A raiz de um router montado é o próprio prefixo: /api/health, e não /api/health/.
  return `${baseUrl}${routePath === '/' ? '' : routePath}` || '/';
}

/** Status da requisição que o cliente abandonou antes da resposta (a convenção é a do nginx). */
export const CLIENT_CLOSED_STATUS = '499';

/**
 * Mede cada requisição, uma vez: ao terminar a resposta ou, se o cliente desistir antes, no
 * fechamento da conexão (são as mais lentas, e sem elas o p95 fica cego para a API travada).
 *
 * O rótulo é guardado na hora em que a rota casa: quando o handler chama `next(err)`, o Express
 * devolve o `baseUrl` ao valor de fora antes de o erro chegar ao error-handler, e ler no fim
 * daria `/:id` no lugar de `/api/contracts/:id` em toda resposta de erro.
 */
export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const end = httpDuration.startTimer();
  let route: unknown;
  let label = 'unmatched';
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: () => route,
    set: (value: { path?: unknown } | undefined) => {
      route = value;
      label = routeLabel(req.baseUrl, value?.path);
    },
  });

  let done = false;
  const record = (status: string): void => {
    if (done) return;
    done = true;
    end({ method: req.method, route: label, status });
  };
  res.on('finish', () => record(String(res.statusCode)));
  res.on('close', () => record(CLIENT_CLOSED_STATUS));
  next();
};

/** Servidor que responde só `GET /metrics` (sem `listen`: quem chama escolhe a porta). */
export function createMetricsServer(): Server {
  return createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': registry.contentType }).end(body);
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });
}

/** Sobe o servidor do /metrics; `port` 0 não sobe nada. */
export function startMetricsServer(port: number): Server | null {
  if (!port) return null;
  return createMetricsServer().listen(port);
}
