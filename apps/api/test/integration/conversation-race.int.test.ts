import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

/**
 * Ao abrir a Sala, o histórico (REST) e o contract:join (socket) chegam ao mesmo tempo para
 * uma conversa que ainda não existe — e a primeira mensagem pode vir logo atrás. Nada disso
 * pode virar 500 por "Duplicate entry": a conversa é criada uma vez, atomicamente.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
): Promise<{ id: number; token: string }> {
  const email = `race_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

afterAll(async () => {
  await pool.end();
});

describe('Conversa do contrato sob concorrência', () => {
  it('N leituras do histórico e um envio ao mesmo tempo: tudo 200/201, uma única conversa', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);
    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Corrida na abertura da Sala',
        description: 'Histórico, entrada no socket e primeira mensagem chegando juntos',
        price: 300,
      })
      .expect(201);
    const url = `/api/messaging/contracts/${created.body.id}`;

    // Sem nenhuma chamada anterior: a conversa ainda não existe quando tudo isso dispara.
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => request(app).get(url).set(auth(client.token))),
      ...Array.from({ length: 4 }, () => request(app).get(url).set(auth(freelancer.token))),
      request(app).post(url).set(auth(client.token)).send({ content: 'Oi! Chegando junto.' }),
    ]);

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 500)).toHaveLength(0);
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(statuses[8]).toBe(201);

    const ids = new Set(results.slice(0, 8).map((r) => r.body.conversationId as number));
    expect(ids.size).toBe(1);
    expect(results[8]!.body.conversationId).toBe([...ids][0]);

    // A conversa ficou associada ao contrato e o histórico tem a mensagem uma vez só.
    const [rows] = await pool.query(
      'SELECT id, contract_id FROM conversations WHERE participant_a = ? AND participant_b = ?',
      [Math.min(client.id, freelancer.id), Math.max(client.id, freelancer.id)],
    );
    expect(rows as unknown[]).toHaveLength(1);
    expect((rows as { contract_id: number }[])[0]!.contract_id).toBe(created.body.id);
    const history = await request(app).get(url).set(auth(freelancer.token)).expect(200);
    expect(history.body.messages).toHaveLength(1);
  });
});
