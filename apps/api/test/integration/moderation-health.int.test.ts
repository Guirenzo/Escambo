import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

/**
 * Saúde da moderação (ADR 47) contra o MySQL real: duas mensagens sinalizadas, uma dispensada e
 * uma removida, a remoção contestada e revertida. O painel conta a fila, o tempo até decidir, o
 * acerto por sinal e as contestações; só admin lê, e o período é validado.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer', domain = 'escambo.test'): Promise<Actor> {
  const email = `int_saude_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

interface Health {
  windowDays: number;
  queue: { pending: number; automaticPending: number; appealsPending: number };
  decisions: { total: number; dismissed: number; actioned: number; medianHours: number | null };
  automatic: {
    flagged: number;
    dismissed: number;
    actioned: number;
    precision: number | null;
    signals: { signal: string; flagged: number; actioned: number; dismissed: number }[];
  };
  appeals: { decided: number; overturned: number; overturnRate: number | null };
  removals: { total: number; byType: { targetType: string; count: number }[] };
  slaHours: number;
  history: {
    day: string;
    actioned: number;
    dismissed: number;
    flagged: number;
    medianHours: number | null;
  }[];
}

afterAll(async () => {
  await pool.end();
});

describe('Saúde da moderação (ADR 47)', () => {
  it('conta fila, decisões, acerto por sinal e contestações; só admin; período validado', async () => {
    const client = await actor('client');
    const freelancer = await actor('freelancer');
    const admin = await actor('client', 'admin.escambo.test');
    await fundWallet(app, client.token, 200);
    const contract = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Fachada da loja',
      description: 'Contratação do teste de saúde da moderação',
      price: 80,
    });
    expect(contract.status, JSON.stringify(contract.body)).toBe(201);
    const send = async (content: string): Promise<number> => {
      const res = await request(app)
        .post(`/api/messaging/contracts/${contract.body.id}`)
        .set(auth(freelancer.token))
        .send({ content });
      expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
      return res.body.id as number;
    };
    const health = (token: string, query = 'days=30') =>
      request(app).get(`/api/admin/moderation/health?${query}`).set(auth(token));

    const before = (await health(admin.token).expect(200)).body as Health;
    expect(before.windowDays).toBe(30);

    // Duas sinalizações automáticas: uma dispensada (só telefone), uma removida (pix e telefone).
    const harmless = await send('Meu telefone para a entrega: (47) 3333-1234');
    const scam = await send('Me paga no pix por fora: (47) 99999-0001');
    const groups = (
      await request(app).get('/api/admin/reports?status=pending').set(auth(admin.token)).expect(200)
    ).body as { id: number; targetType: string; targetId: number }[];
    const groupOf = (id: number) =>
      groups.find((g) => g.targetType === 'message' && g.targetId === id)!.id;
    const mid = (await health(admin.token).expect(200)).body as Health;
    expect(mid.queue.pending).toBeGreaterThanOrEqual(before.queue.pending + 2);
    expect(mid.queue.automaticPending).toBeGreaterThanOrEqual(before.queue.automaticPending + 2);

    await request(app)
      .post(`/api/admin/reports/${groupOf(harmless)}/dismiss`)
      .set(auth(admin.token))
      .send({ note: 'Telefone para a entrega.' })
      .expect(200);
    const removed = await request(app)
      .post(`/api/admin/reports/${groupOf(scam)}/remove-content`)
      .set(auth(admin.token))
      .send({ note: 'Pagamento por fora.' })
      .expect(200);
    await request(app)
      .post(`/api/moderation/removals/${removed.body.removalId}/appeal`)
      .set(auth(freelancer.token))
      .send({ text: 'Era o pix da nota fiscal, combinado pelo Escambo.' })
      .expect(200);
    const appealed = (await health(admin.token).expect(200)).body as Health;
    expect(appealed.queue.appealsPending).toBeGreaterThanOrEqual(1);
    await request(app)
      .post(`/api/admin/appeals/${removed.body.removalId}/overturn`)
      .set(auth(admin.token))
      .send({ note: 'Contexto esclarecido.' })
      .expect(200);

    const after = (await health(admin.token).expect(200)).body as Health;
    expect(after.decisions.total).toBeGreaterThanOrEqual(before.decisions.total + 2);
    expect(after.decisions.dismissed).toBeGreaterThanOrEqual(before.decisions.dismissed + 1);
    expect(after.decisions.actioned).toBeGreaterThanOrEqual(before.decisions.actioned + 1);
    expect(after.decisions.medianHours).toEqual(expect.any(Number));
    expect(after.automatic.flagged).toBeGreaterThanOrEqual(before.automatic.flagged + 2);
    expect(after.automatic.dismissed).toBeGreaterThanOrEqual(before.automatic.dismissed + 1);
    expect(after.automatic.actioned).toBeGreaterThanOrEqual(before.automatic.actioned + 1);
    expect(after.automatic.precision).toBeGreaterThan(0);
    expect(after.automatic.precision).toBeLessThanOrEqual(1);
    const pix = after.automatic.signals.find((s) => s.signal === 'pix')!;
    const phone = after.automatic.signals.find((s) => s.signal === 'phone')!;
    expect(pix.actioned).toBeGreaterThanOrEqual(1);
    expect(phone.flagged).toBeGreaterThanOrEqual(2);
    expect(phone.dismissed).toBeGreaterThanOrEqual(1);
    expect(after.appeals.decided).toBeGreaterThanOrEqual(before.appeals.decided + 1);
    expect(after.appeals.overturned).toBeGreaterThanOrEqual(before.appeals.overturned + 1);
    expect(after.appeals.overturnRate).toBeGreaterThan(0);
    expect(after.removals.total).toBeGreaterThanOrEqual(before.removals.total + 1);
    expect(
      after.removals.byType.find((t) => t.targetType === 'message')!.count,
    ).toBeGreaterThanOrEqual(1);

    // Série por dia (ADR 50): contínua, no dia de Brasília, com as decisões de agora na ponta
    // (nos dois últimos dias, para não depender de rodar longe da meia-noite).
    expect(after.slaHours).toBe(24);
    expect(after.history.length).toBeGreaterThanOrEqual(30);
    expect(after.history.length).toBeLessThanOrEqual(32);
    expect(after.history.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
    const recent = after.history.slice(-2);
    expect(recent.reduce((sum, d) => sum + d.actioned, 0)).toBeGreaterThanOrEqual(1);
    expect(recent.reduce((sum, d) => sum + d.dismissed, 0)).toBeGreaterThanOrEqual(1);
    expect(recent.reduce((sum, d) => sum + d.flagged, 0)).toBeGreaterThanOrEqual(2);
    expect(recent.some((d) => d.medianHours !== null)).toBe(true);
    expect(after.history.reduce((sum, d) => sum + d.actioned + d.dismissed, 0)).toBe(
      after.decisions.total,
    );

    // A meta é parâmetro da plataforma: mudou, o painel devolve o novo valor na hora.
    await request(app)
      .put('/api/admin/settings/moderation_sla_hours')
      .set(auth(admin.token))
      .send({ value: 48 })
      .expect(200);
    expect(((await health(admin.token).expect(200)).body as Health).slaHours).toBe(48);

    // O período muda a janela; fora de 1 a 365 é 422; quem não é admin toma 403.
    expect(((await health(admin.token, 'days=7').expect(200)).body as Health).windowDays).toBe(7);
    await health(admin.token, 'days=0').expect(422);
    await health(admin.token, 'days=400').expect(422);
    await health(client.token).expect(403);
  });
});
