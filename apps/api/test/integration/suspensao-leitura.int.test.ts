import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { realtime } from '../../src/config/realtime';
import { createSocketServer } from '../../src/config/socket';

/** RN-007: a identidade e o estado atuais do banco prevalecem sobre JWTs já emitidos. */
const app = createApp();
const httpServer = createServer(app);
const io = createSocketServer(httpServer);
const sockets = new Set<Socket>();
const PASSWORD = 'senha-readonly-integracao-123';
let passwordHash: string;
let port: number;

interface Actor {
  id: number;
  key: string;
  email: string;
  role: 'client' | 'freelancer' | 'admin';
  token: string;
}

const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

async function actor(role: Actor['role'] = 'client'): Promise<Actor> {
  const key = ulid();
  const email = `readonly-${key}@escambo.test`;
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, password_hash, role, status, timezone, email_verified_at)
     VALUES (:key, :email, :passwordHash, :role, 'active', 'America/Sao_Paulo', NOW())`,
    { key, email, passwordHash, role },
  );
  return {
    id: result.insertId,
    key,
    email,
    role,
    token: jwt.sign({ sub: key, uid: result.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function status(a: Actor, value: 'active' | 'suspended' | 'banned'): Promise<void> {
  await pool.query('UPDATE users SET status = :value WHERE id = :id', { id: a.id, value });
}

async function contract(client: Actor, freelancer: Actor): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts (ulid, client_id, freelancer_id, title, description, price,
       platform_fee, freelancer_net, payment_mode, status)
     VALUES (:key, :clientId, :freelancerId, 'Consulta RN-007', 'Contrato fictício do teste',
       100, 15, 85, 'cash', 'accepted')`,
    { key: ulid(), clientId: client.id, freelancerId: freelancer.id },
  );
  return result.insertId;
}

async function readState(a: Actor) {
  const [wallets] = await pool.query<RowDataPacket[]>('SELECT * FROM wallets WHERE user_id = :id', {
    id: a.id,
  });
  const [xp] = await pool.query<RowDataPacket[]>('SELECT * FROM user_xp WHERE user_id = :id', {
    id: a.id,
  });
  const [conversations] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM conversations WHERE participant_a = :id OR participant_b = :id',
    { id: a.id },
  );
  const [credits] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM credit_transactions WHERE user_id = :id',
    { id: a.id },
  );
  const [messages] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM messages WHERE sender_id = :id',
    {
      id: a.id,
    },
  );
  return { wallets, xp, conversations, credits, messages };
}

async function businessState(a: Actor) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 'payments' AS entity, COUNT(*) AS n FROM payments WHERE payer_id = :id OR payee_id = :id
     UNION ALL SELECT 'contracts', COUNT(*) FROM contracts WHERE client_id = :id OR freelancer_id = :id
     UNION ALL SELECT 'reports', COUNT(*) FROM content_reports WHERE reporter_id = :id
     UNION ALL SELECT 'disputes', COUNT(*) FROM disputes WHERE opened_by = :id
     UNION ALL SELECT 'client_profile', COUNT(*) FROM profiles_client WHERE user_id = :id
     UNION ALL SELECT 'freelancer_profile', COUNT(*) FROM profiles_freelancer WHERE user_id = :id`,
    { id: a.id },
  );
  return { rows, reads: await readState(a) };
}

function connectAs(a: Actor): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token: a.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
    });
    sockets.add(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function ack(socket: Socket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(3000)
      .emit(event, payload, (err: Error | null, value: Record<string, unknown>) => {
        if (err) reject(err);
        else resolve(value);
      });
  });
}

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await io.close();
  await pool.end();
});

describe('RN-007 — conta suspensa consulta, conta banida/excluída perde acesso', () => {
  it('permite login e refresh durante suspensão, mantendo credencial inválida em 401', async () => {
    const a = await actor();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: a.email, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    await status(a, 'suspended');
    const invalid = await request(app)
      .post('/api/auth/login')
      .send({ email: a.email, password: 'senha-incorreta' });
    expect(invalid.status).toBe(401);
    const suspendedLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: a.email, password: PASSWORD });
    expect(suspendedLogin.status, JSON.stringify(suspendedLogin.body)).toBe(200);
    expect(suspendedLogin.body.user.status).toBe('suspended');
    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.accessToken).toEqual(expect.any(String));
  });

  it('suspensão pelo painel mantém JWT antigo consultando e a reativação libera escrita', async () => {
    const admin = await actor('admin');
    const a = await actor();
    const freela = await actor('freelancer');
    const id = await contract(a, freela);
    await request(app).post(`/api/admin/users/${a.key}/suspend`).set(auth(admin)).expect(204);
    await request(app).get(`/api/contracts/${id}`).set(auth(a)).expect(200);
    await request(app).head(`/api/contracts/${id}`).set(auth(a)).expect(200);
    const blocked = await request(app)
      .post(`/api/messaging/contracts/${id}`)
      .set(auth(a))
      .send({ content: 'Não pode gravar esta mensagem' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('account_suspended');
    await request(app).post(`/api/admin/users/${a.key}/reactivate`).set(auth(admin)).expect(204);
    await request(app)
      .post(`/api/messaging/contracts/${id}`)
      .set(auth(a))
      .send({ content: 'Mensagem permitida depois da reativação' })
      .expect(201);
  });

  it('refresh anterior à suspensão continua válido sem conceder bônus financeiro', async () => {
    const a = await actor();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: a.email, password: PASSWORD });
    expect(login.status).toBe(200);
    await status(a, 'suspended');
    const before = await readState(a);
    const response = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await readState(a)).toEqual(before);
  });

  it('GETs de carteira, XP e chat não criam linhas nem concedem boas-vindas ao suspenso', async () => {
    const a = await actor();
    const id = await contract(a, await actor('freelancer'));
    await status(a, 'suspended');
    const before = await readState(a);
    expect(before).toEqual({ wallets: [], xp: [], conversations: [], credits: [], messages: [] });
    for (const path of ['/api/wallet', '/api/gamification/me', `/api/messaging/contracts/${id}`]) {
      await request(app).get(path).set(auth(a)).expect(200);
    }
    expect(await readState(a)).toEqual(before);
  });

  it('bloqueia negócios POST/PATCH/DELETE/PUT sem efeitos com JWT anterior à suspensão', async () => {
    const a = await actor();
    const freela = await actor('freelancer');
    const id = await contract(a, freela);
    await status(a, 'suspended');
    const before = await businessState(a);
    const attempts = [
      request(app).post('/api/wallet/deposits').send({ amount: 100 }),
      request(app).post('/api/contracts').send({
        freelancerId: freela.id,
        title: 'Bloqueado',
        description: 'Não pode gravar',
        price: 100,
      }),
      request(app).post(`/api/contracts/${id}/cancel`).send({ reason: 'Cancelamento bloqueado' }),
      request(app).post(`/api/contracts/${id}/dropout/agreed`).send({}),
      request(app).post(`/api/messaging/contracts/${id}`).send({ content: 'Mensagem bloqueada' }),
      request(app).post('/api/reports').send({
        targetType: 'user',
        targetId: freela.id,
        reason: 'other',
        description: 'Denúncia comum não é contestação',
      }),
      request(app).post('/api/disputes').send({
        contractId: id,
        reason: 'other',
        description: 'Disputa bloqueada durante suspensão',
      }),
      request(app).patch('/api/services/999999').send({ title: 'Mudança bloqueada' }),
      request(app).put('/api/profiles/client').send({ name: 'Mudança bloqueada' }),
      request(app).delete('/api/services/999999'),
      request(app).put('/api/notifications/preferences').send({ emailFrequency: 'daily' }),
    ];
    for (const attempt of attempts) {
      const response = await attempt.set(auth(a));
      expect(
        response.status,
        `${attempt.method} ${attempt.url}: ${JSON.stringify(response.body)}`,
      ).toBe(403);
      expect(response.body.error).toBe('account_suspended');
    }
    expect(await businessState(a)).toEqual(before);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT status FROM contracts WHERE id = :id',
      { id },
    );
    expect(rows[0]!.status).toBe('accepted');
  });

  it('preserva participação: suspenso não lê contratação/chat de terceiros', async () => {
    const outsider = await actor();
    const id = await contract(await actor(), await actor('freelancer'));
    await status(outsider, 'suspended');
    for (const path of [`/api/contracts/${id}`, `/api/messaging/contracts/${id}`]) {
      const response = await request(app).get(path).set(auth(outsider));
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('forbidden');
    }
  });

  it('mantém consentimento, exportação/exclusão LGPD, desligar push e sair de todos disponíveis', async () => {
    const a = await actor();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: a.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const endpoint = `https://push.escambo.test/${a.key}`;
    await pool.query(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_key) VALUES (:id, :endpoint, :key, :key)',
      { id: a.id, endpoint, key: a.key },
    );
    await status(a, 'suspended');
    await request(app)
      .post('/api/lgpd/consents')
      .set(auth(a))
      .send({ type: 'marketing', version: '1', accepted: false })
      .expect(201);
    await request(app).post('/api/lgpd/export-requests').set(auth(a)).expect(201);
    await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(a))
      .send({ reason: 'Solicitação fictícia do titular suspenso' })
      .expect(201);
    await request(app)
      .delete('/api/notifications/push')
      .set(auth(a))
      .send({ endpoint })
      .expect(204);
    const [push] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM push_subscriptions WHERE user_id = :id',
      { id: a.id },
    );
    expect(push).toEqual([]);
    const logout = await request(app).post('/api/auth/logout-all').set(auth(a)).expect(200);
    expect(logout.body.revoked).toBeGreaterThanOrEqual(1);
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
  });

  it('permite contestações de remoção e desistência somente ao dono, sem liberar acordo comercial', async () => {
    const a = await actor('freelancer');
    const client = await actor();
    const id = await contract(client, a);
    await pool.query(
      "UPDATE contracts SET status = 'cancelled', cancelled_at = NOW() WHERE id = :id",
      { id },
    );
    // A reconciliação não é objeto deste cenário; a fixture já entra tratada pelo job.
    const [dropout] = await pool.query<ResultSetHeader>(
      `INSERT INTO freelancer_dropouts (contract_id, freelancer_id, dropped_at, review_checked_at)
       VALUES (:id, :uid, NOW(), NOW())`,
      { id, uid: a.id },
    );
    const [removal] = await pool.query<ResultSetHeader>(
      `INSERT INTO content_removals (owner_id, target_type, target_id, content_snapshot, reason)
       VALUES (:uid, 'message', 999999, 'Conteúdo fictício para contestar', 'other')`,
      { uid: a.id },
    );
    const outsider = await actor('freelancer');
    await status(outsider, 'suspended');
    const body = { text: 'Peço a revisão deste registro pelos fatos da contratação.' };
    await request(app)
      .post(`/api/moderation/removals/${removal.insertId}/appeal`)
      .set(auth(outsider))
      .send(body)
      .expect(404);
    await request(app)
      .post(`/api/profiles/me/dropouts/${dropout.insertId}/appeal`)
      .set(auth(outsider))
      .send(body)
      .expect(404);
    await status(a, 'suspended');
    await request(app)
      .post(`/api/moderation/removals/${removal.insertId}/appeal`)
      .set(auth(a))
      .send(body)
      .expect(200);
    await request(app)
      .post(`/api/profiles/me/dropouts/${dropout.insertId}/appeal`)
      .set(auth(a))
      .send(body)
      .expect(200);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT appeal_text FROM freelancer_dropouts WHERE id = :id',
      { id: dropout.insertId },
    );
    expect(rows[0]!.appeal_text).toBe(body.text);
    await status(client, 'suspended');
    const agreement = await request(app)
      .post(`/api/contracts/${id}/dropout/agreed`)
      .set(auth(client))
      .send({});
    expect(agreement.status).toBe(403);
    expect(agreement.body.error).toBe('account_suspended');
  });

  it.each(['banned', 'deleted'] as const)(
    'nega leitura de JWT antigo quando a conta passa a %s',
    async (state) => {
      const a = await actor();
      if (state === 'deleted')
        await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = :id', { id: a.id });
      else await status(a, state);
      const response = await request(app).get('/api/auth/me').set(auth(a));
      expect(response.status).toBe(403);
      expect(response.body.error).toBe(state === 'banned' ? 'account_blocked' : 'account_deleted');
      await expect(connectAs(a)).rejects.toBeTruthy();
    },
  );

  it('rejeita uid/sub divergentes e usa papel atual para autorização administrativa', async () => {
    const a = await actor();
    const other = await actor();
    const mismatched = {
      ...a,
      token: jwt.sign({ uid: a.id, sub: other.key, role: 'client' }, env.JWT_SECRET),
    };
    await request(app).get('/api/auth/me').set(auth(mismatched)).expect(401);
    await expect(connectAs(mismatched)).rejects.toBeTruthy();
    const staleAdmin = {
      ...a,
      token: jwt.sign({ uid: a.id, sub: a.key, role: 'admin' }, env.JWT_SECRET),
    };
    await request(app).get('/api/admin/metrics').set(auth(staleAdmin)).expect(403);
  });

  it('papel admin antigo no JWT não concede acesso após mudança no banco', async () => {
    const admin = await actor('admin');
    await request(app).get('/api/admin/metrics').set(auth(admin)).expect(200);
    await pool.query("UPDATE users SET role = 'client' WHERE id = :id", { id: admin.id });
    await request(app).get('/api/admin/metrics').set(auth(admin)).expect(403);
  });

  it.each(['banned', 'deleted', 'mismatched', 'string', 'negative'] as const)(
    'handshake Socket.IO nega identidade %s sem depender de requisição HTTP prévia',
    async (kind) => {
      const a = await actor();
      if (kind === 'banned') await status(a, 'banned');
      else if (kind === 'deleted')
        await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = :id', { id: a.id });
      else {
        a.token = jwt.sign(
          {
            uid: kind === 'string' ? String(a.id) : kind === 'negative' ? -a.id : a.id,
            sub: kind === 'mismatched' ? (await actor()).key : a.key,
            role: a.role,
          },
          env.JWT_SECRET,
        );
      }
      await expect(connectAs(a)).rejects.toBeTruthy();
    },
  );

  it.each(['string', 'negative'] as const)(
    'rejeita uid %s sem confiar na coerção do driver SQL',
    async (kind) => {
      const a = await actor();
      const malformed = {
        ...a,
        token: jwt.sign(
          { uid: kind === 'string' ? String(a.id) : -a.id, sub: a.key, role: a.role },
          env.JWT_SECRET,
        ),
      };
      await request(app).get('/api/auth/me').set(auth(malformed)).expect(401);
      await expect(connectAs(malformed)).rejects.toBeTruthy();
    },
  );

  it('socket aberto antes da suspensão permite join participante e nega envio sem persistir', async () => {
    const a = await actor();
    const id = await contract(a, await actor('freelancer'));
    const socket = await connectAs(a);
    await status(a, 'suspended');
    expect(await ack(socket, 'contract:join', id)).toEqual({ ok: true });
    const before = await readState(a);
    expect(
      await ack(socket, 'message:send', { contractId: id, content: 'Mensagem negada' }),
    ).toMatchObject({ ok: false, error: 'account_suspended' });
    expect(await readState(a)).toEqual(before);
    await status(a, 'active');
    expect(
      await ack(socket, 'message:send', { contractId: id, content: 'Mensagem após reativação' }),
    ).toMatchObject({ ok: true });
    const after = await readState(a);
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.content).toBe('Mensagem após reativação');
    socket.disconnect();
  });

  it('socket de suspenso recém-conectado lê sem criar conversa e nega sala de terceiros', async () => {
    const a = await actor();
    const id = await contract(a, await actor('freelancer'));
    const foreign = await contract(await actor(), await actor('freelancer'));
    await status(a, 'suspended');
    const socket = await connectAs(a);
    const before = await readState(a);
    expect(await ack(socket, 'contract:join', id)).toEqual({ ok: true });
    expect(await ack(socket, 'contract:join', foreign)).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect(await readState(a)).toEqual(before);
    socket.disconnect();
  });

  it.each(['banned', 'deleted'] as const)(
    '%s impede emissões pessoal/contrato a socket antigo e preserva outro participante',
    async (state) => {
      const a = await actor();
      const peer = await actor('freelancer');
      const id = await contract(a, peer);
      const socket = await connectAs(a);
      const peerSocket = await connectAs(peer);
      expect(await ack(socket, 'contract:join', id)).toEqual({ ok: true });
      expect(await ack(peerSocket, 'contract:join', id)).toEqual({ ok: true });
      const received: unknown[] = [];
      const peerReceived: unknown[] = [];
      socket.on('stage12:probe', (value: unknown) => received.push(value));
      peerSocket.on('stage12:probe', (value: unknown) => peerReceived.push(value));
      if (state === 'deleted')
        await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = :id', { id: a.id });
      else await status(a, state);
      await realtime.emitToUser(a.id, 'stage12:probe', 'pessoal proibido');
      await realtime.emitToUser(peer.id, 'stage12:probe', 'pessoal permitido');
      await realtime.emitToContract(
        id,
        'stage12:probe',
        'contrato permitido ao participante ativo',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(peerReceived).toHaveLength(2);
      expect(peerReceived).toEqual(
        expect.arrayContaining(['pessoal permitido', 'contrato permitido ao participante ativo']),
      );
      expect(received).toEqual([]);
      socket.disconnect();
      peerSocket.disconnect();
    },
  );
});
