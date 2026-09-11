import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runExpireProposals } from '../../src/jobs/expire-proposals';
import { runOverdueContracts } from '../../src/jobs/overdue-contracts';
import { waitForNotification } from './notifications.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Prazos de ponta a ponta contra o MySQL real:
 *  - RN-021: proposta parada expira pelo job, a reserva volta ao cliente e os dois são avisados;
 *  - RN-028: o freelancer pede extensão (uma vez), o cliente recusa/aceita, o prazo muda;
 *  - RN-029: prazo estourado → aviso às duas partes → carência → disputa aberta pela plataforma,
 *    com um pedido de extensão pendente segurando o job.
 * O tempo é "andado" direto no banco (created_at / deadline_at / overdue_notified_at).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const DAY = 86_400_000;
/** Data daqui a `n` dias, sem milissegundos (DATETIME do MySQL guarda até o segundo). */
const inDays = (n: number): string => {
  const d = new Date(Date.now() + n * DAY);
  d.setMilliseconds(0);
  return d.toISOString();
};

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_dl_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

const contract = async (id: number, token: string) =>
  (await request(app).get(`/api/contracts/${id}`).set(auth(token))).body as {
    status: string;
    deadlineAt: string | null;
    deadlineExtendedAt: string | null;
    overdueNotifiedAt: string | null;
    extension: { status: string; deadlineAt: string; reason: string } | null;
    history: { status: string; note: string | null }[];
  };

const wallet = async (token: string) =>
  (await request(app).get('/api/wallet').set(auth(token))).body as {
    balance: number;
    balancePending: number;
  };

async function propose(
  client: Actor,
  freelancer: Actor,
  price: number,
  deadlineAt: string | null,
): Promise<number> {
  const res = await request(app).post('/api/contracts').set(auth(client.token)).send({
    freelancerId: freelancer.id,
    title: 'Vídeo institucional',
    description: 'Roteiro, captação e edição do vídeo da empresa',
    price,
    deadlineAt,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Prazos: expiração da proposta, extensão única e disputa automática', () => {
  it('RN-021: proposta sem resposta expira pelo job e a reserva volta ao cliente', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 150);
    const id = await propose(client, freelancer, 100, null);
    expect(await wallet(client.token)).toMatchObject({ balance: 50, balancePending: 100 });

    // Ainda dentro do prazo de resposta: o job não mexe.
    expect((await runExpireProposals()).expired).not.toContain(id);

    await pool.query(
      `UPDATE contracts SET created_at = DATE_SUB(NOW(), INTERVAL 80 HOUR) WHERE id = :id`,
      { id },
    );
    const result = await runExpireProposals();
    expect(result.hours).toBe(72); // platform_settings.proposal_expiry_hours (seed)
    expect(result.expired).toContain(id);

    const c = await contract(id, client.token);
    expect(c.status).toBe('cancelled');
    expect(c.history.at(-1)?.note).toContain('RN-021');
    expect(await wallet(client.token)).toMatchObject({ balance: 150, balancePending: 0 });
    expect(await waitForNotification(app, client.token, 'contract_expired')).toBe(true);
    expect(await waitForNotification(app, freelancer.token, 'contract_expired')).toBe(true);

    // Idempotente: não expira de novo.
    expect((await runExpireProposals()).expired).not.toContain(id);
  });

  it('RN-028: extensão pedida pelo freelancer, recusada e depois aceita; a segunda é barrada', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);
    const id = await propose(client, freelancer, 300, inDays(5));
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);

    const askFor = (token: string, deadlineAt: string) =>
      request(app)
        .post(`/api/contracts/${id}/extension`)
        .set(auth(token))
        .send({ deadlineAt, reason: 'O material do cliente chegou depois do combinado' });

    // Cliente não pede; prazo menor que o atual é inválido; prazo válido cria o pedido.
    await askFor(client.token, inDays(12)).expect(403);
    const bad = await askFor(freelancer.token, inDays(2));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_deadline');
    const asked = await askFor(freelancer.token, inDays(12));
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.extension).toMatchObject({ status: 'pending' });
    const pendingAgain = await askFor(freelancer.token, inDays(14));
    expect(pendingAgain.body.error).toBe('extension_pending');
    expect(await waitForNotification(app, client.token, 'deadline_extension_requested')).toBe(true);

    // Freelancer não decide; cliente recusa → prazo original continua.
    await request(app)
      .post(`/api/contracts/${id}/extension/accept`)
      .set(auth(freelancer.token))
      .expect(403);
    const declined = await request(app)
      .post(`/api/contracts/${id}/extension/decline`)
      .set(auth(client.token));
    expect(declined.status).toBe(200);
    expect(declined.body.extension.status).toBe('declined');
    expect(declined.body.deadlineExtendedAt).toBeNull();
    expect(await waitForNotification(app, freelancer.token, 'deadline_extension_declined')).toBe(
      true,
    );

    // Novo pedido (a recusa não gasta a extensão) → aceito → prazo muda, uma vez só.
    const newDeadline = inDays(10);
    await askFor(freelancer.token, newDeadline).expect(200);
    const accepted = await request(app)
      .post(`/api/contracts/${id}/extension/accept`)
      .set(auth(client.token));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.deadlineAt).toBe(new Date(newDeadline).toISOString());
    expect(accepted.body.deadlineExtendedAt).not.toBeNull();
    expect(accepted.body.extension.status).toBe('accepted');
    expect(await waitForNotification(app, freelancer.token, 'deadline_extension_accepted')).toBe(
      true,
    );
    const c = await contract(id, client.token);
    expect(c.history.at(-1)?.note).toContain('Prazo estendido de');
    await request(app)
      .post(`/api/contracts/${id}/extension/accept`)
      .set(auth(client.token))
      .expect(409);

    const third = await askFor(freelancer.token, inDays(20));
    expect(third.status).toBe(409);
    expect(third.body.error).toBe('extension_used');
  });

  it('RN-029: prazo estourado avisa uma vez; passada a carência, a plataforma abre a disputa', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    await fundWallet(app, client.token, 200);
    const id = await propose(client, freelancer, 200, inDays(2));
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);

    // Dentro do prazo: nada acontece.
    expect((await runOverdueContracts()).notified).not.toContain(id);

    // Prazo vencido, mas com pedido de extensão pendente: o job segura (a decisão é do cliente).
    await pool.query(
      `UPDATE contracts SET deadline_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id = :id`,
      { id },
    );
    await request(app)
      .post(`/api/contracts/${id}/extension`)
      .set(auth(freelancer.token))
      .send({ deadlineAt: inDays(5), reason: 'Preciso de mais alguns dias para finalizar' })
      .expect(200);
    expect((await runOverdueContracts()).notified).not.toContain(id);

    // Cliente recusa → fase 1: aviso às duas partes, uma vez só.
    await request(app)
      .post(`/api/contracts/${id}/extension/decline`)
      .set(auth(client.token))
      .expect(200);
    const first = await runOverdueContracts();
    expect(first.graceHours).toBe(24); // platform_settings.deadline_grace_hours (seed)
    expect(first.notified).toContain(id);
    expect(first.disputed).not.toContain(id);
    expect((await contract(id, client.token)).overdueNotifiedAt).not.toBeNull();
    expect(await waitForNotification(app, client.token, 'contract_overdue')).toBe(true);
    expect(await waitForNotification(app, freelancer.token, 'contract_overdue')).toBe(true);
    expect((await runOverdueContracts()).notified).not.toContain(id);

    // Fase 2: carência vencida sem entrega → disputa por prazo, contrato congelado, admin vê.
    await pool.query(
      `UPDATE contracts SET overdue_notified_at = DATE_SUB(NOW(), INTERVAL 30 HOUR) WHERE id = :id`,
      { id },
    );
    const second = await runOverdueContracts();
    expect(second.disputed).toContain(id);
    expect((await contract(id, client.token)).status).toBe('disputed');
    expect(await waitForNotification(app, freelancer.token, 'dispute_opened')).toBe(true);
    const queue = await request(app).get('/api/admin/disputes').set(auth(admin.token));
    expect(queue.status).toBe(200);
    const mine = (queue.body as { contractId: number; reason: string; description: string }[]).find(
      (d) => d.contractId === id,
    );
    expect(mine).toBeDefined();
    expect(mine?.reason).toBe('deadline');
    expect(mine?.description).toContain('RN-029');

    // Não abre uma segunda disputa.
    expect((await runOverdueContracts()).disputed).not.toContain(id);
  });
});
