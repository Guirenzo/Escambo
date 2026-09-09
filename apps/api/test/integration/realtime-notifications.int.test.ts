import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Notification } from '@escambo/types';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { createSocketServer } from '../../src/config/socket';

/**
 * Notificações em tempo real: cada usuário conectado entra na sala `user:<id>` e recebe
 * `notification:new` quando algo acontece com ele (proposta, aceite, entrega…) — o mesmo
 * evento que alimenta o badge e os toasts do web. Usa um servidor HTTP + Socket.IO reais.
 */

const app = createApp();
const httpServer = createServer(app);
const io = createSocketServer(httpServer);
let port = 0;

const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `rt_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
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

/** Próxima notificação recebida pelo socket (ou falha em `ms`). */
function nextNotification(socket: Socket, ms = 5000): Promise<Notification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nenhuma notificação em tempo')), ms);
    socket.once('notification:new', (n: Notification) => {
      clearTimeout(timer);
      resolve(n);
    });
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await io.close();
  await pool.end();
});

describe('Notificações em tempo real (Socket.IO, sala por usuário)', () => {
  it('freelancer conectado recebe a proposta na hora; cliente recebe o aceite; sem token não conecta', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');

    const freelancerSocket = await connectAs(freelancer);
    const clientSocket = await connectAs(client);

    // Cliente propõe → freelancer é notificado em tempo real.
    const proposal = nextNotification(freelancerSocket);
    const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Proposta em tempo real',
      description: 'Contratação criada pelo teste de notificações ao vivo',
      price: 150,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const n1 = await proposal;
    expect(n1).toMatchObject({ type: 'contract_proposal', isRead: false });
    expect(n1.title.length).toBeGreaterThan(0);

    // Freelancer aceita → cliente é notificado; o freelancer não recebe a própria ação.
    let leaked: Notification | null = null;
    freelancerSocket.once('notification:new', (n: Notification) => {
      leaked = n;
    });
    const accepted = nextNotification(clientSocket);
    const acc = await request(app)
      .post(`/api/contracts/${created.body.id}/accept`)
      .set(auth(freelancer.token));
    expect(acc.status).toBe(200);
    const n2 = await accepted;
    expect(n2.type).toBe('contract_accepted');
    await new Promise((r) => setTimeout(r, 300));
    expect(leaked).toBeNull();

    // A notificação também está persistida (badge/polling continuam funcionando).
    const list = await request(app).get('/api/notifications').set(auth(freelancer.token));
    expect(list.status).toBe(200);
    expect(list.body.unreadCount).toBeGreaterThanOrEqual(1);

    freelancerSocket.disconnect();
    clientSocket.disconnect();

    // Handshake sem JWT é recusado.
    await expect(connectAs({ id: 0, token: '' })).rejects.toBeTruthy();
  });
});
