import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// O login com Google ligado ANTES de o app carregar o config/env, como na produção. Os valores são
// de teste; o Google de verdade nunca é chamado: o token endpoint é o `fetch` falso daqui.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'cliente-de-teste.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'segredo-de-teste-do-google-com-32-caracteres';
});

import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { setGoogleFetchForTests } from '../../src/modules/auth/google-oauth';
import { CURRENT_LEGAL_VERSION } from '../../src/modules/lgpd/legal-versions';
import { buildExport } from '../../src/modules/lgpd/lgpd.export';
import { verifyMfaToken } from '../../src/modules/auth/mfa-token';
import { verifyEmailOf } from './mail.helpers';

/**
 * Login com Google (RF-002) contra o MySQL real, sem rede: o start grava o cookie da ida, a volta
 * confere o state (uma vez só), troca o código no "Google" daqui (que confere o PKCE, o segredo e
 * o endereço de volta, como o de verdade) e decide a conta. Cobre conta nova (concluir cadastro),
 * conta existente confirmada e não confirmada (sessões caem, senha deixa de valer), 2FA, banida,
 * vínculo com outra conta Google, cada ID token recusado, os códigos de uso único e a LGPD.
 */

const CLIENT_ID = 'cliente-de-teste.apps.googleusercontent.com';
const SECRET = 'segredo-de-teste-do-google-com-32-caracteres';
const APP_URL = 'http://app.escambo.test';
const PASSWORD = 'senha-integracao-123';
const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

// ---------- o "Google" daqui: tela de consentimento (authorize) e token endpoint ----------

interface Issued {
  claims: Record<string, unknown>;
  nonce: string;
  challenge: string;
  redirectUri: string;
  used: boolean;
}
const issued = new Map<string, Issued>();
let tokenCalls = 0;
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

/** A pessoa escolhe a conta na tela do Google: o código que volta no endereço. */
function consent(location: string, claims: Record<string, unknown>): string {
  const url = new URL(location);
  const code = `4/0A-${randomUUID()}`;
  issued.set(code, {
    claims,
    nonce: url.searchParams.get('nonce')!,
    challenge: url.searchParams.get('code_challenge')!,
    redirectUri: url.searchParams.get('redirect_uri')!,
    used: false,
  });
  return code;
}

const fakeTokenEndpoint = (async (input: unknown, init?: RequestInit) => {
  tokenCalls++;
  expect(String(input)).toBe('https://oauth2.googleapis.com/token');
  const form = new URLSearchParams(String(init?.body));
  const entry = issued.get(form.get('code') ?? '');
  if (!entry || entry.used) return Response.json({ error: 'invalid_grant' }, { status: 400 });
  entry.used = true; // o código do Google também é de uso único
  const verifier = form.get('code_verifier') ?? '';
  if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) {
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  }
  if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== SECRET) {
    return Response.json({ error: 'invalid_client' }, { status: 401 });
  }
  if (
    form.get('redirect_uri') !== entry.redirectUri ||
    form.get('grant_type') !== 'authorization_code'
  ) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    email_verified: true,
    nonce: entry.nonce,
    iat: now,
    exp: now + 3600,
    ...entry.claims,
  };
  return Response.json({
    access_token: 'ya29.token-falso-que-nao-e-guardado',
    id_token: `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}.assinatura`,
  });
}) as typeof fetch;

setGoogleFetchForTests(fakeTokenEndpoint);
afterAll(() => setGoogleFetchForTests(null));

// ---------- o navegador ----------

let seq = 0;
function person(tag: string): { sub: string; email: string; name: string } {
  seq++;
  return {
    sub: `${Date.now()}${seq}${randomInt(1000, 9999)}`,
    email: `int_google_${tag}_${Date.now()}_${seq}@gmail.com`,
    name: `Pessoa ${tag}`,
  };
}

/** GET /start: para onde o navegador vai e o cookie da ida (como o navegador guardaria). */
async function start(): Promise<{ location: string; cookie: string; state: string }> {
  const res = await request(app).get('/api/auth/google/start');
  expect(res.status).toBe(302);
  const setCookie = String(res.headers['set-cookie']);
  const cookie = /^(escambo_google=[^;]+)/.exec(setCookie)![1]!;
  const state = new URL(res.headers.location as string).searchParams.get('state')!;
  return { location: res.headers.location as string, cookie, state };
}

function callback(query: string, cookie: string | null) {
  const req = request(app).get(`/api/auth/google/callback?${query}`);
  return cookie ? req.set('Cookie', cookie) : req;
}

/** O cookie da volta de cada código, como o navegador que voltou do Google o guarda. */
const returnCookies = new Map<string, string>();

/** A ida e a volta inteiras: devolve o endereço do web para onde a API mandou o navegador. */
async function viaGoogle(claims: Record<string, unknown>): Promise<string> {
  const ida = await start();
  const code = consent(ida.location, claims);
  const back = await callback(
    `state=${encodeURIComponent(ida.state)}&code=${encodeURIComponent(code)}&scope=email+openid`,
    ida.cookie,
  );
  expect(back.status).toBe(302);
  const location = back.headers.location as string;
  const returnCookie = /(escambo_google_volta=[^;]+)/.exec(String(back.headers['set-cookie']));
  if (location.includes('#codigo=')) {
    expect(returnCookie, 'a volta com código grava o cookie da volta').not.toBeNull();
    returnCookies.set(location.split('#codigo=')[1]!, returnCookie![1]!);
  } else {
    expect(returnCookie, 'a volta recusada não grava o cookie da volta').toBeNull();
  }
  return location;
}

const codeIn = (location: string): string => {
  expect(location).toMatch(new RegExp(`^${APP_URL}/entrar/google#codigo=[A-Za-z0-9_-]{64}$`));
  return location.split('#codigo=')[1]!;
};
/** A troca no navegador que voltou do Google (com o cookie da volta); `cookie: null`, em outro. */
const exchange = (code: string, cookie: string | null = returnCookies.get(code) ?? null) => {
  const req = request(app).post('/api/auth/google/exchange');
  return (cookie ? req.set('Cookie', cookie) : req).send({ code });
};

async function register(email: string): Promise<number> {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASSWORD, role: 'client' });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  return reg.body.id as number;
}
const passwordLogin = (email: string) =>
  request(app).post('/api/auth/login').send({ email, password: PASSWORD });

async function userRow(id: number): Promise<RowDataPacket> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT google_sub, password_hash, email_verified_at, status FROM users WHERE id = :id',
    { id },
  );
  return rows[0]!;
}
async function openSessions(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = :userId AND revoked_at IS NULL',
    { userId },
  );
  return Number(rows[0]!.n);
}

/** Conta nova pelo Google até a sessão: devolve o token e o id. */
async function signupViaGoogle(
  who: { sub: string; email: string; name: string },
  role: 'client' | 'freelancer' = 'client',
) {
  const ex = await exchange(codeIn(await viaGoogle(who)));
  expect(ex.status, JSON.stringify(ex.body)).toBe(200);
  const done = await request(app)
    .post('/api/auth/google/signup')
    .send({ signupToken: ex.body.signupToken, role, legalAccepted: true });
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  return { id: done.body.user.id as number, token: done.body.accessToken as string };
}

beforeEach(() => {
  tokenCalls = 0;
});

describe('ligado', () => {
  it('GET /providers diz true; o start vai ao Google com PKCE S256 e o endereço de volta do APP_URL', async () => {
    expect((await request(app).get('/api/auth/providers')).body).toEqual({ google: true });
    const ida = await start();
    const url = new URL(ida.location);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/auth/google/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });
});

describe('conta nova: o Google, concluir cadastro e a sessão', () => {
  it('nasce confirmada, vinculada, sem senha, com o papel e o aceite na versão vigente', async () => {
    const who = person('nova');
    const location = await viaGoogle(who);
    // Nenhuma conta antes de concluir o cadastro.
    const [none] = await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE email = :email', {
      email: who.email,
    });
    expect(none).toHaveLength(0);

    const ex = await exchange(codeIn(location));
    expect(ex.status).toBe(200);
    expect(ex.body).toEqual({
      signupRequired: true,
      signupToken: expect.any(String),
      expiresInSeconds: 900,
      email: who.email,
      name: who.name,
    });

    // Sem o aceite, não há conta; o passe continua valendo para a tentativa certa.
    const noTerms = await request(app)
      .post('/api/auth/google/signup')
      .send({ signupToken: ex.body.signupToken, role: 'freelancer' });
    expect(noTerms.status).toBe(422);

    const done = await request(app).post('/api/auth/google/signup').send({
      signupToken: ex.body.signupToken,
      role: 'freelancer',
      timezone: 'America/Manaus',
      legalAccepted: true,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.user).toMatchObject({
      email: who.email,
      role: 'freelancer',
      status: 'active',
      emailVerified: true,
      timezone: 'America/Manaus',
    });
    const id = done.body.user.id as number;
    const row = await userRow(id);
    expect(row).toMatchObject({ google_sub: who.sub, password_hash: null, status: 'active' });
    expect(row.email_verified_at).not.toBeNull();

    const [consents] = await pool.query<RowDataPacket[]>(
      'SELECT type, version, accepted FROM lgpd_consents WHERE user_id = :id ORDER BY id',
      { id },
    );
    expect(consents.map((c) => [c.type, c.version, Number(c.accepted)])).toEqual([
      ['terms_of_use', CURRENT_LEGAL_VERSION.terms_of_use, 1],
      ['privacy_policy', CURRENT_LEGAL_VERSION.privacy_policy, 1],
    ]);

    // A sessão vale; o perfil mostra como a conta entra; sem senha, o login com senha recusa.
    await request(app).get('/api/auth/me').set(auth(done.body.accessToken)).expect(200);
    const contact = await request(app).get('/api/auth/contact').set(auth(done.body.accessToken));
    expect(contact.body).toMatchObject({
      hasPassword: false,
      googleLinked: true,
      emailVerified: true,
    });
    const pw = await passwordLogin(who.email);
    expect(pw.status).toBe(401);
    expect(pw.body.error).toBe('invalid_credentials');

    // Da segunda vez, o sub já vinculado entra direto.
    const again = await exchange(codeIn(await viaGoogle(who)));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ accessToken: expect.any(String), user: { id } });
  });

  it('o código em outro navegador (o endereço mandado a alguém: CSRF de login) não troca, e o dono ainda troca', async () => {
    const who = person('outro_navegador');
    const code = codeIn(await viaGoogle(who));
    const elsewhere = await exchange(code, null);
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body.error).toBe('invalid_google_code');
    // Com o cookie da volta de outro código, também não.
    const other = codeIn(await viaGoogle(person('outro_codigo')));
    expect((await exchange(code, returnCookies.get(other)!)).status).toBe(400);
    // O código não foi gasto: no navegador que voltou do Google, ele ainda troca.
    const mine = await exchange(code);
    expect(mine.status).toBe(200);
    expect(mine.body.signupRequired).toBe(true);
    expect(String(mine.headers['set-cookie'])).toMatch(/^escambo_google_volta=; /);
  });

  it('o código da volta e o passe de cadastro valem uma vez só', async () => {
    const who = person('uso_unico');
    const code = codeIn(await viaGoogle(who));
    const first = await exchange(code);
    expect(first.status).toBe(200);
    const second = await exchange(code);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_google_code');

    const body = { signupToken: first.body.signupToken, role: 'client', legalAccepted: true };
    expect((await request(app).post('/api/auth/google/signup').send(body)).status).toBe(201);
    const reused = await request(app).post('/api/auth/google/signup').send(body);
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe('invalid_signup_token');
  });

  it('código vencido não vale (nem o passe de cadastro), e nada fica guardado depois de usado', async () => {
    const who = person('vencido');
    const code = codeIn(await viaGoogle(who));
    await pool.query(
      `UPDATE google_login_tickets SET expires_at = NOW() - INTERVAL 1 SECOND
        WHERE ticket_hash = SHA2(:code, 256)`,
      { code },
    );
    expect((await exchange(code)).body.error).toBe('invalid_google_code');

    const ex = await exchange(codeIn(await viaGoogle(who)));
    await pool.query(
      `UPDATE google_login_tickets SET expires_at = NOW() - INTERVAL 1 SECOND
        WHERE ticket_hash = SHA2(:token, 256)`,
      { token: ex.body.signupToken },
    );
    const late = await request(app)
      .post('/api/auth/google/signup')
      .send({ signupToken: ex.body.signupToken, role: 'client', legalAccepted: true });
    expect(late.body.error).toBe('invalid_signup_token');

    // O passe usado sai da tabela: o e-mail de quem não concluiu não fica para trás.
    const [left] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM google_login_tickets
        WHERE email = :email AND expires_at > NOW()`,
      { email: who.email },
    );
    expect(Number(left[0]!.n)).toBe(0);
  });

  it('o e-mail ganhou conta enquanto o cadastro estava aberto: 409, e o Google de novo vincula', async () => {
    const who = person('corrida');
    const ex = await exchange(codeIn(await viaGoogle(who)));
    const id = await register(who.email);
    const late = await request(app)
      .post('/api/auth/google/signup')
      .send({ signupToken: ex.body.signupToken, role: 'client', legalAccepted: true });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('email_taken');
    // Entrar com o Google de novo retoma a conta não confirmada.
    const back = await exchange(codeIn(await viaGoogle(who)));
    expect(back.body.user.id).toBe(id);
  });
});

describe('a volta: state, PKCE e ID token', () => {
  it('state errado, sem cookie ou com o cookie de outra ida: expirado, sem chamar o Google', async () => {
    const ida = await start();
    const other = await start();
    const code = consent(ida.location, person('state'));
    for (const [query, cookie] of [
      [`state=errado&code=${code}`, ida.cookie],
      [`state=${ida.state}&code=${code}`, null],
      [`state=${ida.state}&code=${code}`, other.cookie],
    ] as const) {
      const res = await callback(query, cookie);
      expect(res.headers.location).toBe(`${APP_URL}/login?google=expirado`);
    }
    expect(tokenCalls).toBe(0);
  });

  it('a mesma volta de novo, mesmo com o cookie copiado: expirado, sem chamar o Google', async () => {
    const ida = await start();
    const code = consent(ida.location, person('replay'));
    const query = `state=${ida.state}&code=${encodeURIComponent(code)}`;
    const first = await callback(query, ida.cookie);
    expect(first.headers.location).toMatch(/#codigo=/);
    // A volta apaga o cookie no navegador.
    expect(String(first.headers['set-cookie'])).toMatch(
      /^escambo_google=; .*Expires=Thu, 01 Jan 1970/,
    );
    const replay = await callback(query, ida.cookie);
    expect(replay.headers.location).toBe(`${APP_URL}/login?google=expirado`);
    expect(tokenCalls).toBe(1);
  });

  it('a pessoa desistiu no Google: negado', async () => {
    const ida = await start();
    const res = await callback(`error=access_denied&state=${ida.state}`, ida.cookie);
    expect(res.headers.location).toBe(`${APP_URL}/login?google=negado`);
  });

  it('nonce, público, emissor ou validade errados no ID token: falhou, sem conta nem vínculo', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [
      { nonce: 'nonce-de-outra-ida' },
      { aud: 'outro-cliente.apps.googleusercontent.com', azp: 'outro-cliente' },
      { iss: 'https://accounts.evil.example' },
      { exp: now - 3600, iat: now - 7200 },
    ]) {
      const who = person('token_ruim');
      expect(await viaGoogle({ ...who, ...bad })).toBe(`${APP_URL}/login?google=falhou`);
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM google_login_tickets WHERE email = :email',
        { email: who.email },
      );
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });

  it('e-mail que o Google não confirmou: email_nao_verificado', async () => {
    expect(await viaGoogle({ ...person('nao_verificado'), email_verified: false })).toBe(
      `${APP_URL}/login?google=email_nao_verificado`,
    );
  });

  it('o código do Google com outro verificador (PKCE) não troca: falhou', async () => {
    const ida = await start();
    const code = consent(ida.location, person('pkce'));
    issued.get(code)!.challenge = 'desafio-de-outra-ida';
    const res = await callback(`state=${ida.state}&code=${encodeURIComponent(code)}`, ida.cookie);
    expect(res.headers.location).toBe(`${APP_URL}/login?google=falhou`);
  });
});

describe('conta que já existe', () => {
  it('e-mail confirmado: vincula e entra; a senha e as sessões continuam', async () => {
    const admin = person('admin_leitor');
    const adminId = await register(admin.email.replace('@gmail.com', '@admin.escambo.test'));
    const adminLogin = await passwordLogin(
      admin.email.replace('@gmail.com', '@admin.escambo.test'),
    );
    expect(adminLogin.status).toBe(200);
    expect(adminId).toBeGreaterThan(0);

    const who = person('confirmada');
    const id = await register(who.email);
    await verifyEmailOf(app, adminLogin.body.accessToken, id);
    const before = await passwordLogin(who.email);
    expect(before.status).toBe(200);

    const ex = await exchange(codeIn(await viaGoogle(who)));
    expect(ex.status).toBe(200);
    expect(ex.body.user.id).toBe(id);
    expect((await userRow(id)).google_sub).toBe(who.sub);
    // A sessão da senha continua, e a senha também.
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: before.body.refreshToken })
      .expect(200);
    expect((await passwordLogin(who.email)).status).toBe(200);
    const [audit] = await pool.query<RowDataPacket[]>(
      "SELECT new_value FROM audit_logs WHERE user_id = :id AND action = 'auth.google_linked'",
      { id },
    );
    expect(audit).toHaveLength(1);
  });

  it('e-mail NÃO confirmado (pré-sequestro): confirma, invalida a senha antiga e derruba todas as sessões', async () => {
    const who = person('nao_confirmada');
    const id = await register(who.email);
    const squatter = await passwordLogin(who.email);
    expect(squatter.status).toBe(200);
    expect(await openSessions(id)).toBe(1);

    const ex = await exchange(codeIn(await viaGoogle(who)));
    expect(ex.status).toBe(200);
    expect(ex.body.user).toMatchObject({ id, emailVerified: true, status: 'active' });

    const row = await userRow(id);
    expect(row).toMatchObject({ google_sub: who.sub, password_hash: null, status: 'active' });
    expect(row.email_verified_at).not.toBeNull();
    // Só a sessão nova, do Google, está aberta: a de quem tinha a senha caiu.
    expect(await openSessions(id)).toBe(1);
    const old = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: squatter.body.refreshToken });
    expect(old.status).toBe(401);
    expect((await passwordLogin(who.email)).status).toBe(401);

    const [audit] = await pool.query<RowDataPacket[]>(
      "SELECT new_value FROM audit_logs WHERE user_id = :id AND action = 'auth.google_claimed'",
      { id },
    );
    expect(audit).toHaveLength(1);
    const value = audit[0]!.new_value;
    expect(typeof value === 'string' ? JSON.parse(value) : value).toEqual({
      sessionsRevoked: 1,
      passwordCleared: true,
    });
  });

  it('com a 2FA ativa: o passe do segundo fator, nunca a sessão', async () => {
    const who = person('dois_fatores');
    const { id } = await signupViaGoogle(who);
    await pool.query(
      `INSERT INTO user_mfa (user_id, method, is_enabled, confirmed_at) VALUES (:id, 'totp', 1, NOW())`,
      { id },
    );
    const sessionsBefore = await openSessions(id);
    const ex = await exchange(codeIn(await viaGoogle(who)));
    expect(ex.status).toBe(200);
    expect(ex.body).toEqual({
      mfaRequired: true,
      mfaToken: expect.any(String),
      expiresInSeconds: 300,
    });
    const [u] = await pool.query<RowDataPacket[]>('SELECT ulid FROM users WHERE id = :id', { id });
    expect(verifyMfaToken(ex.body.mfaToken)).toBe(u[0]!.ulid);
    expect(await openSessions(id)).toBe(sessionsBefore);
  });

  it('banida ou excluída não entra; suspensa entra para consulta (RN-007)', async () => {
    const banned = person('banida');
    const b = await signupViaGoogle(banned);
    await pool.query("UPDATE users SET status = 'banned' WHERE id = :id", { id: b.id });
    expect(await viaGoogle(banned)).toBe(`${APP_URL}/login?google=conta_banida`);

    const deleted = person('excluida');
    const d = await signupViaGoogle(deleted);
    await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = :id', { id: d.id });
    expect(await viaGoogle(deleted)).toBe(`${APP_URL}/login?google=conta_excluida`);

    const suspended = person('suspensa');
    const s = await signupViaGoogle(suspended);
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = :id", { id: s.id });
    const ex = await exchange(codeIn(await viaGoogle(suspended)));
    expect(ex.body.user).toMatchObject({ id: s.id, status: 'suspended' });

    // Banida entre a volta e a troca: a recusa do login.
    const late = person('banida_depois');
    const l = await signupViaGoogle(late);
    const code = codeIn(await viaGoogle(late));
    await pool.query("UPDATE users SET status = 'banned' WHERE id = :id", { id: l.id });
    const refused = await exchange(code);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('account_banned');
  });

  it('o e-mail já entra com outra conta Google: conta_vinculada, nada muda', async () => {
    const who = person('vinculada');
    const id = await register(who.email);
    await pool.query("UPDATE users SET google_sub = 'outra-conta-google' WHERE id = :id", { id });
    expect(await viaGoogle(who)).toBe(`${APP_URL}/login?google=conta_vinculada`);
    expect((await userRow(id)).google_sub).toBe('outra-conta-google');
  });

  it('o mesmo sub não vincula duas contas (chave única, comparação exata)', async () => {
    const [a, b] = [person('unico_a'), person('unico_b')];
    const ida = await register(a.email);
    const idb = await register(b.email);
    await pool.query("UPDATE users SET google_sub = 'SubIgual' WHERE id = :id", { id: ida });
    await expect(
      pool.query("UPDATE users SET google_sub = 'SubIgual' WHERE id = :id", { id: idb }),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    // ascii_bin: maiúsculas contam (o sub é opaco).
    await pool.query("UPDATE users SET google_sub = 'subigual' WHERE id = :id", { id: idb });
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE google_sub = 'SubIgual'",
    );
    expect(rows.map((r) => r.id)).toEqual([ida]);
  });
});

describe('LGPD', () => {
  it('a cópia diz que a conta entra com o Google e traz o sub; a anonimização apaga o vínculo', async () => {
    const who = person('lgpd');
    const { id, token } = await signupViaGoogle(who, 'freelancer');
    const copy = await buildExport(id);
    expect(copy.formato).toBe('escambo-export/1.15');
    expect(copy.contaGoogle).toEqual({ vinculada: true, sub: who.sub });
    expect(copy.titular).not.toHaveProperty('google_sub');

    const adminEmail = `int_google_lgpd_admin_${Date.now()}@admin.escambo.test`;
    await register(adminEmail);
    const admin = await passwordLogin(adminEmail);
    const asked = await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(token))
      .send({ reason: 'Não quero mais usar o Escambo.' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const done = await request(app)
      .post(`/api/admin/deletion-requests/${asked.body.id}/complete`)
      .set(auth(admin.body.accessToken));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await userRow(id)).google_sub).toBeNull();

    // A mesma conta Google pode abrir uma conta nova depois.
    const ex = await exchange(codeIn(await viaGoogle(who)));
    expect(ex.body.signupRequired).toBe(true);
  });
});
