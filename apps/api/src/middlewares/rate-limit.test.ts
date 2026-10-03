import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { apiRateLimiter, loginRateLimiter, uploadRateLimiter } from './rate-limit';

// Limites pequenos e ambiente de produção: os limitadores leem os tetos na carga do módulo, e a
// suíte roda com NODE_ENV=test, em que eles ficam desligados. O resto do env é o de verdade.
vi.mock('../config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/env')>();
  return {
    env: {
      ...original.env,
      NODE_ENV: 'production',
      LOGIN_RATE_LIMIT_WINDOW_MS: 120_000,
      LOGIN_RATE_LIMIT_MAX: 2,
      RATE_LIMIT_WINDOW_MS: 30_000,
      RATE_LIMIT_MAX: 3,
      UPLOAD_RATE_LIMIT_MAX: 1,
    },
  };
});

/** App mínimo atrás de um proxy: o IP do cliente vem do X-Forwarded-For, um por teste. */
function appWith(limiter: RequestHandler): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(limiter);
  app.post('/', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const hit = (app: Express, ip: string) => request(app).post('/').set('X-Forwarded-For', ip);

/** Limites por IP (RNF-005 / RN-002): o teto de cada limitador, a resposta do bloqueio e o desligamento nos testes. */
describe('rate limiting por IP', () => {
  beforeEach(() => {
    env.NODE_ENV = 'production';
  });

  describe('loginRateLimiter (anti brute-force, RNF-005 / RN-002)', () => {
    const app = appWith(loginRateLimiter);

    it('depois do teto de tentativas o IP recebe 429 com o corpo padronizado, e os outros IPs seguem livres', async () => {
      await hit(app, '203.0.113.10').expect(200, { ok: true });
      await hit(app, '203.0.113.10').expect(200, { ok: true });

      const blocked = await hit(app, '203.0.113.10').expect(429);
      expect(blocked.body).toEqual({
        error: 'too_many_requests',
        message: 'Muitas tentativas. Tente novamente em alguns minutos.',
      });
      // O bloqueio diz quando tentar de novo, e nunca além da janela configurada (120 s).
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(120);

      // Bloqueado continua bloqueado: insistir não libera.
      await hit(app, '203.0.113.10').expect(429);

      // O limite é por IP: quem vem de outro endereço não paga pelas tentativas do primeiro.
      await hit(app, '203.0.113.11').expect(200, { ok: true });
    });

    it('anuncia o teto e a janela configurados no cabeçalho padrão (draft-7), sem os X-RateLimit antigos', async () => {
      const res = await hit(app, '203.0.113.12').expect(200);
      // LOGIN_RATE_LIMIT_MAX tentativas a cada LOGIN_RATE_LIMIT_WINDOW_MS (120 s).
      expect(res.headers['ratelimit-policy']).toBe('2;w=120');
      expect(res.headers['ratelimit']).toMatch(/^limit=2, remaining=1, reset=\d+$/);
      expect(res.headers).not.toHaveProperty('x-ratelimit-limit');
      expect(res.headers).not.toHaveProperty('x-ratelimit-remaining');
    });
  });

  describe('apiRateLimiter (teto geral da API)', () => {
    const app = appWith(apiRateLimiter);

    it('usa o teto e a janela gerais (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS), e não os do login', async () => {
      for (let i = 0; i < 3; i++) {
        const ok = await hit(app, '203.0.113.20').expect(200, { ok: true });
        expect(ok.headers['ratelimit-policy']).toBe('3;w=30');
        // Cabeçalho combinado do draft-7, com as chamadas que ainda restam ao IP.
        expect(ok.headers['ratelimit']).toMatch(
          new RegExp(`^limit=3, remaining=${2 - i}, reset=\\d+$`),
        );
        expect(ok.headers).not.toHaveProperty('x-ratelimit-limit');
        expect(ok.headers).not.toHaveProperty('x-ratelimit-remaining');
      }
      const blocked = await hit(app, '203.0.113.20');
      expect(blocked.status).toBe(429);
      expect(blocked.headers['ratelimit']).toMatch(/^limit=3, remaining=0, reset=\d+$/);
      expect(blocked.headers).not.toHaveProperty('x-ratelimit-limit');
      // A rota não roda para quem estourou o teto.
      expect(blocked.body).not.toEqual({ ok: true });

      // Também é por IP: outro endereço começa com o teto inteiro.
      const other = await hit(app, '203.0.113.21').expect(200, { ok: true });
      expect(other.headers['ratelimit']).toMatch(/^limit=3, remaining=2, /);
    });
  });

  describe('uploadRateLimiter (anexos do chat)', () => {
    const app = appWith(uploadRateLimiter);

    it('tem teto próprio por hora e mensagem própria no bloqueio', async () => {
      const ok = await hit(app, '203.0.113.30').expect(200);
      // UPLOAD_RATE_LIMIT_MAX envios por hora (3600 s), fixa no código.
      expect(ok.headers['ratelimit-policy']).toBe('1;w=3600');
      expect(ok.headers['ratelimit']).toMatch(/^limit=1, remaining=0, reset=\d+$/);
      expect(ok.headers).not.toHaveProperty('x-ratelimit-limit');

      const blocked = await hit(app, '203.0.113.30').expect(429);
      expect(blocked.body).toEqual({
        error: 'too_many_requests',
        message: 'Muitos anexos em pouco tempo. Tente novamente mais tarde.',
      });

      // Por IP, como os outros: quem vem de outro endereço ainda envia.
      await hit(app, '203.0.113.31').expect(200, { ok: true });
    });
  });

  it('cada limitador tem a própria contagem: estourar o login não gasta o teto geral nem o dos anexos', async () => {
    const ip = '203.0.113.50';
    const login = appWith(loginRateLimiter);
    await hit(login, ip).expect(200);
    await hit(login, ip).expect(200);
    await hit(login, ip).expect(429);

    const api = await hit(appWith(apiRateLimiter), ip).expect(200);
    expect(api.headers['ratelimit']).toMatch(/^limit=3, remaining=2, /);
    const upload = await hit(appWith(uploadRateLimiter), ip).expect(200);
    expect(upload.headers['ratelimit']).toMatch(/^limit=1, remaining=0, /);
  });

  it('com NODE_ENV=test os três ficam desligados: nada é bloqueado nem contado', async () => {
    env.NODE_ENV = 'test';
    const limiters = [loginRateLimiter, apiRateLimiter, uploadRateLimiter];
    for (const limiter of limiters) {
      const app = appWith(limiter);
      for (let i = 0; i < 5; i++) {
        const res = await hit(app, '203.0.113.40').expect(200);
        expect(res.headers).not.toHaveProperty('ratelimit');
      }
    }

    // De volta à produção, o mesmo IP ainda tem o teto inteiro: as chamadas acima não contaram.
    env.NODE_ENV = 'production';
    const res = await hit(appWith(uploadRateLimiter), '203.0.113.40').expect(200);
    expect(res.headers['ratelimit']).toMatch(/^limit=1, remaining=0, /);
  });
});
