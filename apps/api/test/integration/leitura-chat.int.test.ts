import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatReadEvent } from '@escambo/types';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { createSocketServer } from '../../src/config/socket';

/**
 * Leitura no chat (RF-059) contra o MySQL e o Socket.IO de verdade: só quem recebeu marca, até a
 * mensagem que a tela mostrou; quem não participa é barrado; repetir não muda nada nem avisa de
 * novo; quem mandou recebe `message:read` na hora; e a conta suspensa registra a leitura (RN-007).
 */
const app = createApp();
const httpServer = createServer(app);
const io = createSocketServer(httpServer);
const sockets = new Set<Socket>();
let port: number;

interface Actor {
  id: number;
  token: string;
}

const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

async function actor(role: 'client' | 'freelancer' = 'client'): Promise<Actor> {
  const key = ulid();
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone)
     VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo')`,
    { key, email: `leitura-${key}@escambo.test`, role },
  );
  return {
    id: result.insertId,
    token: jwt.sign({ sub: key, uid: result.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function contract(
  client: Actor,
  freelancer: Actor,
  status: 'accepted' | 'completed' = 'accepted',
): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts (ulid, client_id, freelancer_id, title, description, price,
       platform_fee, freelancer_net, payment_mode, status)
     VALUES (:key, :clientId, :freelancerId, 'Leitura RF-059', 'Contrato fictício do teste',
       100, 15, 85, 'cash', :status)`,
    { key: ulid(), clientId: client.id, freelancerId: freelancer.id, status },
  );
  return result.insertId;
}

async function send(from: Actor, contractId: number, content: string): Promise<number> {
  const res = await request(app)
    .post(`/api/messaging/contracts/${contractId}`)
    .set(auth(from))
    .send({ content });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

const markRead = (who: Actor, contractId: number, body: object = {}) =>
  request(app).post(`/api/messaging/contracts/${contractId}/read`).set(auth(who)).send(body);

async function readColumns(
  ids: number[],
): Promise<Map<number, { is_read: number; read_at: Date | null }>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, is_read, read_at FROM messages WHERE id IN (:ids)',
    { ids },
  );
  return new Map(
    rows.map((r) => [Number(r.id), { is_read: Number(r.is_read), read_at: r.read_at }]),
  );
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

function join(socket: Socket, contractId: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(3000)
      .emit('contract:join', contractId, (err: Error | null, value: unknown) =>
        err ? reject(err) : resolve(value),
      );
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await io.close();
  await pool.end();
});

describe('leitura no chat (RF-059)', () => {
  it('a migration 0037 criou o índice das não lidas por conversa', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT column_name AS col FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'messages'
          AND index_name = 'idx_msg_conv_unread'
        ORDER BY seq_in_index`,
    );
    expect(rows.map((r) => String(r.col))).toEqual(['conversation_id', 'read_at']);
  });

  it('a 0037 roda de novo sem erro (retomada depois de queda) e não duplica o índice', async () => {
    const sql = readFileSync(
      path.join(__dirname, '../../db/migrations/0037_leitura_chat.sql'),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(4);
    // As variáveis do SET valem por conexão: as quatro instruções vão pela mesma.
    const conn = await pool.getConnection();
    try {
      for (const statement of statements) await conn.query(statement);
    } finally {
      conn.release();
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT index_name) AS n FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'messages'
          AND column_name = 'read_at'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('o destinatário marca até a mensagem exibida; o remetente não marca as próprias', async () => {
    const client = await actor();
    const freela = await actor('freelancer');
    const id = await contract(client, freela);
    const first = await send(client, id, 'Bom dia, tudo certo?');
    const second = await send(client, id, 'Mandei o briefing');

    // Quem mandou chamar a rota não muda nada: as dele continuam não lidas.
    const own = await markRead(client, id);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ marked: 0, upToId: null, readAt: null });
    expect([...(await readColumns([first, second])).values()]).toEqual([
      { is_read: 0, read_at: null },
      { is_read: 0, read_at: null },
    ]);

    // A tela do freelancer mostrou só a primeira: só ela vira lida.
    const partial = await markRead(freela, id, { upTo: first });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body).toMatchObject({ marked: 1, upToId: first });
    expect(partial.body.readAt).toEqual(expect.any(String));

    const rest = await markRead(freela, id);
    expect(rest.body).toMatchObject({ marked: 1, upToId: second });

    const cols = await readColumns([first, second]);
    expect(cols.get(first)).toEqual({ is_read: 1, read_at: new Date(partial.body.readAt) });
    expect(cols.get(second)).toEqual({ is_read: 1, read_at: new Date(rest.body.readAt) });

    // O histórico de quem mandou traz o readAt de cada uma.
    const history = await request(app)
      .get(`/api/messaging/contracts/${id}`)
      .set(auth(client))
      .expect(200);
    expect(
      history.body.messages.map((m: { id: number; readAt: string | null }) => m.readAt),
    ).toEqual([partial.body.readAt, rest.body.readAt]);

    // A resposta do freelancer é não lida para o cliente, sem tocar nas que ele já leu.
    const reply = await send(freela, id, 'Recebi, obrigado');
    const clientRead = await markRead(client, id, { upTo: reply });
    expect(clientRead.body).toMatchObject({ marked: 1, upToId: reply });
    expect((await readColumns([first])).get(first)!.read_at).toEqual(new Date(partial.body.readAt));
  });

  it('idempotente: repetir não muda o horário da primeira leitura nem marca a que chegou depois', async () => {
    const client = await actor();
    const freela = await actor('freelancer');
    const id = await contract(client, freela);
    const m1 = await send(client, id, 'Primeira');
    const first = await markRead(freela, id, { upTo: m1 });
    expect(first.body).toMatchObject({ marked: 1, upToId: m1 });

    const m2 = await send(client, id, 'Chegou depois');
    // A mesma tela de antes (upTo = m1) não lê a que ainda não apareceu.
    const again = await markRead(freela, id, { upTo: m1 });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({
      conversationId: first.body.conversationId,
      marked: 0,
      upToId: null,
      readAt: null,
    });
    const cols = await readColumns([m1, m2]);
    expect(cols.get(m1)).toEqual({ is_read: 1, read_at: new Date(first.body.readAt) });
    expect(cols.get(m2)).toEqual({ is_read: 0, read_at: null });
  });

  it('quem não participa recebe 403, contratação inexistente 404, sem mudar nada', async () => {
    const client = await actor();
    const freela = await actor('freelancer');
    const outsider = await actor();
    const id = await contract(client, freela);
    const m1 = await send(client, id, 'Só para o freelancer');

    const forbidden = await markRead(outsider, id, { upTo: m1 });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('forbidden');
    const missing = await markRead(freela, 999_999_999);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('contract_not_found');
    const invalid = await markRead(freela, id, { upTo: 0 });
    expect(invalid.status).toBe(422);

    expect((await readColumns([m1])).get(m1)).toEqual({ is_read: 0, read_at: null });
  });

  it('quem mandou recebe message:read na hora, na sala de cada contratação do par; repetir não avisa', async () => {
    const client = await actor();
    const freela = await actor('freelancer');
    // A conversa é a mesma nas duas contratações (ADR 31): a antiga e a atual.
    const old = await contract(client, freela, 'completed');
    const id = await contract(client, freela);
    const m1 = await send(client, id, 'Pode ver o arquivo?');

    const senderSocket = await connectAs(client);
    expect(await join(senderSocket, id)).toEqual({ ok: true });
    expect(await join(senderSocket, old)).toEqual({ ok: true });
    const received: ChatReadEvent[] = [];
    senderSocket.on('message:read', (event: ChatReadEvent) => received.push(event));

    const res = await markRead(freela, id, { upTo: m1 });
    expect(res.body).toMatchObject({ marked: 1, upToId: m1 });
    await settle();

    const expected = {
      conversationId: res.body.conversationId,
      readerId: freela.id,
      upToId: m1,
      readAt: res.body.readAt,
    };
    expect(received).toHaveLength(2);
    expect(received).toEqual(
      expect.arrayContaining([
        { ...expected, contractId: id },
        { ...expected, contractId: old },
      ]),
    );

    // Nada mudou: nenhum aviso novo.
    await markRead(freela, id, { upTo: m1 }).expect(200);
    await settle();
    expect(received).toHaveLength(2);
    senderSocket.disconnect();
  });

  it('conta suspensa registra a leitura sem criar conversa, e continua sem enviar (RN-007)', async () => {
    const client = await actor();
    const freela = await actor('freelancer');
    const id = await contract(client, freela);
    const m1 = await send(client, id, 'Mensagem antes da suspensão');
    const senderSocket = await connectAs(client);
    expect(await join(senderSocket, id)).toEqual({ ok: true });
    const received: ChatReadEvent[] = [];
    senderSocket.on('message:read', (event: ChatReadEvent) => received.push(event));

    await pool.query("UPDATE users SET status = 'suspended' WHERE id = :id", { id: freela.id });
    const res = await markRead(freela, id, { upTo: m1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ marked: 1, upToId: m1 });
    expect((await readColumns([m1])).get(m1)!.is_read).toBe(1);
    await settle();
    expect(received).toEqual([
      expect.objectContaining({ contractId: id, readerId: freela.id, upToId: m1 }),
    ]);

    // Ler não vira escrever: o envio continua barrado.
    const blocked = await request(app)
      .post(`/api/messaging/contracts/${id}`)
      .set(auth(freela))
      .send({ content: 'Não pode' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('account_suspended');

    // Par sem conversa: a suspensa marca "nada" e a conversa não é criada.
    const other = await actor();
    const empty = await contract(other, freela);
    const none = await markRead(freela, empty);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ conversationId: null, marked: 0, upToId: null, readAt: null });
    const [conversations] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM conversations WHERE participant_a IN (:a, :b) AND participant_b IN (:a, :b)',
      { a: other.id, b: freela.id },
    );
    expect(conversations).toEqual([]);
    senderSocket.disconnect();
  });
});
