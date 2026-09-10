import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runTacitApproval } from '../../src/jobs/tacit-approval';
import { waitForNotification } from './notifications.helpers';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_ms_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

const wallet = async (token: string) =>
  (await request(app).get('/api/wallet').set(auth(token))).body as {
    balance: number;
    balancePending: number;
  };

const MILESTONES = [
  { title: 'Layout', amount: 333.33 },
  { title: 'Front-end', amount: 333.33 },
  { title: 'Deploy', amount: 333.34 },
];

async function proposeWithMilestones(client: Actor, freelancer: Actor) {
  const res = await request(app).post('/api/contracts').set(auth(client.token)).send({
    freelancerId: freelancer.id,
    title: 'Site em 3 etapas',
    description: 'Projeto longo dividido em marcos (RN-069)',
    price: 1000,
    milestones: MILESTONES,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; hasMilestones: boolean };
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Escrow por marcos (RN-069)', () => {
  it('validação: soma diferente do valor, menos de 2 marcos ou em créditos são recusados', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 1000);
    const base = {
      freelancerId: freelancer.id,
      title: 'Marcos inválidos',
      description: 'Contratação do teste de validação de marcos',
      price: 1000,
    };
    await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        ...base,
        milestones: [
          { title: 'A', amount: 500 },
          { title: 'B', amount: 400 },
        ],
      })
      .expect(422);
    await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({ ...base, milestones: [{ title: 'Único', amount: 1000 }] })
      .expect(422);
    await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        ...base,
        paymentMode: 'credits',
        price: 40,
        milestones: [
          { title: 'A', amount: 20 },
          { title: 'B', amount: 20 },
        ],
      })
      .expect(422);
  });

  it('marcos financiados no aceite; cada aprovação libera só a própria parte; o último conclui', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 1000);

    const created = await proposeWithMilestones(client, freelancer);
    expect(created.hasMilestones).toBe(true);
    const id = created.id;
    const detail0 = await request(app).get(`/api/contracts/${id}`).set(auth(client.token));
    expect(detail0.body.milestones.map((m: { status: string }) => m.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(detail0.body.milestones.map((m: { freelancerNet: number }) => m.freelancerNet)).toEqual([
      283.33, 283.33, 283.34,
    ]);

    // Aceite: 850 em escrow do freelancer, marcos financiados.
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    expect(await wallet(freelancer.token)).toMatchObject({ balance: 0, balancePending: 850 });
    const detail1 = await request(app).get(`/api/contracts/${id}`).set(auth(freelancer.token));
    const [m1, m2, m3] = detail1.body.milestones as { id: number; status: string }[];
    expect([m1!.status, m2!.status, m3!.status]).toEqual(['funded', 'funded', 'funded']);

    // Entrega/aprovação únicas não valem para contrato por marcos.
    await request(app)
      .post(`/api/contracts/${id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'tudo' })
      .expect(409);

    // Marco 1: freelancer entrega (contrato vai a in_progress), cliente aprova → 283,33 liberados.
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m1!.id}/approve`)
      .set(auth(client.token))
      .expect(409); // ainda não entregue
    const del1 = await request(app)
      .post(`/api/contracts/${id}/milestones/${m1!.id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Layout no Figma' });
    expect(del1.status, JSON.stringify(del1.body)).toBe(200);
    expect(del1.body.status).toBe('in_progress');
    expect(del1.body.milestones[0]).toMatchObject({
      status: 'delivered',
      deliveryNote: 'Layout no Figma',
    });
    expect(await waitForNotification(app, client.token, 'milestone_delivered')).toBe(true);
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m1!.id}/approve`)
      .set(auth(freelancer.token))
      .expect(403);
    const ok1 = await request(app)
      .post(`/api/contracts/${id}/milestones/${m1!.id}/approve`)
      .set(auth(client.token));
    expect(ok1.status, JSON.stringify(ok1.body)).toBe(200);
    expect(ok1.body.status).toBe('in_progress');
    expect(ok1.body.milestones[0].status).toBe('released');
    expect(await wallet(freelancer.token)).toMatchObject({
      balance: 283.33,
      balancePending: 566.67,
    });
    expect(await waitForNotification(app, freelancer.token, 'milestone_approved')).toBe(true);

    // Marco 2: entrega → revisão pedida (volta a funded) → entrega de novo → aprovação.
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m2!.id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Front pronto' })
      .expect(200);
    const rev = await request(app)
      .post(`/api/contracts/${id}/milestones/${m2!.id}/request-revision`)
      .set(auth(client.token))
      .send({ note: 'Falta o menu mobile' });
    expect(rev.status).toBe(200);
    expect(rev.body.milestones[1]).toMatchObject({
      status: 'funded',
      revisionNote: 'Falta o menu mobile',
    });
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m2!.id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Menu mobile feito' })
      .expect(200);
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m2!.id}/approve`)
      .set(auth(client.token))
      .expect(200);
    expect(await wallet(freelancer.token)).toMatchObject({
      balance: 566.66,
      balancePending: 283.34,
    });

    // Marco 3: último → contrato concluído, escrow zerado, XP, notificação de conclusão.
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m3!.id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'No ar' })
      .expect(200);
    const done = await request(app)
      .post(`/api/contracts/${id}/milestones/${m3!.id}/approve`)
      .set(auth(client.token));
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(await wallet(freelancer.token)).toMatchObject({ balance: 850, balancePending: 0 });
    const gam = await request(app).get('/api/gamification/me').set(auth(freelancer.token));
    expect(gam.body.totalXp).toBeGreaterThan(0);
    expect(await waitForNotification(app, freelancer.token, 'contract_completed')).toBe(true);
    const ledger = await request(app).get('/api/wallet/transactions').set(auth(freelancer.token));
    expect(
      ledger.body.items.filter((t: { reason: string }) => t.reason === 'escrow_release'),
    ).toHaveLength(3);
  });

  it('cancelar no meio liquida só o que não foi liberado; aprovação tácita de marco pelo job', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 1000);
    const { id } = await proposeWithMilestones(client, freelancer);
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    const detail = await request(app).get(`/api/contracts/${id}`).set(auth(client.token));
    const [m1, m2] = detail.body.milestones as { id: number }[];

    // Marco 1 entregue e sem resposta há 6 dias → o job aprova em nome do cliente.
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m1!.id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Layout' })
      .expect(200);
    await pool.query(
      `UPDATE contract_milestones SET delivered_at = DATE_SUB(NOW(), INTERVAL 6 DAY) WHERE id = :id`,
      { id: m1!.id },
    );
    const job = await runTacitApproval();
    expect(job.milestones).toContain(m1!.id);
    expect(await wallet(freelancer.token)).toMatchObject({
      balance: 283.33,
      balancePending: 566.67,
    });
    const after = await request(app).get(`/api/contracts/${id}`).set(auth(client.token));
    expect(after.body.milestones[0].status).toBe('released');
    expect(
      after.body.history.some((h: { note: string | null }) => /tácita/.test(h.note ?? '')),
    ).toBe(true);

    // Cancelamento sem prazo (50%): do restante (666,67 / líquido 566,67) o cliente recebe
    // 333,34 e o freelancer 283,34; o que já tinha sido liberado (283,33) não volta.
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m2!.id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Front' })
      .expect(200);
    const cancel = await request(app).post(`/api/contracts/${id}/cancel`).set(auth(client.token));
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.refundPercentage).toBe(50);
    expect(await wallet(freelancer.token)).toMatchObject({ balance: 566.67, balancePending: 0 });
    expect(await wallet(client.token)).toMatchObject({ balance: 333.34, balancePending: 0 });
    const final = await request(app).get(`/api/contracts/${id}`).set(auth(client.token));
    expect(final.body.milestones.map((m: { status: string }) => m.status)).toEqual([
      'released',
      'cancelled',
      'cancelled',
    ]);
  });
});
