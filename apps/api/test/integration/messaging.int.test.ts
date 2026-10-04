import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { realtime } from '../../src/config/realtime';
import { messagingRepository } from '../../src/modules/messaging/messaging.repository';
import { messagingService } from '../../src/modules/messaging/messaging.service';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
): Promise<{ id: number; token: string }> {
  const email = `msg_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function makeContract(): Promise<{
  client: { id: number; token: string };
  freelancer: { id: number; token: string };
  contractId: number;
}> {
  const client = await registerAndLogin('client');
  const freelancer = await registerAndLogin('freelancer');
  await fundWallet(app, client.token, 400);
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
    const empty = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token));
    expect(empty.status).toBe(200);
    expect(empty.body.messages).toHaveLength(0);
    expect(empty.body.otherPartyId).toBe(freelancer.id);

    // Cliente envia; freelancer responde.
    const m1 = await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .send({ content: 'Olá! Pode começar essa semana?' });
    expect(m1.status).toBe(201);
    expect(m1.body).toMatchObject({
      senderId: client.id,
      content: 'Olá! Pode começar essa semana?',
    });

    await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .send({ content: 'Posso sim, começo amanhã.' })
      .expect(201);

    // Ambos veem as duas mensagens, em ordem, na mesma conversa.
    const hist = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token));
    expect(hist.status).toBe(200);
    const contents = (hist.body.messages as { content: string; senderId: number }[]).map(
      (m) => m.content,
    );
    expect(contents).toEqual(['Olá! Pode começar essa semana?', 'Posso sim, começo amanhã.']);
    expect(hist.body.conversationId).toBe(m1.body.conversationId);
  });

  it('bloqueia quem não é parte do contrato (403) e exige token (401)', async () => {
    const { contractId } = await makeContract();
    const outsider = await registerAndLogin('client');

    await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(outsider.token))
      .expect(403);
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

describe('Conversa única do par, atravessando as contratações', () => {
  /** Mais uma contratação entre as mesmas duas pessoas. */
  async function hireAgain(
    client: { id: number; token: string },
    freelancer: { id: number; token: string },
  ): Promise<number> {
    await fundWallet(app, client.token, 400);
    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Segundo projeto com a mesma pessoa',
        description: 'Outra contratação entre o mesmo par, reaproveitando a conversa',
        price: 400,
      })
      .expect(201);
    return created.body.id as number;
  }

  it('o histórico traz as 200 mensagens MAIS RECENTES, em ordem cronológica: a 201ª aparece, a 1ª sai', async () => {
    const { client, freelancer, contractId } = await makeContract();
    const first = await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .send({ content: 'msg 1' })
      .expect(201);
    // As outras 204 entram direto no banco (204 POSTs seriam lentos), depois da primeira.
    const rows = Array.from({ length: 204 }, (_, i) => [
      first.body.conversationId,
      i % 2 ? client.id : freelancer.id,
      'text',
      `msg ${i + 2}`,
    ]);
    await pool.query('INSERT INTO messages (conversation_id, sender_id, type, content) VALUES ?', [
      rows,
    ]);

    const hist = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .expect(200);

    const messages = hist.body.messages as { id: number; content: string }[];
    expect(messages).toHaveLength(200);
    expect(messages[0]!.content).toBe('msg 6');
    expect(messages.at(-1)!.content).toBe('msg 205');
    const ids = messages.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('as contratações do par são todas as entre as duas pessoas, e só elas (a conversa guarda só a primeira)', async () => {
    const { client, freelancer, contractId } = await makeContract();
    // A conversa nasce na primeira contratação e fica com o id dela.
    await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .expect(200);
    const second = await hireAgain(client, freelancer);
    // O mesmo cliente com outra pessoa: outra conversa, fora da lista.
    const other = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 100);
    await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: other.id,
        title: 'Projeto com outra pessoa',
        description: 'Contratação que não é do par da conversa',
        price: 100,
      })
      .expect(201);

    const sent = await request(app)
      .post(`/api/messaging/contracts/${second}`)
      .set(auth(freelancer.token))
      .send({ content: 'Mensagem na sala da segunda contratação' })
      .expect(201);

    const [conv] = await pool.query('SELECT contract_id FROM conversations WHERE id = :id', {
      id: sent.body.conversationId,
    });
    expect((conv as { contract_id: number }[])[0]!.contract_id).toBe(contractId);
    expect(await messagingRepository.pairContractIds(sent.body.conversationId)).toEqual([
      contractId,
      second,
    ]);
  });

  it('remoção pela moderação numa segunda contratação: o aviso chega à sala de cada contratação do par, com o id dela', async () => {
    const { client, freelancer, contractId } = await makeContract();
    // A conversa nasce na primeira contratação e fica com o id dela.
    await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .expect(200);
    const second = await hireAgain(client, freelancer);
    const sent = await request(app)
      .post(`/api/messaging/contracts/${second}`)
      .set(auth(client.token))
      .send({ content: 'me paga por fora' })
      .expect(201);
    await pool.query('UPDATE messages SET removed_at = NOW() WHERE id = :id', {
      id: sent.body.id,
    });
    const emit = vi.spyOn(realtime, 'emitToContract');

    await messagingService.announceChange(sent.body.id);

    expect(emit.mock.calls).toEqual([
      [contractId, 'message:updated', expect.objectContaining({ id: sent.body.id, contractId })],
      [
        second,
        'message:updated',
        expect.objectContaining({ id: sent.body.id, contractId: second, content: '' }),
      ],
    ]);
    emit.mockRestore();
  });

  it('mensagem nova numa segunda contratação: chega à sala de cada contratação do par, com o id dela', async () => {
    const { client, freelancer, contractId } = await makeContract();
    // A conversa nasce na primeira contratação; a outra parte pode estar com a sala dela aberta.
    await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .expect(200);
    const second = await hireAgain(client, freelancer);
    const emit = vi.spyOn(realtime, 'emitToContract');

    const sent = await request(app)
      .post(`/api/messaging/contracts/${second}`)
      .set(auth(client.token))
      .send({ content: 'Mandei pela sala da segunda contratação' })
      .expect(201);

    const news = emit.mock.calls.filter((c) => c[1] === 'message:new');
    emit.mockRestore();
    expect(news).toEqual([
      [
        contractId,
        'message:new',
        expect.objectContaining({ id: sent.body.id, contractId, senderId: client.id }),
      ],
      [
        second,
        'message:new',
        expect.objectContaining({ id: sent.body.id, contractId: second, senderId: client.id }),
      ],
    ]);
  });
});
