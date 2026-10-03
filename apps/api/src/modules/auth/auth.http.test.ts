import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { login } from './auth.controller';
import { authRoutes } from './auth.routes';

const { service, limiter } = vi.hoisted(() => ({
  service: {
    register: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    getByUlid: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
  },
  // No lugar do loginRateLimiter: deixa passar e registra por qual rota passou.
  limiter: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));
vi.mock('./auth.service', () => ({ authService: service }));
vi.mock('../../middlewares/rate-limit', () => ({ loginRateLimiter: limiter }));

const app = routerApp('/api/auth', authRoutes);

const AGENT = 'vitest-agent/1.0';
/** O supertest chama pelo loopback: `::ffff:127.0.0.1` ou `127.0.0.1`, conforme a pilha de rede. */
const LOOPBACK = expect.stringMatching(/127\.0\.0\.1$/);
const CTX = { ip: LOOPBACK, userAgent: AGENT };

const USER = { id: 7, ulid: 'ulid-7', email: 'ana@escambo.test', role: 'client' };
const TOKENS = { accessToken: 'jwt.de.acesso', refreshToken: 'refresh-opaco' };
const LINK_TOKEN = 'a'.repeat(32);

/** Rotas e controllers da autenticação: quem pode chamar, o que a validação recusa, o que chega ao service. */
describe('autenticação: borda HTTP', () => {
  beforeEach(() => {
    limiter.mockClear();
    // Zera também a resposta combinada: a recusa de um teste não vaza para o seguinte.
    for (const fn of Object.values(service)) fn.mockReset();
  });

  describe('POST /api/auth/register', () => {
    const valid = {
      email: 'ana@escambo.test',
      password: 'senha-forte-123',
      role: 'freelancer',
      timezone: 'America/Manaus',
      legalAccepted: true,
    };

    it('cria a conta sem login e devolve 201; o service recebe os dados validados e o IP e navegador de quem pediu (prova do aceite, ADR 54)', async () => {
      service.register.mockResolvedValue(USER);

      const res = await request(app)
        .post('/api/auth/register')
        .set('User-Agent', AGENT)
        .send(valid)
        .expect(201);

      expect(res.body).toEqual(USER);
      expect(service.register).toHaveBeenCalledTimes(1);
      expect(service.register).toHaveBeenCalledWith(valid, CTX);
    });

    it('sem papel informado a conta nasce como client, e campos fora do schema não chegam ao service', async () => {
      service.register.mockResolvedValue(USER);

      await request(app)
        .post('/api/auth/register')
        .set('User-Agent', AGENT)
        .send({
          email: 'ana@escambo.test',
          password: 'senha-forte-123',
          legalAccepted: true,
          status: 'active',
          emailVerified: true,
        })
        .expect(201);

      expect(service.register.mock.calls[0]![0]).toStrictEqual({
        email: 'ana@escambo.test',
        password: 'senha-forte-123',
        role: 'client',
        legalAccepted: true,
      });
    });

    it('os três papéis públicos (client, freelancer e company) são aceitos e chegam ao service como vieram', async () => {
      service.register.mockResolvedValue(USER);
      for (const role of ['client', 'freelancer', 'company']) {
        await request(app)
          .post('/api/auth/register')
          .send({ ...valid, role })
          .expect(201);
        expect(service.register.mock.lastCall![0]).toStrictEqual({ ...valid, role });
      }
      expect(service.register).toHaveBeenCalledTimes(3);
    });

    it('cada fuso do Brasil é aceito (ADR 51), e sem fuso o campo nem chega ao service', async () => {
      service.register.mockResolvedValue(USER);
      for (const timezone of [
        'America/Noronha',
        'America/Sao_Paulo',
        'America/Cuiaba',
        'America/Manaus',
        'America/Rio_Branco',
      ]) {
        await request(app)
          .post('/api/auth/register')
          .send({ ...valid, timezone })
          .expect(201);
        expect(service.register.mock.lastCall![0]).toMatchObject({ timezone });
      }

      const { timezone: _omitted, ...withoutTimezone } = valid;
      await request(app).post('/api/auth/register').send(withoutTimezone).expect(201);
      expect(service.register.mock.lastCall![0]).not.toHaveProperty('timezone');
    });

    it('ninguém se cadastra como admin pelo corpo: papel fora de client, freelancer e company é recusado', async () => {
      for (const role of ['admin', 'moderator', '']) {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ ...valid, role })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('role');
      }
      expect(service.register).not.toHaveBeenCalled();
    });

    it('sem o aceite dos Termos e da Política não há conta (RN-071, ADR 54)', async () => {
      const { legalAccepted: _omitted, ...withoutAccept } = valid;
      for (const body of [
        withoutAccept,
        { ...valid, legalAccepted: false },
        { ...valid, legalAccepted: 'true' },
      ]) {
        const res = await request(app).post('/api/auth/register').send(body).expect(422);
        expect(res.body.details.legalAccepted).toEqual([
          'É preciso aceitar os Termos de Uso e a Política de Privacidade',
        ]);
      }
      expect(service.register).not.toHaveBeenCalled();
    });

    it('e-mail inválido, senha com menos de 8 caracteres e fuso de fora do Brasil são recusados (ADR 51)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          ...valid,
          email: 'ana-sem-arroba',
          password: '1234567',
          timezone: 'Europe/Lisbon',
        })
        .expect(422);

      expect(res.body.message).toBe('Dados de entrada inválidos');
      expect(res.body.details.email).toEqual(['E-mail inválido']);
      expect(res.body.details.password).toEqual(['A senha deve ter ao menos 8 caracteres']);
      expect(res.body.details).toHaveProperty('timezone');
      expect(service.register).not.toHaveBeenCalled();
    });

    it('senha de exatamente 8 caracteres passa', async () => {
      service.register.mockResolvedValue(USER);
      await request(app)
        .post('/api/auth/register')
        .send({ ...valid, password: '12345678' })
        .expect(201);
      expect(service.register.mock.calls[0]![0]).toMatchObject({ password: '12345678' });
    });

    it('a recusa do service (e-mail já cadastrado, RN-001) vira a resposta com o código dele', async () => {
      service.register.mockRejectedValue(new HttpError(409, 'E-mail já cadastrado', 'email_taken'));
      const res = await request(app).post('/api/auth/register').send(valid).expect(409);
      expect(res.body).toEqual({ error: 'email_taken', message: 'E-mail já cadastrado' });
    });
  });

  describe('POST /api/auth/login', () => {
    const credentials = { email: 'ana@escambo.test', password: 'senha-forte-123' };

    it('devolve os tokens e o usuário no corpo (sem cookie); credenciais e contexto chegam ao service', async () => {
      service.login.mockResolvedValue({ ...TOKENS, user: USER });

      const res = await request(app)
        .post('/api/auth/login')
        .set('User-Agent', AGENT)
        .send(credentials)
        .expect(200);

      expect(res.body).toEqual({ ...TOKENS, user: USER });
      // O refresh token viaja no corpo: a API não grava cookie de sessão.
      expect(res.headers).not.toHaveProperty('set-cookie');
      expect(service.login).toHaveBeenCalledTimes(1);
      expect(service.login).toHaveBeenCalledWith(credentials, CTX);
    });

    it('requisição sem User-Agent leva userAgent null no contexto', async () => {
      service.login.mockResolvedValue({ ...TOKENS, user: USER });
      await request(app).post('/api/auth/login').send(credentials).expect(200);
      expect(service.login).toHaveBeenCalledWith(credentials, { ip: LOOPBACK, userAgent: null });
    });

    it('sem IP nem User-Agent na requisição, o contexto vai com null (e não undefined)', async () => {
      service.login.mockResolvedValue({ ...TOKENS, user: USER });
      const json = vi.fn();
      const req = { body: credentials, headers: {}, ip: undefined } as unknown as Request;

      await login(req, { json } as unknown as Response);

      expect(service.login).toHaveBeenCalledWith(credentials, { ip: null, userAgent: null });
      expect(json).toHaveBeenCalledWith({ ...TOKENS, user: USER });
    });

    it('e-mail inválido ou senha vazia são recusados na validação, sem consultar o service', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ana', password: '' })
        .expect(422);
      expect(res.body.details.email).toEqual(['E-mail inválido']);
      expect(res.body.details.password).toEqual(['Senha obrigatória']);

      const empty = await request(app).post('/api/auth/login').send({}).expect(422);
      expect(empty.body.error).toBe('validation_error');
      expect(Object.keys(empty.body.details).sort()).toEqual(['email', 'password']);
      expect(service.login).not.toHaveBeenCalled();
    });

    it('no login a senha só não pode ser vazia: o mínimo de 8 é regra do cadastro, e senha curta é caso para o service recusar', async () => {
      service.login.mockResolvedValue({ ...TOKENS, user: USER });
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'ana@escambo.test', password: 'x' })
        .expect(200);
      expect(service.login).toHaveBeenCalledWith(
        { email: 'ana@escambo.test', password: 'x' },
        expect.anything(),
      );
    });

    it('campos fora do schema (papel, id) não chegam ao service', async () => {
      service.login.mockResolvedValue({ ...TOKENS, user: USER });
      await request(app)
        .post('/api/auth/login')
        .send({ ...credentials, role: 'admin', uid: 1 })
        .expect(200);
      expect(service.login.mock.calls[0]![0]).toStrictEqual(credentials);
    });

    it('credenciais inválidas e conta suspensa saem com o status e o código do service (RN-007)', async () => {
      service.login.mockRejectedValueOnce(
        new HttpError(401, 'Credenciais inválidas', 'invalid_credentials'),
      );
      const wrong = await request(app).post('/api/auth/login').send(credentials).expect(401);
      expect(wrong.body).toEqual({
        error: 'invalid_credentials',
        message: 'Credenciais inválidas',
      });

      service.login.mockRejectedValueOnce(
        new HttpError(403, 'Conta suspensa. Fale com o suporte.', 'account_suspended'),
      );
      const suspended = await request(app).post('/api/auth/login').send(credentials).expect(403);
      expect(suspended.body.error).toBe('account_suspended');
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('troca o refresh token do corpo por um novo par, sem exigir o access token (que pode ter vencido)', async () => {
      service.refresh.mockResolvedValue(TOKENS);

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('User-Agent', AGENT)
        .send({ refreshToken: 'refresh-antigo' })
        .expect(200);

      expect(res.body).toEqual(TOKENS);
      expect(res.headers).not.toHaveProperty('set-cookie');
      expect(service.refresh).toHaveBeenCalledTimes(1);
      expect(service.refresh).toHaveBeenCalledWith('refresh-antigo', CTX);
    });

    it('sem refresh token (ou vazio) é erro de validação', async () => {
      const missing = await request(app).post('/api/auth/refresh').send({}).expect(422);
      expect(missing.body.details).toHaveProperty('refreshToken');
      const empty = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: '' })
        .expect(422);
      expect(empty.body.details.refreshToken).toEqual(['Refresh token obrigatório']);
      // Só texto vale como token: número ou objeto não são convertidos.
      for (const refreshToken of [123456, { token: 'x' }, null]) {
        const wrongType = await request(app)
          .post('/api/auth/refresh')
          .send({ refreshToken })
          .expect(422);
        expect(wrongType.body.error).toBe('validation_error');
        expect(wrongType.body.details).toHaveProperty('refreshToken');
      }
      expect(service.refresh).not.toHaveBeenCalled();
    });

    it('refresh token inválido ou expirado sai como 401 invalid_refresh', async () => {
      service.refresh.mockRejectedValue(
        new HttpError(401, 'Refresh token inválido ou expirado', 'invalid_refresh'),
      );
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'vencido' })
        .expect(401);
      expect(res.body.error).toBe('invalid_refresh');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revoga a sessão do refresh token enviado e responde 204 sem corpo, sem exigir o access token', async () => {
      service.logout.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/auth/logout')
        .send({ refreshToken: 'meu-refresh' })
        .expect(204);

      expect(res.text).toBe('');
      expect(res.headers).not.toHaveProperty('set-cookie');
      expect(service.logout).toHaveBeenCalledTimes(1);
      expect(service.logout).toHaveBeenCalledWith('meu-refresh');
    });

    it('sem refresh token não há o que revogar: erro de validação', async () => {
      const res = await request(app).post('/api/auth/logout').send({}).expect(422);
      expect(res.body.details).toHaveProperty('refreshToken');
      expect(service.logout).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/auth/logout-all', () => {
    it('exige login com token válido', async () => {
      const semToken = await request(app).post('/api/auth/logout-all').expect(401);
      expect(semToken.body.error).toBe('missing_token');
      const tokenRuim = await request(app)
        .post('/api/auth/logout-all')
        .set({ Authorization: 'Bearer nao-e-um-jwt' })
        .expect(401);
      expect(tokenRuim.body.error).toBe('invalid_token');
      expect(service.logoutAll).not.toHaveBeenCalled();
    });

    it('encerra as sessões do usuário do token (RN-008), e não de quem o corpo disser, e devolve quantas foram', async () => {
      service.logoutAll.mockResolvedValue(3);

      const res = await request(app)
        .post('/api/auth/logout-all')
        .set(bearer(7))
        .send({ sub: 'ulid-999', ulid: 'ulid-999' })
        .expect(200);

      expect(res.body).toEqual({ revoked: 3 });
      expect(service.logoutAll).toHaveBeenCalledTimes(1);
      expect(service.logoutAll).toHaveBeenCalledWith('ulid-7');
    });
  });

  describe('GET /api/auth/me', () => {
    it('exige login com token válido', async () => {
      const res = await request(app).get('/api/auth/me').expect(401);
      expect(res.body.error).toBe('missing_token');
      const tokenRuim = await request(app)
        .get('/api/auth/me')
        .set({ Authorization: 'Bearer nao-e-um-jwt' })
        .expect(401);
      expect(tokenRuim.body.error).toBe('invalid_token');
      // O refresh token não serve de credencial: só o access token (JWT) abre a rota.
      await request(app)
        .get('/api/auth/me')
        .set({ Authorization: 'Bearer refresh-opaco' })
        .expect(401);
      expect(service.getByUlid).not.toHaveBeenCalled();
    });

    it('devolve os dados do usuário do token', async () => {
      service.getByUlid.mockResolvedValue(USER);
      const res = await request(app).get('/api/auth/me').set(bearer(7)).expect(200);
      expect(res.body).toEqual(USER);
      expect(service.getByUlid).toHaveBeenCalledWith('ulid-7');
    });

    it('conta que não existe mais sai como 404 user_not_found', async () => {
      service.getByUlid.mockRejectedValue(
        new HttpError(404, 'Usuário não encontrado', 'user_not_found'),
      );
      const res = await request(app).get('/api/auth/me').set(bearer(7)).expect(404);
      expect(res.body).toEqual({ error: 'user_not_found', message: 'Usuário não encontrado' });
    });
  });

  describe('POST /api/auth/verify-email', () => {
    it('confirma pelo token do link, sem login, e devolve o usuário', async () => {
      service.verifyEmail.mockResolvedValue({ ...USER, emailVerified: true });

      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ token: LINK_TOKEN })
        .expect(200);

      expect(res.body).toEqual({ ...USER, emailVerified: true });
      expect(service.verifyEmail).toHaveBeenCalledTimes(1);
      expect(service.verifyEmail).toHaveBeenCalledWith(LINK_TOKEN);
    });

    it('token ausente, com menos de 16 ou com mais de 255 caracteres é recusado na validação', async () => {
      for (const body of [{}, { token: 'a'.repeat(15) }, { token: 'a'.repeat(256) }]) {
        const res = await request(app).post('/api/auth/verify-email').send(body).expect(422);
        expect(res.body.details).toHaveProperty('token');
      }
      expect(service.verifyEmail).not.toHaveBeenCalled();

      // Os limites em si (16 e 255) passam.
      service.verifyEmail.mockResolvedValue(USER);
      for (const token of ['a'.repeat(16), 'a'.repeat(255)]) {
        await request(app).post('/api/auth/verify-email').send({ token }).expect(200);
        expect(service.verifyEmail).toHaveBeenLastCalledWith(token);
      }
    });

    it('link inválido ou vencido sai como 400 invalid_token', async () => {
      service.verifyEmail.mockRejectedValue(
        new HttpError(400, 'Link inválido ou vencido', 'invalid_token'),
      );
      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ token: LINK_TOKEN })
        .expect(400);
      expect(res.body).toEqual({ error: 'invalid_token', message: 'Link inválido ou vencido' });
    });
  });

  describe('POST /api/auth/resend-verification', () => {
    it('exige login com token válido', async () => {
      const res = await request(app).post('/api/auth/resend-verification').expect(401);
      expect(res.body.error).toBe('missing_token');
      const tokenRuim = await request(app)
        .post('/api/auth/resend-verification')
        .set({ Authorization: 'Bearer nao-e-um-jwt' })
        .expect(401);
      expect(tokenRuim.body.error).toBe('invalid_token');
      expect(service.resendVerification).not.toHaveBeenCalled();
    });

    it('o link vai para a conta do token, e não para a que o corpo indicar', async () => {
      service.resendVerification.mockResolvedValue(undefined);
      await request(app)
        .post('/api/auth/resend-verification')
        .set(bearer(7))
        .send({ userId: 999, uid: 999, email: 'outro@escambo.test' })
        .expect(202);
      expect(service.resendVerification).toHaveBeenCalledTimes(1);
      expect(service.resendVerification).toHaveBeenCalledWith(7);
    });

    it('reenvia o link para o usuário do token e responde 202', async () => {
      service.resendVerification.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/api/auth/resend-verification')
        .set(bearer(7))
        .expect(202);
      expect(res.body).toEqual({ sent: true });
      expect(service.resendVerification).toHaveBeenCalledTimes(1);
      expect(service.resendVerification).toHaveBeenCalledWith(7);
    });

    it('e-mail já confirmado sai como 409 already_verified, e não como "enviado"', async () => {
      service.resendVerification.mockRejectedValue(
        new HttpError(409, 'Este e-mail já foi confirmado', 'already_verified'),
      );
      const res = await request(app)
        .post('/api/auth/resend-verification')
        .set(bearer(7))
        .expect(409);
      expect(res.body.error).toBe('already_verified');
    });
  });

  describe('POST /api/auth/forgot-password', () => {
    it('responde 202 com o mesmo corpo, exista ou não a conta (o service não devolve nada)', async () => {
      service.forgotPassword.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'ana@escambo.test' })
        .expect(202);
      expect(res.body).toEqual({ sent: true });
      expect(service.forgotPassword).toHaveBeenCalledTimes(1);
      expect(service.forgotPassword).toHaveBeenCalledWith('ana@escambo.test');
    });

    it('e-mail inválido é erro de validação', async () => {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'ana' })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details.email).toEqual(['E-mail inválido']);

      const missing = await request(app).post('/api/auth/forgot-password').send({}).expect(422);
      expect(missing.body.details).toHaveProperty('email');
      expect(service.forgotPassword).not.toHaveBeenCalled();
    });

    it('nada do que o service devolver vai para a resposta: o corpo não revela se a conta existe', async () => {
      service.forgotPassword.mockResolvedValue({ found: false, userId: null });
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'ninguem@escambo.test' })
        .expect(202);
      expect(res.body).toStrictEqual({ sent: true });
    });
  });

  describe('POST /api/auth/reset-password', () => {
    it('define a nova senha pelo token do link, sem login, e responde 204 sem corpo', async () => {
      service.resetPassword.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: LINK_TOKEN, password: 'nova-senha-123' })
        .expect(204);

      expect(res.text).toBe('');
      expect(service.resetPassword).toHaveBeenCalledTimes(1);
      expect(service.resetPassword).toHaveBeenCalledWith(LINK_TOKEN, 'nova-senha-123');
    });

    it('a nova senha segue a regra do cadastro (mínimo de 8) e o token a do link (16 a 255)', async () => {
      const shortPassword = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: LINK_TOKEN, password: '1234567' })
        .expect(422);
      expect(shortPassword.body.details.password).toEqual([
        'A senha deve ter ao menos 8 caracteres',
      ]);

      for (const token of ['curto', 'a'.repeat(15), 'a'.repeat(256)]) {
        const res = await request(app)
          .post('/api/auth/reset-password')
          .send({ token, password: 'nova-senha-123' })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('token');
      }

      const missing = await request(app).post('/api/auth/reset-password').send({}).expect(422);
      expect(Object.keys(missing.body.details).sort()).toEqual(['password', 'token']);
      expect(service.resetPassword).not.toHaveBeenCalled();
    });

    it('os limites em si passam: senha de exatamente 8 caracteres e token de 16 e de 255', async () => {
      service.resetPassword.mockResolvedValue(undefined);
      for (const token of ['a'.repeat(16), 'a'.repeat(255)]) {
        await request(app)
          .post('/api/auth/reset-password')
          .send({ token, password: '12345678' })
          .expect(204);
        expect(service.resetPassword).toHaveBeenLastCalledWith(token, '12345678');
      }
      expect(service.resetPassword).toHaveBeenCalledTimes(2);
    });

    it('link inválido ou vencido sai como 400 invalid_token', async () => {
      service.resetPassword.mockRejectedValue(
        new HttpError(400, 'Link inválido ou vencido', 'invalid_token'),
      );
      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: LINK_TOKEN, password: 'nova-senha-123' })
        .expect(400);
      expect(res.body.error).toBe('invalid_token');
    });
  });

  describe('conta suspensa ou banida pela moderação (RN-007)', () => {
    afterEach(() => blocklist.delete(7));

    it('as rotas com login negam na hora com 403 account_blocked, mesmo com token válido, e nada chega ao service', async () => {
      blocklist.add(7);

      for (const call of [
        request(app).post('/api/auth/logout-all'),
        request(app).get('/api/auth/me'),
        request(app).post('/api/auth/resend-verification'),
      ]) {
        const res = await call.set(bearer(7)).expect(403);
        expect(res.body).toEqual({
          error: 'account_blocked',
          message: 'Conta suspensa ou banida. Fale com o suporte.',
        });
      }
      expect(service.logoutAll).not.toHaveBeenCalled();
      expect(service.getByUlid).not.toHaveBeenCalled();
      expect(service.resendVerification).not.toHaveBeenCalled();
      // No reenvio a conta é barrada antes do limitador: a tentativa nem conta.
      expect(limiter).not.toHaveBeenCalled();

      // O bloqueio é da conta: outro usuário segue usando as mesmas rotas.
      service.getByUlid.mockResolvedValue(USER);
      await request(app).get('/api/auth/me').set(bearer(8)).expect(200);
      expect(service.getByUlid).toHaveBeenCalledTimes(1);
      expect(service.getByUlid).toHaveBeenCalledWith('ulid-8');
    });
  });

  describe('falha inesperada do service (RNF-039)', () => {
    const boom = (): Error => new Error('ER_CON_COUNT_ERROR: detalhe interno do banco');

    it.each([
      [
        '/register',
        'register',
        { email: 'ana@escambo.test', password: 'senha-forte-123', legalAccepted: true },
      ],
      ['/login', 'login', { email: 'ana@escambo.test', password: 'senha-forte-123' }],
      ['/refresh', 'refresh', { refreshToken: 'r' }],
      ['/logout', 'logout', { refreshToken: 'r' }],
      ['/logout-all', 'logoutAll', {}],
      ['/verify-email', 'verifyEmail', { token: LINK_TOKEN }],
      ['/resend-verification', 'resendVerification', {}],
      ['/forgot-password', 'forgotPassword', { email: 'ana@escambo.test' }],
      ['/reset-password', 'resetPassword', { token: LINK_TOKEN, password: 'nova-senha-123' }],
    ] as const)(
      'POST %s responde 500 internal_error em JSON, sem vazar a mensagem do erro',
      async (path, method, body) => {
        service[method].mockRejectedValue(boom());

        const res = await request(app).post(`/api/auth${path}`).set(bearer(7)).send(body);

        // A promessa rejeitada chega ao error-handler (a requisição não fica pendurada).
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
        expect(service[method]).toHaveBeenCalledTimes(1);
      },
    );

    it('GET /me responde 500 internal_error em JSON, sem vazar a mensagem do erro', async () => {
      service.getByUlid.mockRejectedValue(boom());
      const res = await request(app).get('/api/auth/me').set(bearer(7)).expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  describe('método e caminho', () => {
    it('as rotas de escrita só respondem a POST, e /me só a GET', async () => {
      for (const path of [
        '/login',
        '/register',
        '/refresh',
        '/logout',
        '/logout-all',
        '/verify-email',
        '/resend-verification',
        '/forgot-password',
        '/reset-password',
      ]) {
        const res = await request(app).get(`/api/auth${path}`).set(bearer(7)).expect(404);
        expect(res.body.error).toBe('not_found');
      }
      await request(app).post('/api/auth/me').set(bearer(7)).expect(404);
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('anti brute-force (RNF-005 / RN-002)', () => {
    it.each([
      [
        '/register',
        { email: 'ana@escambo.test', password: 'senha-forte-123', legalAccepted: true },
      ],
      ['/login', { email: 'ana@escambo.test', password: 'senha-forte-123' }],
      ['/verify-email', { token: LINK_TOKEN }],
      ['/resend-verification', {}],
      ['/forgot-password', { email: 'ana@escambo.test' }],
      ['/reset-password', { token: LINK_TOKEN, password: 'nova-senha-123' }],
    ])('POST %s passa pelo limitador de tentativas', async (path, body) => {
      const res = await request(app).post(`/api/auth${path}`).set(bearer(7)).send(body);
      // A requisição é válida e foi atendida: o limitador estava no caminho dela.
      expect(res.status).toBeLessThan(300);
      expect(limiter).toHaveBeenCalledTimes(1);
      expect(limiter.mock.calls[0]![0].path).toBe(path);
    });

    it('renovar a sessão, sair e consultar o próprio usuário não gastam tentativas', async () => {
      service.refresh.mockResolvedValue(TOKENS);
      service.logoutAll.mockResolvedValue(0);
      service.getByUlid.mockResolvedValue(USER);

      await request(app).post('/api/auth/refresh').send({ refreshToken: 'r' }).expect(200);
      await request(app).post('/api/auth/logout').send({ refreshToken: 'r' }).expect(204);
      await request(app).post('/api/auth/logout-all').set(bearer(7)).expect(200);
      await request(app).get('/api/auth/me').set(bearer(7)).expect(200);

      expect(limiter).not.toHaveBeenCalled();
    });

    it('quando o limitador barra, a requisição não chega à validação nem ao service', async () => {
      limiter.mockImplementation((_req, res) => {
        res.status(429).json({ error: 'too_many_requests' });
      });
      try {
        for (const path of ['/register', '/login', '/verify-email', '/forgot-password']) {
          // Corpo vazio: se a validação rodasse, a resposta seria 422.
          const res = await request(app).post(`/api/auth${path}`).send({}).expect(429);
          expect(res.body).toEqual({ error: 'too_many_requests' });
        }
        await request(app)
          .post('/api/auth/reset-password')
          .send({ token: LINK_TOKEN, password: 'nova-senha-123' })
          .expect(429);
        await request(app).post('/api/auth/resend-verification').set(bearer(7)).expect(429);
      } finally {
        limiter.mockImplementation((_req, _res, next) => next());
      }

      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it('no reenvio da confirmação o login é conferido antes: sem token é 401 e a tentativa não conta', async () => {
      await request(app).post('/api/auth/resend-verification').expect(401);
      expect(limiter).not.toHaveBeenCalled();
    });
  });
});
