import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { waitForNotification } from './notifications.helpers';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
  email: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, `register ${role}: ${JSON.stringify(reg.body)}`).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, `login ${role}: ${JSON.stringify(login.body)}`).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken, email };
}

/** Serviço publicado pelo freelancer pela API, na primeira categoria do catálogo. */
async function createService(owner: Actor, title: string): Promise<number> {
  const cats = await request(app).get('/api/categories');
  const res = await request(app).post('/api/services').set(auth(owner.token)).send({
    categoryId: cats.body[0].id,
    title,
    description: 'Serviço criado pelo teste de integração da contratação',
    priceType: 'fixed',
    price: 300,
    deliveryDays: 5,
    isRemote: true,
  });
  expect(res.status, `serviço: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.id as number;
}

/** Quantas contratações o cliente tem gravadas, direto no banco. */
async function contractsOf(clientId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM contracts WHERE client_id = :clientId',
    { clientId },
  );
  return Number(rows[0]!.n);
}

/** Quantos avisos de proposta o freelancer recebeu, direto no banco. */
async function proposalNotices(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = :userId AND type = 'contract_proposal'",
    { userId },
  );
  return Number(rows[0]!.n);
}

// Sanidade: o banco de teste está no ar antes de rodar a suíte.
beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status, 'API /health deve responder com o banco de teste no ar').toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Fluxo de contratação cash + escrow (ponta a ponta)', () => {
  it('create → accept → deliver → approve libera o escrow e concede XP', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    // Carteira pré-paga: o cliente deposita R$ 1000 (PIX simulado) antes de contratar.
    await fundWallet(app, client.token, 1000);

    // Saldo inicial do freelancer zerado.
    const w0 = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(w0.status).toBe(200);
    expect(w0.body).toMatchObject({ balance: 0, balancePending: 0 });

    // Cliente contrata: price 1000 → fee 150 (15%), net 850.
    const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Landing page institucional',
      description: 'Página one-page responsiva com formulário de contato',
      price: 1000,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const contractId = created.body.id as number;
    expect(created.body).toMatchObject({ status: 'pending', platformFee: 150, freelancerNet: 850 });
    // O valor da proposta sai do disponível do cliente e fica reservado (nada vai ao freelancer ainda).
    const c0 = await request(app).get('/api/wallet').set(auth(client.token));
    expect(c0.body).toMatchObject({ balance: 0, balancePending: 1000 });

    // Freelancer aceita → valor líquido entra em escrow (balance_pending).
    const acc = await request(app)
      .post(`/api/contracts/${contractId}/accept`)
      .set(auth(freelancer.token));
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.status).toBe('accepted');
    const w1 = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(w1.body).toMatchObject({ balance: 0, balancePending: 850 });
    // A reserva do cliente pagou a contratação: 850 em escrow do freelancer, 150 de taxa.
    const c1 = await request(app).get('/api/wallet').set(auth(client.token));
    expect(c1.body).toMatchObject({ balance: 0, balancePending: 0 });
    const ledger = await request(app).get('/api/wallet/transactions').set(auth(client.token));
    expect(ledger.body.items.map((t: { reason: string }) => t.reason)).toEqual([
      'payment',
      'hold',
      'deposit',
    ]);

    // Freelancer entrega.
    const del = await request(app)
      .post(`/api/contracts/${contractId}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Entrega final — arquivos e deploy no ar.' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.status).toBe('delivered');

    // Cliente aprova → escrow liberado (pending → balance) + XP de conclusão.
    const approved = await request(app)
      .post(`/api/contracts/${contractId}/approve`)
      .set(auth(client.token));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('completed');
    const w2 = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(w2.body).toMatchObject({ balance: 850, balancePending: 0 });

    // Gamificação: o freelancer ganhou XP pela conclusão.
    const gam = await request(app).get('/api/gamification/me').set(auth(freelancer.token));
    expect(gam.status).toBe(200);
    expect(gam.body.totalXp).toBeGreaterThan(0);

    // O histórico registra a transição até 'completed'.
    const detail = await request(app).get(`/api/contracts/${contractId}`).set(auth(client.token));
    expect(detail.status).toBe(200);
    const statuses = (detail.body.history as { status: string }[]).map((h) => h.status);
    expect(statuses).toContain('completed');
  });

  it('cancelar após o aceite estorna o escrow retido', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 500);

    const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'App mobile MVP',
      description: 'MVP com login social e listagem paginada',
      price: 500,
    });
    const id = created.body.id as number;

    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    const wA = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wA.body.balancePending).toBe(425); // 500 − 15%

    const cancel = await request(app).post(`/api/contracts/${id}/cancel`).set(auth(client.token));
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe('cancelled');

    // Sem prazo, o cancelamento após o aceite devolve 50% (RN-025): o cliente recebe 250
    // (metade do preço) e o freelancer fica com 212,50 (metade do líquido); nada fica retido.
    const wB = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wB.body).toMatchObject({ balance: 212.5, balancePending: 0 });
    const cB = await request(app).get('/api/wallet').set(auth(client.token));
    expect(cB.body).toMatchObject({ balance: 250, balancePending: 0 });
  });

  it('impõe autorização e autenticação nas transições', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const outsider = await registerAndLogin('client');
    await fundWallet(app, client.token, 300);

    const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Consultoria SEO',
      description: 'Auditoria técnica e plano de ação de SEO',
      price: 300,
    });
    const id = created.body.id as number;

    // Cliente não pode aceitar (ação exclusiva do freelancer).
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(client.token)).expect(403);
    // Terceiro não participa → não enxerga o contrato.
    await request(app).get(`/api/contracts/${id}`).set(auth(outsider.token)).expect(403);
    // Sem token → 401.
    await request(app).get(`/api/contracts/${id}`).expect(401);
  });

  it('serviço pausado não aceita proposta pela API (RN-013): 409, nada reservado nem gravado; de volta ao ar, aceita', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);
    const serviceId = await createService(freelancer, 'Identidade visual pausada');
    await request(app)
      .patch(`/api/services/${serviceId}`)
      .set(auth(freelancer.token))
      .send({ isActive: false })
      .expect(200);

    const proposal = {
      freelancerId: freelancer.id,
      serviceId,
      title: 'Identidade visual',
      description: 'Logo, paleta de cores e manual da marca',
      price: 300,
    };
    const paused = await request(app).post('/api/contracts').set(auth(client.token)).send(proposal);
    expect(paused.status, JSON.stringify(paused.body)).toBe(409);
    expect(paused.body).toEqual({
      error: 'service_inactive',
      message: 'Este serviço está pausado e não aceita novas propostas (RN-013).',
    });
    // Nada saiu do saldo do cliente, nenhuma contratação foi gravada e o freelancer não recebeu
    // proposta.
    const w = await request(app).get('/api/wallet').set(auth(client.token));
    expect(w.body).toMatchObject({ balance: 300, balancePending: 0 });
    expect(await contractsOf(client.id)).toBe(0);
    expect(await proposalNotices(freelancer.id)).toBe(0);

    // O freelancer põe o serviço no ar de novo: a mesma proposta passa, ligada ao serviço.
    await request(app)
      .patch(`/api/services/${serviceId}`)
      .set(auth(freelancer.token))
      .send({ isActive: true })
      .expect(200);
    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send(proposal);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      status: 'pending',
      serviceId,
      freelancerId: freelancer.id,
    });
    expect(await contractsOf(client.id)).toBe(1);
    expect(await waitForNotification(app, freelancer.token, 'contract_proposal')).toBe(true);
  });

  it('freelancer inexistente, suspenso ou banido, e serviço removido ou de outra pessoa: 404, sem gravar nem reservar', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const other = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);
    const base = {
      title: 'Consultoria de marca',
      description: 'Diagnóstico da marca e plano de posicionamento',
      price: 300,
    };
    const propose = (body: Record<string, unknown>) =>
      request(app)
        .post('/api/contracts')
        .set(auth(client.token))
        .send({ ...base, ...body });

    // Id que não é de ninguém: antes caía na FK e virava 500 (ADR 60).
    const [[maxRow]] = await pool.query<RowDataPacket[]>('SELECT MAX(id) AS id FROM users');
    const nobody = await propose({ freelancerId: Number(maxRow!.id) + 1000 });
    expect(nobody.status, JSON.stringify(nobody.body)).toBe(404);
    expect(nobody.body).toEqual({
      error: 'freelancer_not_found',
      message: 'Freelancer não encontrado',
    });

    // Serviço de outra pessoa, mesmo no ar, não entra na proposta para este freelancer.
    const othersService = await createService(other, 'Serviço de outra pessoa');
    const notHis = await propose({ freelancerId: freelancer.id, serviceId: othersService });
    expect(notHis.status, JSON.stringify(notHis.body)).toBe(404);
    expect(notHis.body).toEqual({ error: 'service_not_found', message: 'Serviço não encontrado' });

    // Serviço que o próprio freelancer removeu.
    const removed = await createService(freelancer, 'Serviço removido');
    await request(app).delete(`/api/services/${removed}`).set(auth(freelancer.token)).expect(204);
    const gone = await propose({ freelancerId: freelancer.id, serviceId: removed });
    expect(gone.status, JSON.stringify(gone.body)).toBe(404);
    expect(gone.body.error).toBe('service_not_found');

    // Conta suspensa ou banida pela moderação não recebe proposta.
    for (const status of ['suspended', 'banned']) {
      await pool.query('UPDATE users SET status = :status WHERE id = :id', {
        status,
        id: freelancer.id,
      });
      const blocked = await propose({ freelancerId: freelancer.id });
      expect(blocked.status, `${status}: ${JSON.stringify(blocked.body)}`).toBe(404);
      expect(blocked.body.error).toBe('freelancer_not_found');
    }

    const w = await request(app).get('/api/wallet').set(auth(client.token));
    expect(w.body).toMatchObject({ balance: 300, balancePending: 0 });
    expect(await contractsOf(client.id)).toBe(0);
    expect(await proposalNotices(freelancer.id)).toBe(0);
  });

  it('valor com fração de centavo é 422 e o saldo não muda; com centavos, criar e cancelar devolve exatamente o reservado', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 20);
    const proposal = {
      freelancerId: freelancer.id,
      title: 'Revisão de texto',
      description: 'Revisão ortográfica de um artigo de duas páginas',
    };

    // 10,005 gravava 10,01 na contratação, reservava 10,00 do saldo e o cancelamento devolvia
    // 10,01: um centavo criado a cada ciclo.
    for (const price of [10.005, 150.001]) {
      const res = await request(app)
        .post('/api/contracts')
        .set(auth(client.token))
        .send({ ...proposal, price });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toEqual({
        price: ['O valor vai até os centavos: no máximo duas casas decimais'],
      });
    }
    expect((await request(app).get('/api/wallet').set(auth(client.token))).body).toMatchObject({
      balance: 20,
      balancePending: 0,
    });
    expect(await contractsOf(client.id)).toBe(0);

    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({ ...proposal, price: 10.01 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.price).toBe(10.01);
    expect((await request(app).get('/api/wallet').set(auth(client.token))).body).toMatchObject({
      balance: 9.99,
      balancePending: 10.01,
    });
    await request(app)
      .post(`/api/contracts/${created.body.id}/cancel`)
      .set(auth(client.token))
      .expect(200);
    expect((await request(app).get('/api/wallet').set(auth(client.token))).body).toMatchObject({
      balance: 20,
      balancePending: 0,
    });
  });

  it('só freelancer de verdade recebe proposta: admin e cliente sem perfil são 404; cliente com perfil ou dono do serviço, não', async () => {
    const client = await registerAndLogin('client');
    await fundWallet(app, client.token, 1000);
    const base = {
      title: 'Planilha de custos',
      description: 'Planilha de custos com fórmulas e um painel de resumo',
      price: 100,
    };
    const propose = (body: Record<string, unknown>) =>
      request(app)
        .post('/api/contracts')
        .set(auth(client.token))
        .send({ ...base, ...body });

    // Conta de admin (ADMIN_EMAILS): mediaria a disputa da própria contratação, mesmo pelo serviço.
    const adminEmail = `int_admin_${Date.now()}_${seq++}@admin.escambo.test`;
    await request(app)
      .post('/api/auth/register')
      .send({ legalAccepted: true, email: adminEmail, password: 'senha-integracao-123' })
      .expect(201);
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: adminEmail, password: 'senha-integracao-123' })
      .expect(200);
    const admin: Actor = {
      id: adminLogin.body.user.id,
      token: adminLogin.body.accessToken,
      email: adminEmail,
    };
    expect(adminLogin.body.user.role).toBe('admin');
    const adminService = await createService(admin, 'Serviço publicado pelo admin');
    for (const serviceId of [undefined, adminService]) {
      const res = await propose({ freelancerId: admin.id, serviceId });
      expect(res.status, `admin ${serviceId}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body).toEqual({
        error: 'freelancer_not_found',
        message: 'Freelancer não encontrado',
      });
    }

    // Outra conta de cliente, sem perfil de freelancer: proposta direta não vai.
    const other = await registerAndLogin('client');
    const direct = await propose({ freelancerId: other.id });
    expect(direct.status, JSON.stringify(direct.body)).toBe(404);
    expect(direct.body.error).toBe('freelancer_not_found');
    expect(await contractsOf(client.id)).toBe(0);
    expect(await proposalNotices(other.id)).toBe(0);
    expect(await proposalNotices(admin.id)).toBe(0);
    expect((await request(app).get('/api/wallet').set(auth(client.token))).body).toMatchObject({
      balance: 1000,
      balancePending: 0,
    });

    // A mesma conta publica um serviço (não exige perfil): pelo serviço, a proposta passa.
    const othersService = await createService(other, 'Serviço de quem se cadastrou cliente');
    const byService = await propose({ freelancerId: other.id, serviceId: othersService });
    expect(byService.status, JSON.stringify(byService.body)).toBe(201);
    expect(byService.body).toMatchObject({ freelancerId: other.id, serviceId: othersService });

    // Cliente que também é freelancer (RN-006): com o perfil, recebe a proposta direta.
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(other.token))
      .send({ fullName: 'Cliente e Freela', city: 'Joinville', isAvailable: true })
      .expect(200);
    const withProfile = await propose({ freelancerId: other.id });
    expect(withProfile.status, JSON.stringify(withProfile.body)).toBe(201);
    expect(withProfile.body).toMatchObject({ freelancerId: other.id, serviceId: null });
    expect(await contractsOf(client.id)).toBe(2);
  });

  it('rejeita contratar a si mesmo (RN self_contract)', async () => {
    const freelancer = await registerAndLogin('freelancer');
    const res = await request(app).post('/api/contracts').set(auth(freelancer.token)).send({
      freelancerId: freelancer.id,
      title: 'Serviço para mim mesmo',
      description: 'Não deveria ser permitido pela regra de negócio',
      price: 100,
    });
    expect(res.status).toBe(400);
  });
});
