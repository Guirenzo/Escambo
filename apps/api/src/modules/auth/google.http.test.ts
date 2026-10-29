import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./google.service', () => ({
  googleService: {
    providers: vi.fn(),
    start: vi.fn(),
    callback: vi.fn(),
    exchange: vi.fn(),
    signup: vi.fn(),
  },
}));
vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { routerApp } from '../../test-support/http';
import { authRoutes } from './auth.routes';
import { googleService } from './google.service';

/**
 * As bordas HTTP do login com Google (RF-002), com o service mockado: desligado é 404 (antes da
 * validação), o start grava o cookie da ida e redireciona, a volta sempre redireciona ao web e
 * apaga o cookie, e a troca e o cadastro validam o corpo.
 */

const service = vi.mocked(googleService);
const app = routerApp('/api/auth', authRoutes);
const saved = { ...env };

beforeEach(() => {
  vi.clearAllMocks();
  env.GOOGLE_CLIENT_ID = 'cliente-de-teste.apps.googleusercontent.com';
  env.GOOGLE_CLIENT_SECRET = 'segredo-de-teste-do-google-com-32-caracteres';
  env.APP_URL = 'https://escambo.example';
  env.NODE_ENV = 'test';
});
afterEach(() => Object.assign(env, saved));

describe('desligado', () => {
  beforeEach(() => {
    env.GOOGLE_CLIENT_ID = '';
    env.GOOGLE_CLIENT_SECRET = '';
  });

  it('as quatro rotas do Google respondem o 404 de rota desconhecida, sem chegar ao service', async () => {
    const calls = [
      request(app).get('/api/auth/google/start'),
      request(app).get('/api/auth/google/callback?code=x&state=y'),
      request(app).post('/api/auth/google/exchange').send({}),
      request(app).post('/api/auth/google/signup').send({ role: 'company' }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found', message: 'Rota não encontrada' });
    }
    expect(service.start).not.toHaveBeenCalled();
    expect(service.callback).not.toHaveBeenCalled();
    expect(service.exchange).not.toHaveBeenCalled();
    expect(service.signup).not.toHaveBeenCalled();
  });

  it('GET /providers é pública e repassa o que o service diz', async () => {
    service.providers.mockReturnValue({ google: false });
    const res = await request(app).get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ google: false });
  });
});

describe('start', () => {
  it('grava o cookie da ida (httpOnly, Lax, só no caminho do Google, 10 min) e vai ao Google', async () => {
    service.start.mockReturnValue({
      location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      cookie: 'valor-cifrado',
    });
    const res = await request(app).get('/api/auth/google/start');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^escambo_google=valor-cifrado; /);
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Path=/api/auth/google');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // Fora da produção e com a volta por https (APP_URL), Secure também.
    expect(cookie).toContain('Secure');
  });

  it('no desenvolvimento por http, sem Secure (o navegador recusaria)', async () => {
    env.APP_URL = 'http://localhost:5173';
    service.start.mockReturnValue({ location: 'https://accounts.google.com/x', cookie: 'v' });
    const res = await request(app).get('/api/auth/google/start');
    expect(String(res.headers['set-cookie'])).not.toContain('Secure');
  });
});

describe('callback', () => {
  it('repassa a query e o cookie, redireciona para onde o service disser, apaga o cookie da ida e grava o da volta', async () => {
    service.callback.mockResolvedValue({
      location: 'https://escambo.example/entrar/google#codigo=abc',
      returnCookie: 'volta-cifrada',
    });
    const res = await request(app)
      .get('/api/auth/google/callback?state=st&code=cd')
      .set('Cookie', 'outro=1; escambo_google=valor-da-ida')
      .set('User-Agent', 'navegador-de-teste');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://escambo.example/entrar/google#codigo=abc');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(service.callback).toHaveBeenCalledWith(
      { code: 'cd', state: 'st', error: undefined },
      'valor-da-ida',
      expect.objectContaining({ userAgent: 'navegador-de-teste' }),
    );
    const [cleared, back] = res.headers['set-cookie'] as unknown as string[];
    expect(cleared).toMatch(/^escambo_google=; /);
    expect(cleared).toContain('Path=/api/auth/google');
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    // O cookie da volta: o código só troca neste navegador, por 2 minutos.
    expect(back).toMatch(/^escambo_google_volta=volta-cifrada; /);
    expect(back).toContain('Max-Age=120');
    expect(back).toContain('Path=/api/auth/google');
    expect(back).toContain('HttpOnly');
    expect(back).toContain('SameSite=Lax');
  });

  it('volta recusada: só apaga o cookie da ida, sem cookie da volta', async () => {
    service.callback.mockResolvedValue({
      location: 'https://escambo.example/login?google=expirado',
      returnCookie: null,
    });
    const res = await request(app).get('/api/auth/google/callback?state=a&code=b');
    expect(res.headers.location).toBe('https://escambo.example/login?google=expirado');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^escambo_google=; /);
  });

  it('query repetida, vazia ou enorme vale como ausente; sem cookie, null', async () => {
    service.callback.mockResolvedValue({
      location: 'https://escambo.example/login?google=expirado',
      returnCookie: null,
    });
    await request(app).get(
      `/api/auth/google/callback?state=a&state=b&code=${'x'.repeat(3000)}&error=`,
    );
    expect(service.callback).toHaveBeenCalledWith(
      { code: undefined, state: undefined, error: undefined },
      null,
      expect.anything(),
    );
  });

  it('erro inesperado: volta ao login com "falhou", sem JSON nem detalhe técnico', async () => {
    service.callback.mockRejectedValue(new Error('banco fora do ar'));
    const res = await request(app).get('/api/auth/google/callback?state=a&code=b');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://escambo.example/login?google=falhou');
    expect(res.text).not.toContain('banco');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('exchange e signup', () => {
  it('exchange valida o código e devolve a resposta do service, sem cache', async () => {
    service.exchange.mockResolvedValue({ mfaRequired: true, mfaToken: 't', expiresInSeconds: 300 });
    const ok = await request(app)
      .post('/api/auth/google/exchange')
      .set('Cookie', 'escambo_google_volta=volta-cifrada')
      .send({ code: 'c'.repeat(64) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ mfaRequired: true, mfaToken: 't', expiresInSeconds: 300 });
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(service.exchange).toHaveBeenCalledWith(
      'c'.repeat(64),
      'volta-cifrada',
      expect.anything(),
    );
    // O cookie da volta vale uma troca: sai na resposta.
    expect(String(ok.headers['set-cookie'])).toMatch(/^escambo_google_volta=; /);

    for (const body of [{}, { code: 'curto' }, { code: 'x'.repeat(256) }]) {
      const bad = await request(app).post('/api/auth/google/exchange').send(body);
      expect(bad.status).toBe(422);
      expect(bad.body.details).toHaveProperty('code');
    }
    expect(service.exchange).toHaveBeenCalledTimes(1);
  });

  it('signup pede o papel (cliente ou freelancer) e o aceite; responde 201 com a sessão', async () => {
    service.signup.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', user: {} } as never);
    const body = { signupToken: 's'.repeat(64), role: 'client', legalAccepted: true };
    const ok = await request(app).post('/api/auth/google/signup').send(body);
    expect(ok.status).toBe(201);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(service.signup).toHaveBeenCalledWith(body, expect.anything());

    const noTerms = await request(app)
      .post('/api/auth/google/signup')
      .send({ ...body, legalAccepted: false });
    expect(noTerms.status).toBe(422);
    expect(noTerms.body.details.legalAccepted).toEqual([
      'É preciso aceitar os Termos de Uso e a Política de Privacidade',
    ]);
    // Empresa continua pelo cadastro com CNPJ (RF-018).
    const company = await request(app)
      .post('/api/auth/google/signup')
      .send({ ...body, role: 'company' });
    expect(company.status).toBe(422);
    expect(company.body.details.role).toEqual(['Escolha cliente ou freelancer']);
    expect(service.signup).toHaveBeenCalledTimes(1);
  });
});
