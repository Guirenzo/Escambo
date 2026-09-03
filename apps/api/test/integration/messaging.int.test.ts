import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<{ id: number; token: string }> {
  const email = `msg_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function makeContract(): Promise<{ client: { id: number; token: string }; freelancer: { id: number; token: string }; contractId: number }> {
  const client = await registerAndLogin('client');
  const freelancer = await registerAndLogin('freelancer');
  const created = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: 'Projeto com chat',
      description: 'Contrato usado para exercitar o chat em tempo real',
      price: 400,
    })
    .expect(201);
  return { client, freelancer, contractId: created.body.id };
}

afterAll(async () => {
  await pool.end();
});

describe('Chat do contrato (REST + persistência)', () => {
  it('as duas partes trocam mensagens e leem o histórico em ordem', async () => {
    const { client, freelancer, contractId } = await makeContract();

    // Histórico começa vazio, com a outra parte resolvida.
    const empty = await request(app).get(`/api/messaging/contracts/${contractId}`).set(auth(client.token));
    expect(empty.status).toBe(200);
    expect(empty.body.messages).toHaveLength(0);
    expect(empty.body.otherPartyId).toBe(freelancer.id);

    // Cliente envia; freelancer responde.
    const m1 = await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .send({ content: 'Olá! Pode começar essa semana?' });
    expect(m1.status).toBe(201);
    expect(m1.body).toMatchObject({ senderId: client.id, content: 'Olá! Pode começar essa semana?' });

    await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .send({ content: 'Posso sim, começo amanhã.' })
      .expect(201);

    // Ambos veem as duas mensagens, em ordem, na mesma conversa.
    const hist = await request(app).get(`/api/messaging/contracts/${contractId}`).set(auth(freelancer.token));
    expect(hist.status).toBe(200);
    const contents = (hist.body.messages as { content: string; senderId: number }[]).map((m) => m.content);
    expect(contents).toEqual(['Olá! Pode começar essa semana?', 'Posso sim, começo amanhã.']);
    expect(hist.body.conversationId).toBe(m1.body.conversationId);
  });

  it('bloqueia quem não é parte do contrato (403) e exige token (401)', async () => {
    const { contractId } = await makeContract();
    const outsider = await registerAndLogin('client');

    await request(app).get(`/api/messaging/contracts/${contractId}`).set(auth(outsider.token)).expect(403);
    await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(outsider.token))
      .send({ content: 'intruso' })
      .expect(403);
    await request(app).get(`/api/messaging/contracts/${contractId}`).expect(401);
  });

  it('rejeita mensagem vazia (422 de validação)', async () => {
    const { client, contractId } = await makeContract();
    await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .send({ content: '   ' })
      .expect(422);
  });
});
