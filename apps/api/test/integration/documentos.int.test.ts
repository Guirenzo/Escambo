import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { mediaRepository } from '../../src/modules/media/media.repository';
import { fieldEncryptionEnabled } from '../../src/utils/field-crypto';
import { uniqueCpf, verifyCpfOf } from './cpf.helpers';
import { verifyEmailOf } from './mail.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Documentos (1.53.0) contra o MySQL real: o CPF do freelancer (RF-020, RN-009, RN-075) com a
 * cifragem, o índice cego e a chave única de verdade, o saque que passa a pedi-lo, a correção pelo
 * atendimento e a LGPD; e a conta de empresa (RF-018): cadastro com CNPJ alfanumérico único, o
 * perfil, a página pública, o selo onde quem contrata aparece e a LGPD.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PASSWORD = 'senha-integracao-123';

interface Actor {
  id: number;
  ulid: string;
  email: string;
  token: string;
}

let seq = 0;
const stamp = (): string => `${Date.now().toString(36)}${seq++}`;

async function login(email: string): Promise<Actor> {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    id: res.body.user.id,
    ulid: res.body.user.ulid,
    email,
    token: res.body.accessToken,
  };
}

async function register(
  role: 'client' | 'freelancer' | 'company',
  extra: Record<string, unknown> = {},
  admin = false,
): Promise<Actor> {
  const email = `doc_${role}_${stamp()}@${admin ? 'admin.' : ''}escambo.test`;
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASSWORD, role, ...extra });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  return login(email);
}

/** CNPJ alfanumérico válido e único: base "AB" + 10 caracteres do carimbo, verificadores calculados. */
function uniqueCnpj(): string {
  const value = (c: string): number => c.charCodeAt(0) - 48;
  const dv = (base: string): number => {
    let sum = 0;
    let weight = 2;
    for (let i = base.length - 1; i >= 0; i--) {
      sum += value(base[i]!) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const base = `AB${stamp()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '0')}`
    .padEnd(12, '7')
    .slice(0, 12);
  const first = dv(base);
  return `${base}${first}${dv(`${base}${first}`)}`;
}

const masked = (cnpj: string): string =>
  `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;

async function cpfRow(userId: number): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT cpf_verified, cpf_encrypted, cpf_index, DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date,
            cpf_verified_at
       FROM profiles_freelancer WHERE user_id = :userId`,
    { userId },
  );
  return rows[0];
}

async function exportOf(token: string): Promise<Record<string, unknown>> {
  const created = await request(app).post('/api/lgpd/export-requests').set(auth(token));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const dl = await request(app)
    .get(`/api/lgpd/export-requests/${created.body.id}/download`)
    .set(auth(token));
  expect(dl.status).toBe(200);
  return JSON.parse(dl.text) as Record<string, unknown>;
}

/** Pede a exclusão e o admin conclui: a conta é anonimizada (RN-072). */
async function anonymize(user: Actor, admin: Actor): Promise<void> {
  const asked = await request(app)
    .post('/api/lgpd/deletion-requests')
    .set(auth(user.token))
    .send({ reason: 'Teste dos documentos.' });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  const done = await request(app)
    .post(`/api/admin/deletion-requests/${asked.body.id}/complete`)
    .set(auth(admin.token));
  expect(done.status, JSON.stringify(done.body)).toBe(200);
}

const withdraw = (token: string) =>
  request(app)
    .post('/api/withdrawals')
    .set(auth(token))
    .send({ amount: 50, method: 'pix', pixKey: 'doc@pix.escambo.test' });

let admin: Actor;

beforeAll(async () => {
  expect(fieldEncryptionEnabled()).toBe(true);
  admin = await register('client', {}, true);
});

afterAll(async () => {
  await pool.end();
});

describe('migration 0052 (documentos)', () => {
  it('está aplicada: as colunas do CPF, a chave única do índice e o nome fantasia; rodar de novo não muda nada', async () => {
    const [done] = await pool.query<RowDataPacket[]>(
      `SELECT name FROM schema_migrations WHERE name = '0052_documentos'`,
    );
    expect(done).toHaveLength(1);
    const shape = async () => {
      const [cols] = await pool.query<RowDataPacket[]>(
        `SELECT table_name AS tbl, column_name AS col, column_type AS type, is_nullable AS nullable
           FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND ((table_name = 'profiles_freelancer'
                  AND column_name IN ('cpf_encrypted', 'cpf_index', 'birth_date', 'cpf_verified_at'))
              OR (table_name = 'profiles_company' AND column_name = 'trade_name'))
          ORDER BY table_name, column_name`,
      );
      const [keys] = await pool.query<RowDataPacket[]>(
        `SELECT index_name AS name, non_unique AS nonUnique FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'profiles_freelancer'
            AND index_name = 'uq_pf_cpf_index'`,
      );
      return { cols: cols.map((c) => `${c.tbl}.${c.col} ${c.type} ${c.nullable}`), keys };
    };
    const before = await shape();
    expect(before.cols).toEqual([
      'profiles_company.trade_name varchar(150) YES',
      'profiles_freelancer.birth_date date YES',
      'profiles_freelancer.cpf_encrypted varchar(255) YES',
      'profiles_freelancer.cpf_index char(64) YES',
      'profiles_freelancer.cpf_verified_at datetime YES',
    ]);
    expect(before.keys).toEqual([{ name: 'uq_pf_cpf_index', nonUnique: 0 }]);

    const sql = readFileSync(join(__dirname, '../../db/migrations/0052_documentos.sql'), 'utf8');
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
    expect(await shape()).toEqual(before);
  });
});

describe('CPF do freelancer (RF-020, RN-009, RN-075)', () => {
  it('valida uma vez: cifrado no banco, índice cego único, só mascarado na tela; o saque passa a pedi-lo', async () => {
    const freelancer = await register('freelancer');
    // Depositar pede e-mail confirmado (RF-006, 1.52.0): confirma antes de pôr dinheiro na carteira.
    await verifyEmailOf(app, admin.token, freelancer.id);
    await fundWallet(app, freelancer.token, 200);

    // Sem perfil de freelancer, o CPF não tem onde ficar.
    const cpf = uniqueCpf();
    const noProfile = await request(app)
      .put('/api/profiles/me/cpf')
      .set(auth(freelancer.token))
      .send({ cpf, birthDate: '1990-05-17' });
    expect(noProfile.status).toBe(409);
    expect(noProfile.body.error).toBe('no_freelancer_profile');
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(freelancer.token))
      .send({ fullName: 'Freela Documentado' })
      .expect(200);

    const before = await request(app).get('/api/profiles/me/cpf').set(auth(freelancer.token));
    expect(before.body).toEqual({
      available: true,
      required: true,
      hasFreelancerProfile: true,
      verified: false,
      maskedCpf: null,
      birthDate: null,
      verifiedAt: null,
    });

    // O saque de quem entrega trabalho pede o CPF validado (e-mail já confirmado).
    const blocked = await withdraw(freelancer.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('cpf_required');

    // Dígito errado e menor de idade não passam.
    const wrong = `${cpf.slice(0, 10)}${(Number(cpf[10]) + 1) % 10}`;
    const bad = await request(app)
      .put('/api/profiles/me/cpf')
      .set(auth(freelancer.token))
      .send({ cpf: wrong, birthDate: '1990-05-17' });
    expect(bad.status).toBe(422);
    const minor = await request(app)
      .put('/api/profiles/me/cpf')
      .set(auth(freelancer.token))
      .send({ cpf, birthDate: '2015-01-01' });
    expect(minor.status).toBe(422);
    expect(minor.body.error).toBe('underage');

    const ok = await request(app)
      .put('/api/profiles/me/cpf')
      .set(auth(freelancer.token))
      .send({
        cpf: `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`,
        birthDate: '1990-05-17',
      });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      verified: true,
      maskedCpf: `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`,
      birthDate: '1990-05-17',
    });
    expect(JSON.stringify(ok.body)).not.toContain(cpf);

    // No banco: só cifrado, o índice em hex, a data e a validação.
    const row = (await cpfRow(freelancer.id))!;
    expect(row.cpf_verified).toBe(1);
    expect(String(row.cpf_encrypted)).toMatch(/^enc:v1:[0-9a-f]{8}:/);
    expect(String(row.cpf_encrypted)).not.toContain(cpf);
    expect(String(row.cpf_index)).toMatch(/^[0-9a-f]{64}$/);
    expect(row.birth_date).toBe('1990-05-17');
    expect(row.cpf_verified_at).not.toBeNull();
    // A auditoria registra o fato, nunca o CPF.
    const [audits] = await pool.query<RowDataPacket[]>(
      `SELECT action, new_value FROM audit_logs WHERE user_id = :userId AND action = 'cpf_verified'`,
      { userId: freelancer.id },
    );
    expect(audits).toHaveLength(1);
    const [anyCpf] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE user_id = :userId
          AND (COALESCE(new_value, '') LIKE :cpf OR COALESCE(old_value, '') LIKE :cpf)`,
      { userId: freelancer.id, cpf: `%${cpf}%` },
    );
    expect(Number(anyCpf[0]!.n)).toBe(0);

    // Validado, não se altera pela tela.
    const again = await request(app)
      .put('/api/profiles/me/cpf')
      .set(auth(freelancer.token))
      .send({ cpf: uniqueCpf(), birthDate: '1990-05-17' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('cpf_locked');

    // Outra conta não usa o mesmo CPF.
    const other = await register('freelancer');
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(other.token))
      .send({ fullName: 'Outro Freela' })
      .expect(200);
    const dup = await request(app)
      .put('/api/profiles/me/cpf')
      .set(auth(other.token))
      .send({ cpf, birthDate: '1985-01-01' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('cpf_taken');
    // A chave única segura também quem escapasse da conferência.
    await expect(
      pool.query(`UPDATE profiles_freelancer SET cpf_index = :index WHERE user_id = :userId`, {
        index: row.cpf_index,
        userId: other.id,
      }),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });

    // Com o CPF validado, o saque passa.
    const paid = await withdraw(freelancer.token);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  });

  it('quem só contrata saca o que depositou sem CPF (decisão desta versão)', async () => {
    const client = await register('client');
    await verifyEmailOf(app, admin.token, client.id);
    await fundWallet(app, client.token, 100);

    const status = await request(app).get('/api/profiles/me/cpf').set(auth(client.token));
    expect(status.body).toMatchObject({ required: false, hasFreelancerProfile: false });
    const res = await withdraw(client.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('o atendimento vê só o CPF mascarado e o apaga para correção, com motivo e aviso; o titular informa de novo', async () => {
    const freelancer = await register('freelancer');
    const cpf = await verifyCpfOf(app, freelancer.token);

    const found = await request(app)
      .get(`/api/admin/users/lookup?email=${encodeURIComponent(freelancer.email)}`)
      .set(auth(admin.token));
    expect(found.status).toBe(200);
    expect(found.body.cpf).toMatchObject({
      verified: true,
      maskedCpf: `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`,
    });
    expect(JSON.stringify(found.body)).not.toContain(cpf);

    const reason = 'Titular digitou o CPF errado; documento conferido pelo suporte.';
    await request(app)
      .post(`/api/admin/users/${freelancer.ulid}/cpf/reset`)
      .set(auth(admin.token))
      .send({ reason })
      .expect(204);
    expect(await cpfRow(freelancer.id)).toMatchObject({
      cpf_verified: 0,
      cpf_encrypted: null,
      cpf_index: null,
      birth_date: null,
      cpf_verified_at: null,
    });
    const [actions] = await pool.query<RowDataPacket[]>(
      `SELECT description FROM admin_actions WHERE action = 'user_cpf_reset' AND target_id = :id`,
      { id: freelancer.id },
    );
    expect(actions.map((a) => a.description)).toEqual([reason]);
    const [mails] = await pool.query<RowDataPacket[]>(
      `SELECT subject, text_body FROM email_outbox WHERE user_id = :id ORDER BY id DESC LIMIT 1`,
      { id: freelancer.id },
    );
    expect(String(mails[0]!.text_body)).toContain('/perfil#dados-recebimento');
    expect(String(mails[0]!.text_body)).not.toContain(cpf);

    // Sem CPF, apagar de novo é 409; o titular informa o certo pela tela.
    await request(app)
      .post(`/api/admin/users/${freelancer.ulid}/cpf/reset`)
      .set(auth(admin.token))
      .send({ reason })
      .expect(409);
    await verifyCpfOf(app, freelancer.token, cpf);
  });

  it('LGPD: a cópia traz o CPF inteiro e a data; a anonimização apaga CPF, índice e data, e o CPF fica livre', async () => {
    const freelancer = await register('freelancer');
    const cpf = await verifyCpfOf(app, freelancer.token);

    const data = (await exportOf(freelancer.token)) as {
      formato: string;
      perfis: { freelancer: Record<string, unknown> };
    };
    expect(data.formato).toBe('escambo-export/1.15');
    expect(data.perfis.freelancer).toMatchObject({
      cpf,
      birth_date: '1990-05-17',
      cpf_verified: 1,
    });
    expect(data.perfis.freelancer).not.toHaveProperty('cpf_index');
    expect(data.perfis.freelancer).not.toHaveProperty('cpf_encrypted');

    await anonymize(freelancer, admin);
    expect(await cpfRow(freelancer.id)).toMatchObject({
      cpf_verified: 0,
      cpf_encrypted: null,
      cpf_index: null,
      birth_date: null,
    });
    // O mesmo titular, numa conta nova, pode usar o CPF de novo.
    const again = await register('freelancer');
    await verifyCpfOf(app, again.token, cpf);
  });
});

describe('conta de empresa (RF-018)', () => {
  it('cadastro com CNPJ alfanumérico único, perfil, página pública, LGPD e anonimização', async () => {
    const cnpj = uniqueCnpj();
    const company = await register('company', {
      company: {
        legalName: 'Padaria Pão Bom Ltda',
        tradeName: 'Pão Bom',
        cnpj: masked(cnpj).toLowerCase(),
      },
    });

    const me = await request(app).get('/api/auth/me').set(auth(company.token));
    expect(me.body.role).toBe('company');
    const mine = await request(app).get('/api/profiles/me').set(auth(company.token));
    expect(mine.body.company).toEqual({
      legalName: 'Padaria Pão Bom Ltda',
      tradeName: 'Pão Bom',
      cnpj,
      logoUrl: null,
      bio: null,
      website: null,
      city: null,
      state: null,
    });

    // O mesmo CNPJ não abre outra conta, e a conta que não nasceu não fica no banco.
    const email = `doc_company_dup_${stamp()}@escambo.test`;
    const dup = await request(app)
      .post('/api/auth/register')
      .send({
        legalAccepted: true,
        email,
        password: PASSWORD,
        role: 'company',
        company: { legalName: 'Outra Ltda', tradeName: 'Outra', cnpj },
      });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('cnpj_taken');
    const [ghost] = await pool.query<RowDataPacket[]>(`SELECT id FROM users WHERE email = :email`, {
      email,
    });
    expect(ghost).toHaveLength(0);

    // Logo, site e descrição curta pelo Perfil; conta de pessoa não grava dados de empresa.
    const logo = `/api/media/2026/10/01J8ZQ4K7M3VX5R2T9W6Y1B${String(seq).padStart(3, '0').slice(-3)}.webp`;
    const updated = await request(app).put('/api/profiles/company').set(auth(company.token)).send({
      legalName: 'Padaria Pão Bom Ltda',
      tradeName: 'Pão Bom',
      cnpj,
      logoUrl: logo,
      bio: 'Pães de fermentação natural desde 1998.',
      website: 'https://paobom.com.br',
      city: 'Joinville',
      state: 'sc',
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      logoUrl: logo,
      state: 'SC',
      website: 'https://paobom.com.br/',
    });
    // O logo segura o arquivo no expurgo de mídia (ADR 36).
    expect(await mediaRepository.listReferencedUrls()).toContain(logo);
    const client = await register('client');
    const forbidden = await request(app)
      .put('/api/profiles/company')
      .set(auth(client.token))
      .send({ legalName: 'Pessoa', tradeName: 'Pessoa', cnpj: uniqueCnpj() });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('not_company');

    const page = await request(app).get(`/api/profiles/company/${company.ulid}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      userUlid: company.ulid,
      tradeName: 'Pão Bom',
      legalName: 'Padaria Pão Bom Ltda',
      cnpj,
      city: 'Joinville',
    });
    await request(app).get(`/api/profiles/company/${client.ulid}`).expect(404);

    const data = (await exportOf(company.token)) as {
      perfis: { empresa: Record<string, unknown> };
    };
    expect(data.perfis.empresa).toMatchObject({
      razao_social: 'Padaria Pão Bom Ltda',
      nome_fantasia: 'Pão Bom',
      cnpj,
      website: 'https://paobom.com.br/',
    });

    await anonymize(company, admin);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT company_name, trade_name, cnpj, logo_url, bio, website, city FROM profiles_company
        WHERE user_id = :id`,
      { id: company.id },
    );
    expect(rows[0]).toEqual({
      company_name: 'Empresa removida',
      trade_name: 'Empresa removida',
      cnpj: null,
      logo_url: null,
      bio: null,
      website: null,
      city: null,
    });
    await request(app).get(`/api/profiles/company/${company.ulid}`).expect(404);
    // O CNPJ livre abre outra conta.
    await register('company', {
      company: { legalName: 'Padaria Pão Bom Ltda', tradeName: 'Pão Bom', cnpj },
    });
  });

  it('empresa contrata como o cliente: o freelancer vê o nome fantasia e o selo na contratação e na avaliação', async () => {
    const company = await register('company', {
      company: { legalName: 'Oficina Ltda', tradeName: 'Oficina Criativa', cnpj: uniqueCnpj() },
    });
    const person = await register('client');
    const freelancer = await register('freelancer');
    // Contratar, depositar e publicar pedem e-mail confirmado (RF-006, 1.52.0).
    for (const who of [company, person, freelancer]) await verifyEmailOf(app, admin.token, who.id);
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(freelancer.token))
      .send({ fullName: 'Freela da Empresa' })
      .expect(200);
    const cats = await request(app).get('/api/categories');
    const svc = await request(app)
      .post('/api/services')
      .set(auth(freelancer.token))
      .send({
        categoryId: cats.body[0].id,
        title: `Serviço para empresa ${stamp()}`,
        description: 'Serviço criado para o teste da conta de empresa',
        priceType: 'fixed',
        price: 150,
        deliveryDays: 3,
        isRemote: true,
      });
    expect(svc.status, JSON.stringify(svc.body)).toBe(201);

    const hire = async (client: Actor): Promise<number> => {
      await fundWallet(app, client.token, 200);
      const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
        freelancerId: freelancer.id,
        serviceId: svc.body.id,
        title: 'Trabalho para a empresa',
        description: 'Contratação do teste da conta de empresa',
        price: 150,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.id as number;
    };
    const byCompany = await hire(company);

    // O freelancer vê quem contrata na proposta (lista e detalhe).
    const detail = await request(app)
      .get(`/api/contracts/${byCompany}`)
      .set(auth(freelancer.token));
    expect(detail.body.clientCompany).toEqual({
      ulid: company.ulid,
      tradeName: 'Oficina Criativa',
    });
    const list = await request(app).get('/api/contracts').set(auth(freelancer.token));
    const listed = (list.body.items as { id: number; clientCompany: unknown }[]).find(
      (c) => c.id === byCompany,
    );
    expect(listed?.clientCompany).toEqual({ ulid: company.ulid, tradeName: 'Oficina Criativa' });

    // A empresa leva até o fim e avalia.
    for (const [who, action, body] of [
      [freelancer, 'accept', undefined],
      [freelancer, 'deliver', { message: 'Entregue.' }],
      [company, 'approve', undefined],
    ] as const) {
      const res = await request(app)
        .post(`/api/contracts/${byCompany}/${action}`)
        .set(auth(who.token))
        .send(body);
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    await request(app)
      .post('/api/reviews')
      .set(auth(company.token))
      .send({ contractId: byCompany, rating: 5, comment: 'Ótimo trabalho.' })
      .expect(201);

    // Contratação de pessoa: sem selo.
    const byPerson = await hire(person);
    const personal = await request(app)
      .get(`/api/contracts/${byPerson}`)
      .set(auth(freelancer.token));
    expect(personal.body.clientCompany).toBeNull();

    const reviews = await request(app).get(`/api/reviews?freelancerId=${freelancer.id}`);
    expect(reviews.status).toBe(200);
    expect(reviews.body.items[0]).toMatchObject({
      contractId: byCompany,
      reviewerCompany: { ulid: company.ulid, tradeName: 'Oficina Criativa' },
    });
  });
});
