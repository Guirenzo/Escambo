import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { createSocketServer } from '../../src/config/socket';
import { confirmEmail } from './mail.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * RF-062 contra o MySQL real: a conversa é uma só por par (ADR 31) e só aceita mensagem enquanto
 * existe relação aberta entre as duas pessoas — uma contratação que não terminou (proposta,
 * andamento, entrega, revisão ou disputa) ou uma troca proposta ou em andamento. Sem ela, texto e
 * anexo respondem 409 `conversation_closed`, pela rota e pelo socket; ler, baixar e marcar como
 * lida continuam. Uma relação nova reabre a conversa em qualquer Sala do par.
 */

const app = createApp();
const httpServer = createServer(app);
const io = createSocketServer(httpServer);
let port = 0;
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 5),
]);
const CLOSED = {
  error: 'conversation_closed',
  message:
    'Esta conversa está encerrada: não há contratação nem troca em aberto entre vocês. Para conversar de novo, faça uma nova proposta.',
};

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_conv_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  await confirmEmail(app, login.body.user.id);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function propose(client: Actor, freelancer: Actor, price = 150): Promise<number> {
  await fundWallet(app, client.token, price);
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: 'Contratação da conversa',
      description: 'Para ver o chat abrir e fechar com a relação do par',
      price,
    })
    .expect(201);
  return res.body.id as number;
}

const say = (contractId: number, who: Actor, content: string) =>
  request(app)
    .post(`/api/messaging/contracts/${contractId}`)
    .set(auth(who.token))
    .send({ content });

const history = async (contractId: number, who: Actor) =>
  (
    await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(who.token))
      .expect(200)
  ).body as { closed: boolean; messages: { id: number; content: string }[] };

async function complete(contractId: number, client: Actor, freelancer: Actor): Promise<void> {
  await request(app)
    .post(`/api/contracts/${contractId}/accept`)
    .set(auth(freelancer.token))
    .expect(200);
  await request(app)
    .post(`/api/contracts/${contractId}/deliver`)
    .set(auth(freelancer.token))
    .send({ message: 'Entregue.' })
    .expect(200);
  await request(app)
    .post(`/api/contracts/${contractId}/approve`)
    .set(auth(client.token))
    .expect(200);
}

function connectAs(actor: Actor): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      auth: { token: actor.token },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
  await request(app).get('/api/health').expect(200);
});

afterAll(async () => {
  await io.close();
  await pool.end();
});

describe('RF-062: conversa encerrada', () => {
  it('proposta pendente abre a conversa; recusada, fecha: 409 no texto e no anexo, e o histórico fica legível', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const id = await propose(client, freelancer);

    expect((await history(id, freelancer)).closed).toBe(false);
    await say(id, client, 'Oi! Consegue para sexta?').expect(201);
    const file = await request(app)
      .post(`/api/messaging/contracts/${id}/attachments`)
      .set(auth(client.token))
      .attach('file', PNG, { filename: 'briefing.png', contentType: 'image/png' })
      .expect(201);

    await request(app).post(`/api/contracts/${id}/reject`).set(auth(freelancer.token)).expect(200);

    const text = await say(id, freelancer, 'Desculpe, não consigo.').expect(409);
    expect(text.body).toEqual(CLOSED);
    const attachment = await request(app)
      .post(`/api/messaging/contracts/${id}/attachments`)
      .set(auth(client.token))
      .attach('file', PNG, { filename: 'outro.png', contentType: 'image/png' })
      .expect(409);
    expect(attachment.body).toEqual(CLOSED);

    // Ler, baixar o anexo e marcar como lida continuam.
    const h = await history(id, freelancer);
    expect(h.closed).toBe(true);
    expect(h.messages.map((m) => m.content)).toContain('Oi! Consegue para sexta?');
    await request(app).get(file.body.attachment.url).set(auth(freelancer.token)).expect(200);
    const read = await request(app)
      .post(`/api/messaging/contracts/${id}/read`)
      .set(auth(freelancer.token))
      .send({})
      .expect(200);
    expect(read.body.marked).toBeGreaterThanOrEqual(1);
  });

  it('concluída, fecha na hora (sem carência); uma proposta nova reabre, inclusive na Sala antiga', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const first = await propose(client, freelancer);
    await say(first, freelancer, 'Começando hoje.').expect(201);
    await complete(first, client, freelancer);

    expect((await history(first, client)).closed).toBe(true);
    expect((await say(first, client, 'Obrigado!').expect(409)).body).toEqual(CLOSED);

    const second = await propose(client, freelancer);
    // A conversa do par é uma só: com a nova proposta aberta, a Sala antiga também escreve.
    expect((await history(first, client)).closed).toBe(false);
    await say(first, client, 'Mandei outra proposta.').expect(201);
    await say(second, freelancer, 'Vi, já respondo.').expect(201);

    // Recusada a nova, o par volta a não ter nada aberto: fecha nas duas Salas.
    await request(app)
      .post(`/api/contracts/${second}/reject`)
      .set(auth(freelancer.token))
      .expect(200);
    expect((await history(second, client)).closed).toBe(true);
    expect((await say(first, client, 'E agora?').expect(409)).body).toEqual(CLOSED);
  });

  it('disputa aberta mantém a conversa aberta', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const id = await propose(client, freelancer);
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    // A janela da disputa (RN-062) tem testes próprios: aqui só o estado importa.
    await pool.query("UPDATE contracts SET status = 'disputed' WHERE id = :id", { id });
    expect((await history(id, client)).closed).toBe(false);
    await say(id, client, 'Vamos tentar um acordo pelo chat?').expect(201);
  });

  it('troca proposta ou em andamento também abre; cancelada, fecha de novo', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const id = await propose(client, freelancer);
    await request(app).post(`/api/contracts/${id}/reject`).set(auth(freelancer.token)).expect(200);
    expect((await history(id, client)).closed).toBe(true);

    const barter = await request(app)
      .post('/api/barters')
      .set(auth(freelancer.token))
      .send({
        receiverId: client.id,
        offeredDescription: 'Site institucional',
        requestedDescription: 'Fotos do produto',
        estimatedValueOffered: 400,
        estimatedValueRequested: 400,
      })
      .expect(201);
    expect((await history(id, client)).closed).toBe(false);
    await say(id, client, 'Gostei da troca, vamos combinar.').expect(201);

    await request(app)
      .post(`/api/barters/${barter.body.id}/cancel`)
      .set(auth(freelancer.token))
      .expect(204);
    expect((await history(id, client)).closed).toBe(true);
    await say(id, client, 'Desistiu?').expect(409);
  });

  it('pelo socket, a mesma recusa volta com o código, e a conexão continua', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const id = await propose(client, freelancer);
    await request(app).post(`/api/contracts/${id}/reject`).set(auth(freelancer.token)).expect(200);

    const socket = await connectAs(client);
    try {
      const reply = await new Promise<{ ok: boolean; error?: string; message?: string }>(
        (resolve) => socket.emit('message:send', { contractId: id, content: 'Ainda aí?' }, resolve),
      );
      expect(reply).toEqual({ ok: false, ...CLOSED });
      expect(socket.connected).toBe(true);
      // Entrar na sala para ler continua permitido.
      const joined = await new Promise<{ ok: boolean }>((resolve) =>
        socket.emit('contract:join', id, resolve),
      );
      expect(joined).toEqual({ ok: true });
    } finally {
      socket.disconnect();
    }
  });
});
