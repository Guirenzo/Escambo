import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { ulid } from 'ulid';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { verifyCpfOf } from './cpf.helpers';
import { confirmEmail } from './mail.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * RF-006 e RN-004 contra o MySQL real: sem e-mail confirmado, contratar, publicar serviço,
 * depositar ou pagar, propor ou aceitar troca, impulsionar e sacar respondem 403
 * `email_not_verified`, com a mesma frase, e nada se move. Navegar, editar o perfil, responder ao
 * que já existe, suporte, LGPD e reenviar a confirmação continuam livres. Confirmado pelo link da
 * caixa de saída, tudo passa na requisição seguinte, sem novo login.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const NOT_VERIFIED = {
  error: 'email_not_verified',
  message: 'Confirme seu e-mail para continuar: abra o link que enviamos ou peça um novo.',
};

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  opts: { confirmed?: boolean; admin?: boolean } = {},
): Promise<Actor> {
  const domain = opts.admin ? 'admin.escambo.test' : 'escambo.test';
  const email = `int_email_ok_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  if (opts.confirmed) await confirmEmail(app, login.body.user.id);
  return { id: login.body.user.id, token: login.body.accessToken };
}

const balanceOf = async (token: string): Promise<number> =>
  Number((await request(app).get('/api/wallet').set(auth(token)).expect(200)).body.balance);

const countRows = async (sql: string, params: Record<string, unknown>): Promise<number> => {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return Number(rows[0]!.n);
};

/** Um serviço publicado antes da 1.52 por quem não confirmou o e-mail (o legado que a regra pega). */
async function legacyService(ownerId: number, active: boolean): Promise<number> {
  const [cats] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM service_categories ORDER BY id LIMIT 1',
  );
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO services (user_id, category_id, title, description, price_type, price, delivery_days,
                           is_remote, is_active)
     VALUES (:ownerId, :categoryId, :title, 'Serviço antigo de quem não confirmou o e-mail',
             'fixed', 200, 5, 1, :active)`,
    {
      ownerId,
      categoryId: cats[0]!.id,
      title: `Serviço legado ${ulid()}`,
      active: active ? 1 : 0,
    },
  );
  return res.insertId;
}

let categoryId = 0;
beforeAll(async () => {
  await request(app).get('/api/health').expect(200);
  categoryId = (await request(app).get('/api/categories').expect(200)).body[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe('RF-006: ações críticas sem e-mail confirmado', () => {
  it('depositar, contratar, publicar, propor troca, impulsionar e sacar: 403 com a mesma frase, e nada se move', async () => {
    const someone = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer', { confirmed: true });

    const attempts: [string, string, object][] = [
      ['post', '/api/wallet/deposits', { amount: 100, method: 'pix' }],
      [
        'post',
        '/api/contracts',
        {
          freelancerId: freelancer.id,
          title: 'Proposta sem e-mail',
          description: 'Não pode sair antes da confirmação',
          price: 100,
        },
      ],
      [
        'post',
        '/api/services',
        {
          categoryId,
          title: 'Serviço sem e-mail confirmado',
          description: 'Não pode ir ao ar antes da confirmação',
          priceType: 'fixed',
          price: 120,
          deliveryDays: 3,
        },
      ],
      [
        'post',
        '/api/barters',
        {
          receiverId: freelancer.id,
          offeredDescription: 'Fotos do evento',
          requestedDescription: 'Logo novo',
          estimatedValueOffered: 200,
          estimatedValueRequested: 200,
        },
      ],
      ['post', '/api/boosts', { serviceId: 1, planId: 1 }],
      ['post', '/api/withdrawals', { amount: 50, method: 'pix', pixKey: 'chave@escambo.test' }],
    ];
    for (const [, path, body] of attempts) {
      const res = await request(app).post(path).set(auth(someone.token)).send(body);
      expect(res.status, path).toBe(403);
      expect(res.body, path).toEqual(NOT_VERIFIED);
    }

    const by = { id: someone.id };
    expect(await countRows('SELECT COUNT(*) AS n FROM payments WHERE payer_id = :id', by)).toBe(0);
    expect(await countRows('SELECT COUNT(*) AS n FROM contracts WHERE client_id = :id', by)).toBe(
      0,
    );
    expect(await countRows('SELECT COUNT(*) AS n FROM services WHERE user_id = :id', by)).toBe(0);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM barter_agreements WHERE proposer_id = :id', by),
    ).toBe(0);
    expect(await countRows('SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = :id', by)).toBe(
      0,
    );
  });

  it('o resto continua livre: navegar, editar o perfil, suporte, LGPD e reenviar a confirmação', async () => {
    const someone = await registerAndLogin('client');
    const h = auth(someone.token);
    await request(app).get('/api/services').expect(200);
    await request(app).get('/api/contracts').set(h).expect(200);
    await request(app).get('/api/wallet').set(h).expect(200);
    await request(app)
      .put('/api/profiles/client')
      .set(h)
      .send({ fullName: 'Bia Sem Confirmar', city: 'Joinville' })
      .expect(200);
    await request(app)
      .post('/api/support/tickets')
      .set(h)
      .send({
        category: 'account',
        subject: 'Não recebi o e-mail',
        description: 'O link de confirmação não chegou na minha caixa de entrada.',
      })
      .expect(201);
    await request(app).post('/api/lgpd/export-requests').set(h).send({}).expect(201);
    await request(app).post('/api/auth/resend-verification').set(h).expect(202);
    const me = await request(app).get('/api/auth/me').set(h).expect(200);
    expect(me.body).toMatchObject({ emailVerified: false, status: 'pending_verification' });
  });

  it('confirmado pelo link da caixa de saída, a requisição seguinte passa, sem novo login', async () => {
    const someone = await registerAndLogin('client');
    await request(app)
      .post('/api/wallet/deposits')
      .set(auth(someone.token))
      .send({ amount: 100, method: 'pix' })
      .expect(403);
    await confirmEmail(app, someone.id);
    await fundWallet(app, someone.token, 100);
    expect(await balanceOf(someone.token)).toBe(100);
  });

  it('quem não confirmou recebe a proposta, entrega e é pago; o saque espera a confirmação', async () => {
    const client = await registerAndLogin('client', { confirmed: true });
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);
    // Proposta direta: quem não confirmou não publica, mas pode ser contratado.
    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Direta para quem não confirmou',
        description: 'Responder ao que já existe continua livre',
        price: 200,
      })
      .expect(201);
    const id = created.body.id as number;
    // Responder ao que já existe: aceitar e entregar continuam livres.
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    await request(app)
      .post(`/api/contracts/${id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Pronto.' })
      .expect(200);
    await request(app).post(`/api/contracts/${id}/approve`).set(auth(client.token)).expect(200);
    const earned = await balanceOf(freelancer.token);
    expect(earned).toBeGreaterThan(0);

    const pix = { amount: 50, method: 'pix', pixKey: 'chave-do-freela@escambo.test' };
    const locked = await request(app)
      .post('/api/withdrawals')
      .set(auth(freelancer.token))
      .send(pix)
      .expect(403);
    expect(locked.body).toEqual(NOT_VERIFIED);
    expect(await balanceOf(freelancer.token)).toBe(earned);

    await confirmEmail(app, freelancer.id);
    await verifyCpfOf(app, freelancer.token); // e o CPF validado de quem entrega trabalho (RF-020, 1.53.0)
    await request(app).post('/api/withdrawals').set(auth(freelancer.token)).send(pix).expect(201);
  });

  it('troca recebida sem confirmar: aceitar é 403; recusar continua livre', async () => {
    const proposer = await registerAndLogin('freelancer', { confirmed: true });
    const receiver = await registerAndLogin('freelancer');
    const proposed = await request(app)
      .post('/api/barters')
      .set(auth(proposer.token))
      .send({
        receiverId: receiver.id,
        offeredDescription: 'Sessão de fotos',
        requestedDescription: 'Identidade visual',
        estimatedValueOffered: 300,
        estimatedValueRequested: 300,
      })
      .expect(201);
    const accept = await request(app)
      .post(`/api/barters/${proposed.body.id}/accept`)
      .set(auth(receiver.token))
      .expect(403);
    expect(accept.body).toEqual(NOT_VERIFIED);
    await request(app)
      .post(`/api/barters/${proposed.body.id}/reject`)
      .set(auth(receiver.token))
      .expect(204);
  });

  it('serviço antigo de quem não confirmou: pausar e editar passam; reativar é publicar e espera a confirmação', async () => {
    const owner = await registerAndLogin('freelancer');
    const id = await legacyService(owner.id, true);
    const h = auth(owner.token);
    await request(app)
      .patch(`/api/services/${id}`)
      .set(h)
      .send({ title: 'Serviço legado editado' })
      .expect(200);
    await request(app).patch(`/api/services/${id}`).set(h).send({ isActive: false }).expect(200);
    const reactivate = await request(app)
      .patch(`/api/services/${id}`)
      .set(h)
      .send({ isActive: true })
      .expect(403);
    expect(reactivate.body).toEqual(NOT_VERIFIED);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT is_active FROM services WHERE id = :id',
      { id },
    );
    expect(Number(rows[0]!.is_active)).toBe(0);

    await confirmEmail(app, owner.id);
    await request(app).patch(`/api/services/${id}`).set(h).send({ isActive: true }).expect(200);
  });

  it('o admin segue a mesma regra como usuário, mas age como equipe sem ela', async () => {
    const admin = await registerAndLogin('client', { admin: true });
    const freelancer = await registerAndLogin('freelancer', { confirmed: true });
    // Como equipe: a caixa de saída e as filas do painel.
    await request(app)
      .get(`/api/admin/emails?userId=${freelancer.id}&limit=5`)
      .set(auth(admin.token))
      .expect(200);
    await request(app).get('/api/admin/withdrawals').set(auth(admin.token)).expect(200);
    // Como usuário: depositar espera a confirmação, como para qualquer um.
    const res = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(admin.token))
      .send({ amount: 100, method: 'pix' })
      .expect(403);
    expect(res.body).toEqual(NOT_VERIFIED);
  });
});
