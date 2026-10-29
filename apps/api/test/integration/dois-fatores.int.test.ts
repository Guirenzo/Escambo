import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { buildExport } from '../../src/modules/lgpd/lgpd.export';
import { base32Decode, hotp, totpStep } from '../../src/modules/auth/totp';
import { clock, setClockForTests } from '../../src/utils/clock';
import { fieldEncryptionEnabled, setFieldKeysForTests } from '../../src/utils/field-crypto';

/**
 * Verificação em duas etapas (RF-090, RNF-042, ADR 66) contra o MySQL real: o segredo vai cifrado
 * para o banco, a ativação derruba as outras sessões, o login passa a ter dois passos, o mesmo
 * código não vale duas vezes, o código de recuperação é de uso único, cinco erros travam por 15
 * minutos, o atendimento desativa a 2FA de quem perdeu o acesso, o painel pode exigi-la, e a cópia
 * e a exclusão de dados (LGPD) tratam a linha nova. O código do app é calculado aqui, a partir do
 * segredo que a API devolve, com o relógio do fluxo parado (cada passo de 30 s andado à mão).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PASSWORD = 'senha-integracao-123';

interface Account {
  id: number;
  ulid: string;
  email: string;
  token: string;
  refresh: string;
}

let seq = 0;
async function register(prefix: string, admin = false): Promise<string> {
  const email = `int_2fa_${prefix}_${Date.now()}_${seq++}@${admin ? 'admin.' : ''}escambo.test`;
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASSWORD, role: 'client' });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  return email;
}

async function loginPlain(email: string): Promise<Account> {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body).not.toHaveProperty('mfaRequired');
  return {
    id: res.body.user.id,
    ulid: res.body.user.ulid,
    email,
    token: res.body.accessToken,
    refresh: res.body.refreshToken,
  };
}

/** Primeiro passo numa conta com 2FA: o passe, sem sessão. */
async function challenge(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body).toEqual({
    mfaRequired: true,
    mfaToken: expect.any(String),
    expiresInSeconds: 300,
  });
  return res.body.mfaToken as string;
}

const secondStep = (mfaToken: string, code: string) =>
  request(app).post('/api/auth/login/mfa').send({ mfaToken, code });

// ---------- relógio do fluxo: parado, andando de passo em passo ----------

let frozenAt = 0;
/**
 * Para o relógio no agora, sem nunca voltar: um teste que andou 15 minutos (a trava) deixa o
 * último passo aceito no futuro do relógio de verdade, e o anti-reuso recusaria os códigos.
 */
function freezeClock(): void {
  frozenAt = Math.max(frozenAt, Math.floor(Date.now() / 1000) * 1000);
  setClockForTests(new Date(frozenAt), { frozen: true });
}
function advance(ms: number): void {
  frozenAt += ms;
  setClockForTests(new Date(frozenAt), { frozen: true });
}
/** O código do app no passo atual do relógio do fluxo (ou num vizinho). */
function codeOf(secret: string, offset = 0): string {
  return hotp(base32Decode(secret)!, totpStep(clock.now()) + offset);
}
/** Anda um passo: o próximo código é novo (o anti-reuso recusa o do passo já usado). */
function nextCode(secret: string): string {
  advance(30_000);
  return codeOf(secret);
}

// ---------- leitura direta do banco ----------

interface MfaStored extends RowDataPacket {
  secret: Buffer | null;
  is_enabled: number;
  confirmed_at: Date | null;
  recovery_codes: { h: string; usedAt: string | null }[] | null;
  last_used_step: number | null;
  failed_attempts: number;
  locked_until: Date | null;
}
async function mfaRowOf(userId: number): Promise<MfaStored | undefined> {
  const [rows] = await pool.query<MfaStored[]>(
    `SELECT secret, is_enabled, confirmed_at, recovery_codes, last_used_step, failed_attempts,
            locked_until
       FROM user_mfa WHERE user_id = :userId`,
    { userId },
  );
  return rows[0];
}

async function openSessions(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = :userId AND revoked_at IS NULL',
    { userId },
  );
  return Number(rows[0]!.n);
}

/**
 * O new_value das linhas da auditoria (coluna JSON: o mysql2 já devolve o objeto). A auditoria é
 * gravada em segundo plano (melhor esforço): espera a linha aparecer.
 */
async function auditOf(userId: number, action: string): Promise<unknown[]> {
  for (let i = 0; i < 30; i++) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT new_value FROM audit_logs WHERE user_id = :userId AND action = :action ORDER BY id`,
      { userId, action },
    );
    if (rows.length > 0) {
      return rows.map((r) =>
        typeof r.new_value === 'string' ? (JSON.parse(r.new_value) as unknown) : r.new_value,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

async function outbox(userId: number, subject: string): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT subject, text_body FROM email_outbox WHERE user_id = :userId AND subject = :subject`,
    { userId, subject },
  );
  return rows;
}

/** Liga a 2FA de uma conta logada pelo caminho do produto e devolve o segredo e os códigos. */
async function enableMfa(account: Account): Promise<{ secret: string; codes: string[] }> {
  const setup = await request(app)
    .post('/api/auth/mfa/setup')
    .set(auth(account.token))
    .send({ password: PASSWORD });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  const secret = setup.body.secret as string;
  const enabled = await request(app)
    .post('/api/auth/mfa/enable')
    .set(auth(account.token))
    .send({ code: codeOf(secret) });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  account.token = enabled.body.accessToken;
  account.refresh = enabled.body.refreshToken;
  return { secret, codes: enabled.body.recoveryCodes as string[] };
}

let admin: Account;

beforeAll(async () => {
  expect(fieldEncryptionEnabled()).toBe(true);
  admin = await loginPlain(await register('admin', true));
});
beforeEach(() => freezeClock());
afterEach(() => {
  setClockForTests(null);
  setFieldKeysForTests(null);
  env.ADMIN_MFA_REQUIRED = false;
});
afterAll(async () => {
  await pool.end();
});

describe('migration 0050 (colunas da 2FA em user_mfa)', () => {
  const columns = async (): Promise<Record<string, string>> => {
    const [cols] = await pool.query<RowDataPacket[]>(
      `SELECT column_name AS col, column_type AS type, is_nullable AS nullable,
              column_default AS def
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'user_mfa'
          AND column_name IN ('last_used_step', 'failed_attempts', 'locked_until')`,
    );
    return Object.fromEntries(
      cols.map((c) => [c.col, `${c.type} ${c.nullable} ${c.def ?? 'NULL'}`]),
    );
  };

  it('está aplicada, com as três colunas, e rodar de novo não muda nada', async () => {
    const [done] = await pool.query<RowDataPacket[]>(
      `SELECT name FROM schema_migrations WHERE name = '0050_mfa_totp'`,
    );
    expect(done).toHaveLength(1);
    const expected = {
      last_used_step: 'bigint YES NULL',
      failed_attempts: 'int unsigned NO 0',
      locked_until: 'datetime YES NULL',
    };
    expect(await columns()).toEqual(expected);

    const sql = readFileSync(join(__dirname, '../../db/migrations/0050_mfa_totp.sql'), 'utf8');
    const conn = await mysql.createConnection({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      multipleStatements: true,
    });
    try {
      await conn.query(sql);
      await conn.query(sql); // idempotente
    } finally {
      await conn.end();
    }
    expect(await columns()).toEqual(expected);
  });
});

describe('ativação (RF-090)', () => {
  it('o segredo vai CIFRADO para o banco; ativar derruba as outras sessões e avisa por e-mail', async () => {
    const email = await register('ativa');
    const user = await loginPlain(email);
    const other = await loginPlain(email); // outro aparelho
    expect(await openSessions(user.id)).toBe(2);

    const before = await request(app).get('/api/auth/mfa').set(auth(user.token)).expect(200);
    expect(before.body).toEqual({
      enabled: false,
      confirmedAt: null,
      recoveryCodesLeft: 0,
      available: true,
      required: false,
    });

    await request(app)
      .post('/api/auth/mfa/setup')
      .set(auth(user.token))
      .send({ password: 'outra-senha-789' })
      .expect(400);
    const setup = await request(app)
      .post('/api/auth/mfa/setup')
      .set(auth(user.token))
      .send({ password: PASSWORD })
      .expect(200);
    const secret = setup.body.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUrl).toBe(
      `otpauth://totp/Escambo:${encodeURIComponent(email)}?secret=${secret}&issuer=Escambo&algorithm=SHA1&digits=6&period=30`,
    );

    // RNF-042: o SELECT direto mostra o texto cifrado, nunca o segredo.
    const pending = (await mfaRowOf(user.id))!;
    const stored = pending.secret!.toString('utf8');
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(pending.is_enabled).toBe(0);

    // Código errado não ativa (e conta na trava da linha pendente).
    const wrong = await request(app)
      .post('/api/auth/mfa/enable')
      .set(auth(user.token))
      .send({ code: codeOf(secret, 5) })
      .expect(400);
    expect(wrong.body.error).toBe('invalid_mfa_code');
    expect((await mfaRowOf(user.id))!.failed_attempts).toBe(1);

    const enabled = await request(app)
      .post('/api/auth/mfa/enable')
      .set(auth(user.token))
      .send({ code: codeOf(secret) })
      .expect(200);
    const codes = enabled.body.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    // Só a sessão nova fica aberta: o refresh do outro aparelho (e o antigo deste) não vale mais.
    expect(await openSessions(user.id)).toBe(1);
    await request(app).post('/api/auth/refresh').send({ refreshToken: other.refresh }).expect(401);
    await request(app).post('/api/auth/refresh').send({ refreshToken: user.refresh }).expect(401);
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: enabled.body.refreshToken })
      .expect(200);

    const row = (await mfaRowOf(user.id))!;
    expect(row.is_enabled).toBe(1);
    expect(row.confirmed_at).not.toBeNull();
    expect(Number(row.last_used_step)).toBe(totpStep(clock.now()));
    expect(row.failed_attempts).toBe(0);
    expect(row.recovery_codes).toHaveLength(10);
    // Só os hashes: nenhum código aparece no que foi gravado.
    expect(JSON.stringify(row.recovery_codes)).not.toContain(codes[0]!.replace('-', ''));
    expect(row.secret!.toString('utf8')).toBe(stored);

    const status = await request(app)
      .get('/api/auth/mfa')
      .set(auth(enabled.body.accessToken))
      .expect(200);
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    expect(new Date(status.body.confirmedAt).getTime()).toBe(row.confirmed_at!.getTime());

    expect(await auditOf(user.id, 'mfa_enabled')).toHaveLength(1);
    expect(await outbox(user.id, 'Verificação em duas etapas ativada')).toHaveLength(1);

    // Ativar de novo: 409; começar de novo com ela ativa: 409.
    await request(app)
      .post('/api/auth/mfa/enable')
      .set(auth(enabled.body.accessToken))
      .send({ code: nextCode(secret) })
      .expect(409);
    await request(app)
      .post('/api/auth/mfa/setup')
      .set(auth(enabled.body.accessToken))
      .send({ password: PASSWORD })
      .expect(409);
  });

  it('confirmar sem ter começado: 400 mfa_not_started', async () => {
    const user = await loginPlain(await register('sem_setup'));
    const res = await request(app)
      .post('/api/auth/mfa/enable')
      .set(auth(user.token))
      .send({ code: '123456' })
      .expect(400);
    expect(res.body.error).toBe('mfa_not_started');
  });
});

describe('login em dois passos', () => {
  let email: string;
  let user: Account;
  let secret: string;
  let codes: string[];
  let enabledStep = 0;

  beforeAll(async () => {
    freezeClock();
    email = await register('login');
    user = await loginPlain(email);
    ({ secret, codes } = await enableMfa(user));
    enabledStep = totpStep(clock.now());
  });

  it('a senha leva ao passe; o passe e o código, à sessão. O mesmo código não vale duas vezes', async () => {
    const mfaToken = await challenge(email);
    expect(await openSessions(user.id)).toBe(1); // o primeiro passo não abre sessão

    // O código que ativou (o último passo aceito) não entra no login.
    const reuse = await secondStep(mfaToken, hotp(base32Decode(secret)!, enabledStep)).expect(400);
    expect(reuse.body.error).toBe('invalid_mfa_code');

    const code = nextCode(secret);
    const ok = await secondStep(mfaToken, code).expect(200);
    expect(ok.body.user).toMatchObject({ id: user.id, email });
    await request(app).get('/api/auth/me').set(auth(ok.body.accessToken)).expect(200);

    // O mesmo código, de novo, no mesmo passo: recusado (anti-reuso).
    const again = await secondStep(await challenge(email), code).expect(400);
    expect(again.body.error).toBe('invalid_mfa_code');
    // Com espaço no meio (como o app mostra), o código do passo seguinte entra.
    const spaced = nextCode(secret);
    await secondStep(await challenge(email), `${spaced.slice(0, 3)} ${spaced.slice(3)}`).expect(
      200,
    );
  });

  it('o passe não é token de acesso, e o token de acesso não é passe', async () => {
    const mfaToken = await challenge(email);
    const asBearer = await request(app).get('/api/auth/me').set(auth(mfaToken)).expect(401);
    expect(asBearer.body.error).toBe('invalid_token');

    const asPass = await secondStep(user.token, nextCode(secret)).expect(401);
    expect(asPass.body.error).toBe('invalid_mfa_token');
  });

  it('código de recuperação: entra uma vez só, e a auditoria diz quantos sobraram', async () => {
    const recovery = codes[0]!;
    // Digitado em minúsculas e sem hífen, também vale.
    await secondStep(await challenge(email), recovery.toLowerCase().replace('-', '')).expect(200);
    const again = await secondStep(await challenge(email), recovery).expect(400);
    expect(again.body.error).toBe('invalid_mfa_code');

    const used = await auditOf(user.id, 'auth.mfa_recovery_used');
    expect(used).toHaveLength(1);
    expect(used[0]).toEqual({
      context: 'login',
      recoveryCodesLeft: 9,
    });
    const login = await secondStep(await challenge(email), nextCode(secret)).expect(200);
    const status = await request(app)
      .get('/api/auth/mfa')
      .set(auth(login.body.accessToken))
      .expect(200);
    expect(status.body.recoveryCodesLeft).toBe(9);
  });

  it('cinco erros seguidos travam por 15 minutos (429), até o código certo; depois, volta', async () => {
    const mfaToken = await challenge(email);
    for (let i = 1; i <= 4; i++) {
      const res = await secondStep(mfaToken, '000000');
      expect(res.status, `erro ${i}`).toBe(400);
    }
    const fifth = await secondStep(mfaToken, '000000').expect(429);
    expect(fifth.body).toEqual({
      error: 'mfa_locked',
      message: 'Muitas tentativas. Tente de novo em 15 minutos.',
    });
    const locked = (await mfaRowOf(user.id))!;
    expect(locked.failed_attempts).toBe(0);
    expect(locked.locked_until!.getTime()).toBe(clock.now().getTime() + 15 * 60_000);

    // Travada, nem o código certo nem um de recuperação passam.
    await secondStep(mfaToken, nextCode(secret)).expect(429);
    await secondStep(mfaToken, codes[1]!).expect(429);

    // Passados os 15 minutos, o código certo entra e zera a contagem.
    advance(15 * 60_000);
    await secondStep(await challenge(email), codeOf(secret)).expect(200);
    expect((await mfaRowOf(user.id))!.locked_until).toBeNull();

    const failures = await auditOf(user.id, 'auth.mfa_failed');
    expect(failures.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(failures)).not.toContain('000000');
  });

  it('segredo que não decifra (chave trocada): o TOTP falha fechado; o código de recuperação entra', async () => {
    setFieldKeysForTests({ current: Buffer.alloc(32, 0x7e).toString('base64') });
    const res = await secondStep(await challenge(email), nextCode(secret)).expect(500);
    expect(res.body.error).toBe('mfa_unreadable');
    await secondStep(await challenge(email), codes[2]!).expect(200);
  });

  it('novos códigos de recuperação: os antigos deixam de valer', async () => {
    const login = await secondStep(await challenge(email), nextCode(secret)).expect(200);
    const fresh = await request(app)
      .post('/api/auth/mfa/recovery-codes')
      .set(auth(login.body.accessToken))
      .send({ password: PASSWORD, code: nextCode(secret) })
      .expect(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    await secondStep(await challenge(email), codes[3]!).expect(400);
    await secondStep(await challenge(email), fresh.body.recoveryCodes[0]).expect(200);
    expect(await auditOf(user.id, 'mfa_recovery_codes_regenerated')).toHaveLength(1);
  });

  it('desativar (senha + código): o login volta a ser de um passo e o titular é avisado', async () => {
    const login = await secondStep(await challenge(email), nextCode(secret)).expect(200);
    await request(app)
      .post('/api/auth/mfa/disable')
      .set(auth(login.body.accessToken))
      .send({ password: PASSWORD, code: '000000' })
      .expect(400);
    await request(app)
      .post('/api/auth/mfa/disable')
      .set(auth(login.body.accessToken))
      .send({ password: PASSWORD, code: nextCode(secret) })
      .expect(204);

    expect(await mfaRowOf(user.id)).toBeUndefined();
    await loginPlain(email);
    expect(await outbox(user.id, 'Verificação em duas etapas desativada')).toHaveLength(1);
    expect(await auditOf(user.id, 'mfa_disabled')).toHaveLength(1);
  });
});

describe('atendimento: a conta pelo e-mail e o reset da 2FA (ADR 66)', () => {
  it('o admin acha a conta, desativa a 2FA com o motivo, as sessões caem e o titular é avisado', async () => {
    const email = await register('reset');
    const user = await loginPlain(email);
    await enableMfa(user);

    const found = await request(app)
      .get(`/api/admin/users/lookup?email=${encodeURIComponent(email.toUpperCase())}`)
      .set(auth(admin.token))
      .expect(200);
    expect(found.body).toEqual({
      ulid: user.ulid,
      email,
      role: 'client',
      status: 'pending_verification',
      mfaEnabled: true,
      createdAt: expect.any(String),
      // Conta de cliente sem perfil de freelancer nem de empresa (RF-018, RF-020).
      cpf: null,
      company: null,
    });
    await request(app)
      .get('/api/admin/users/lookup?email=ninguem@escambo.test')
      .set(auth(admin.token))
      .expect(404);
    // Quem não é admin não busca.
    await request(app)
      .get(`/api/admin/users/lookup?email=${encodeURIComponent(email)}`)
      .set(auth(user.token))
      .expect(403);

    const reason = 'Titular perdeu o celular; identidade conferida pelo suporte.';
    await request(app)
      .post(`/api/admin/users/${user.ulid}/mfa/reset`)
      .set(auth(admin.token))
      .send({ reason: 'curto' })
      .expect(422);
    await request(app)
      .post(`/api/admin/users/${user.ulid}/mfa/reset`)
      .set(auth(admin.token))
      .send({ reason })
      .expect(204);

    expect(await mfaRowOf(user.id)).toBeUndefined();
    expect(await openSessions(user.id)).toBe(0);
    await request(app).post('/api/auth/refresh').send({ refreshToken: user.refresh }).expect(401);
    const [actions] = await pool.query<RowDataPacket[]>(
      `SELECT admin_id, target_type, target_id, description FROM admin_actions
        WHERE action = 'user_mfa_reset' AND target_id = :id`,
      { id: user.id },
    );
    expect(actions).toEqual([
      { admin_id: admin.id, target_type: 'user', target_id: user.id, description: reason },
    ]);
    const audits = await auditOf(admin.id, 'mfa_reset_by_admin');
    expect(audits).toContainEqual({
      ulid: user.ulid,
      sessionsRevoked: 1,
    });
    const mails = await outbox(user.id, 'Verificação em duas etapas desativada pelo atendimento');
    expect(mails).toHaveLength(1);
    expect(String(mails[0]!.text_body)).not.toContain('identidade conferida');

    // Sem a 2FA, a senha basta; reset de novo: 409; a própria conta do admin: 400.
    await loginPlain(email);
    const lookup = await request(app)
      .get(`/api/admin/users/lookup?email=${encodeURIComponent(email)}`)
      .set(auth(admin.token))
      .expect(200);
    expect(lookup.body.mfaEnabled).toBe(false);
    const again = await request(app)
      .post(`/api/admin/users/${user.ulid}/mfa/reset`)
      .set(auth(admin.token))
      .send({ reason })
      .expect(409);
    expect(again.body.error).toBe('mfa_not_enabled');
    const self = await request(app)
      .post(`/api/admin/users/${admin.ulid}/mfa/reset`)
      .set(auth(admin.token))
      .send({ reason })
      .expect(400);
    expect(self.body.error).toBe('cannot_reset_self');
  });

  it('ADMIN_MFA_REQUIRED: o painel responde 403 mfa_required até o admin ativar a 2FA', async () => {
    const other = await loginPlain(await register('painel', true));
    env.ADMIN_MFA_REQUIRED = true;

    const blocked = await request(app).get('/api/admin/metrics').set(auth(other.token)).expect(403);
    expect(blocked.body).toEqual({
      error: 'mfa_required',
      message: 'Ative a verificação em duas etapas no seu perfil para usar o painel.',
    });
    await request(app).get('/api/admin/support/tickets').set(auth(other.token)).expect(403);
    const status = await request(app).get('/api/auth/mfa').set(auth(other.token)).expect(200);
    expect(status.body.required).toBe(true);

    await enableMfa(other);
    await request(app).get('/api/admin/metrics').set(auth(other.token)).expect(200);
  });
});

describe('LGPD: cópia e exclusão de dados com a 2FA', () => {
  it('a cópia traz a situação da 2FA, nunca o segredo nem os hashes; a exclusão apaga a linha', async () => {
    const email = await register('lgpd');
    const user = await loginPlain(email);
    const { codes } = await enableMfa(user);

    const data = await buildExport(user.id);
    expect(data.formato).toBe('escambo-export/1.15');
    const row = (await mfaRowOf(user.id))!;
    expect(data.mfa).toEqual({
      enabled: true,
      confirmedAt: row.confirmed_at!.toISOString(),
      recoveryCodesLeft: 10,
    });
    const text = JSON.stringify(data);
    expect(text).not.toContain('enc:v1:');
    expect(text).not.toContain(row.recovery_codes![0]!.h);
    expect(text).not.toContain(codes[0]!);

    const asked = await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(user.token))
      .send({ reason: 'Não uso mais a plataforma.' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    await request(app)
      .post(`/api/admin/deletion-requests/${asked.body.id}/complete`)
      .set(auth(admin.token))
      .expect(200);
    expect(await mfaRowOf(user.id)).toBeUndefined();
  });
});
