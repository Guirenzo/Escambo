import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routerApp } from '../../test-support/http';
import { clientErrorsRoutes } from './client-errors.routes';

const { warn, inc, capture } = vi.hoisted(() => ({
  warn: vi.fn(),
  inc: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('../../config/logger', () => ({ logger: { warn, error: vi.fn(), info: vi.fn() } }));
vi.mock('../../config/metrics', () => ({ clientErrors: { inc } }));
vi.mock('../../config/sentry', () => ({ captureClientError: capture, captureError: vi.fn() }));

const app = routerApp('/api/client-errors', clientErrorsRoutes);

/**
 * Relato de erro do navegador (RNF-040): o app manda, a API registra em warn, conta na métrica e
 * repassa ao Sentry. Sem login, corta o que é grande e nunca guarda a query string do caminho.
 */
describe('POST /api/client-errors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registra, conta e repassa o erro de render, e responde 204 sem corpo', async () => {
    const res = await request(app)
      .post('/api/client-errors')
      .send({
        kind: 'render',
        message: "Cannot read properties of undefined (reading 'title')",
        stack: 'TypeError: ...\n    at ServiceCard (index-abc.js:1:2)',
        componentStack: '\n    at ServiceCard\n    at ServicosView',
        path: '/servicos',
      })
      .expect(204);
    expect(res.text).toBe('');
    const report = {
      kind: 'render',
      message: "Cannot read properties of undefined (reading 'title')",
      stack: 'TypeError: ...\n    at ServiceCard (index-abc.js:1:2)',
      componentStack: '\n    at ServiceCard\n    at ServicosView',
      path: '/servicos',
    };
    expect(warn).toHaveBeenCalledWith(
      { clientError: report, ip: expect.any(String) },
      'erro no app (navegador)',
    );
    expect(inc).toHaveBeenCalledWith({ kind: 'render' });
    expect(capture).toHaveBeenCalledWith(report);
  });

  it('o caminho chega sem query string nem âncora (o token de /redefinir-senha não fica)', async () => {
    await request(app)
      .post('/api/client-errors')
      .send({ kind: 'error', message: 'x', path: '/redefinir-senha?token=abc123#topo' })
      .expect(204);
    expect(capture.mock.calls[0]![0].path).toBe('/redefinir-senha');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('abc123');
  });

  it('mensagem, pilha e caminho compridos são cortados, e não recusados', async () => {
    await request(app)
      .post('/api/client-errors')
      .send({
        kind: 'rejection',
        message: 'm'.repeat(900),
        stack: 's'.repeat(9000),
        componentStack: 'c'.repeat(9000),
        path: '/' + 'p'.repeat(800),
      })
      .expect(204);
    const sent = capture.mock.calls[0]![0];
    expect(sent.message).toHaveLength(500);
    expect(sent.stack).toHaveLength(4000);
    expect(sent.componentStack).toHaveLength(4000);
    expect(sent.path).toHaveLength(300);
  });

  it.each([
    ['tipo desconhecido', { kind: 'outro', message: 'x', path: '/' }],
    ['sem mensagem', { kind: 'error', message: '', path: '/' }],
    ['sem caminho', { kind: 'error', message: 'x' }],
    ['campo a mais', { kind: 'error', message: 'x', path: '/', userId: 7 }],
  ])('%s: 422 e nada registrado', async (_caso, body) => {
    const res = await request(app).post('/api/client-errors').send(body).expect(422);
    expect(res.body.error).toBe('validation_error');
    expect(warn).not.toHaveBeenCalled();
    expect(inc).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
