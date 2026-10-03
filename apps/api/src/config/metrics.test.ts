import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_CLOSED_STATUS,
  createMetricsServer,
  httpDuration,
  jobRuns,
  metricsMiddleware,
  registerJobMetrics,
  registry,
  routeLabel,
  startMetricsServer,
} from './metrics';

describe('routeLabel', () => {
  it('junta o prefixo do router com o padrão declarado, nunca a URL crua', () => {
    expect(routeLabel('/api/contracts', '/:id')).toBe('/api/contracts/:id');
    expect(routeLabel('', '/')).toBe('/');
    expect(routeLabel('/api/health', '/')).toBe('/api/health');
  });

  it('o que não casou com rota nenhuma vira "unmatched"', () => {
    expect(routeLabel('/api', undefined)).toBe('unmatched');
    expect(routeLabel('', /regex/)).toBe('unmatched');
  });
});

/** As séries `_count` do histograma, como { rótulos, valor }. */
async function counts(): Promise<{ labels: Record<string, string | number>; value: number }[]> {
  const { values } = await httpDuration.get();
  return values
    .filter((v) => v.metricName === 'escambo_http_request_duration_seconds_count')
    .map((v) => ({ labels: { ...v.labels }, value: v.value }));
}

describe('metricsMiddleware', () => {
  afterEach(() => httpDuration.reset());

  function app() {
    const a = express();
    a.use(metricsMiddleware);
    const r = express.Router();
    r.get('/:id', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    // O caminho de todo erro do projeto: o handler passa o erro adiante e o error-handler responde.
    r.get('/:id/quebra', (_req, _res, next) => next(new Error('x')));
    r.get('/:id/lento', () => {
      /* nunca responde */
    });
    a.use('/api/coisas', r);
    const onError: ErrorRequestHandler = (_err, _req, res, _next) => {
      res.status(500).json({ error: 'internal_error' });
    };
    a.use(onError);
    return a;
  }

  it('mede pela rota declarada, com método e status', async () => {
    const a = app();
    await request(a).get('/api/coisas/123').expect(201);
    await request(a).get('/api/coisas/456').expect(201);

    expect(await counts()).toEqual([
      { labels: { method: 'GET', route: '/api/coisas/:id', status: '201' }, value: 2 },
    ]);
  });

  it('resposta de erro guarda o prefixo do router (o Express o desfaz antes do error-handler)', async () => {
    await request(app()).get('/api/coisas/7/quebra').expect(500);

    expect(await counts()).toEqual([
      { labels: { method: 'GET', route: '/api/coisas/:id/quebra', status: '500' }, value: 1 },
    ]);
  });

  it('404 sem rota não cria uma série por URL', async () => {
    await request(app()).get('/nada/por/aqui').expect(404);
    const routes = new Set((await counts()).map((c) => c.labels.route));
    expect([...routes]).toEqual(['unmatched']);
  });

  it('requisição que o cliente abandona entra uma vez, com o status 499', async () => {
    const server = app().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await new Promise<void>((resolve) => {
        const req = httpGet(`http://127.0.0.1:${port}/api/coisas/9/lento`);
        req.on('error', () => resolve()); // o destroy do cliente vira ECONNRESET aqui
        req.on('socket', (socket) => {
          socket.on('connect', () => setTimeout(() => req.destroy(), 50));
        });
      });
      await expect.poll(counts, { timeout: 2000 }).toEqual([
        {
          labels: {
            method: 'GET',
            route: '/api/coisas/:id/lento',
            status: CLIENT_CLOSED_STATUS,
          },
          value: 1,
        },
      ]);
    } finally {
      server.close();
    }
  });
});

describe('métricas dos jobs', () => {
  it('as séries nascem em zero, com o rótulo job_name (job é o rótulo do alvo no Prometheus)', async () => {
    registerJobMetrics(['novo-job']);
    const body = await registry.metrics();
    expect(body).toContain('escambo_job_runs_total{job_name="novo-job",outcome="ok"} 0');
    expect(body).toContain('escambo_job_runs_total{job_name="novo-job",outcome="error"} 0');
    expect(body).not.toMatch(/escambo_job_runs_total\{job=/);
  });
});

describe('servidor do /metrics', () => {
  it('porta 0 não sobe nada', () => {
    expect(startMetricsServer(0)).toBeNull();
  });

  it('serve /metrics no formato do Prometheus e 404 no resto', async () => {
    jobRuns.inc({ job_name: 'teste', outcome: 'ok' });
    const server = createMetricsServer().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/plain');
      const body = await ok.text();
      expect(body).toContain('escambo_build_info');
      expect(body).toContain('escambo_job_runs_total{job_name="teste",outcome="ok"} 1');
      expect(body).toContain('escambo_process_cpu_seconds_total');

      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(
        404,
      );
    } finally {
      server.close();
    }
  });
});
