import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

/**
 * Aviso de negociação por fora (ADR 45) contra o MySQL real: a mensagem com Pix, telefone ou
 * WhatsApp sai sinalizada para as duas partes, entra sozinha na fila de denúncias sem denunciante,
 * não aparece nas denúncias de ninguém, soma com a denúncia humana e pode ser removida pela fila.
 * Mensagem limpa e legenda de anexo seguem as mesmas regras.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer', domain = 'escambo.test'): Promise<Actor> {
  const email = `int_porfora_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

interface Message {
  id: number;
  content: string;
  signals: string[];
  removedAt: string | null;
}
interface Group {
  id: number;
  targetType: string;
  targetId: number;
  automatic: boolean;
  reports: number;
  descriptions: string[];
  reasons: { reason: string; count: number }[];
  excerpt: string | null;
}

afterAll(async () => {
  await pool.end();
});

describe('Aviso de negociação por fora (ADR 45)', () => {
  it('mensagem com Pix e telefone sai sinalizada, entra sozinha na fila e some do ar pela moderação', async () => {
    const client = await actor('client');
    const freelancer = await actor('freelancer');
    const admin = await actor('client', 'admin.escambo.test');
    await fundWallet(app, client.token, 200);
    const contract = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Site da barbearia',
      description: 'Contratação do teste de negociação por fora',
      price: 80,
    });
    expect(contract.status, JSON.stringify(contract.body)).toBe(201);
    const contractId = contract.body.id as number;
    const send = (a: Actor, content: string) =>
      request(app)
        .post(`/api/messaging/contracts/${contractId}`)
        .set(auth(a.token))
        .send({ content });

    const clean = await send(client, 'Oi! Já fiz o depósito no Escambo, pode aceitar a proposta.');
    expect([200, 201], JSON.stringify(clean.body)).toContain(clean.status);
    expect((clean.body as Message).signals).toEqual([]);
    const text = 'Me paga no pix por fora que sai sem taxa: (47) 99999-0001, tô no whats';
    const flagged = await send(freelancer, text);
    expect([200, 201], JSON.stringify(flagged.body)).toContain(flagged.status);
    expect(flagged.body as Message).toMatchObject({
      content: text,
      signals: ['pix', 'phone', 'whatsapp', 'off_platform'],
    });
    const messageId = (flagged.body as Message).id;

    // As duas partes veem os sinais no histórico; a legenda de um anexo segue a mesma regra.
    for (const who of [client, freelancer]) {
      const h = await request(app)
        .get(`/api/messaging/contracts/${contractId}`)
        .set(auth(who.token));
      expect(h.status).toBe(200);
      const messages = h.body.messages as Message[];
      expect(messages.find((m) => m.id === messageId)!.signals).toEqual([
        'pix',
        'phone',
        'whatsapp',
        'off_platform',
      ]);
      expect(messages.find((m) => m.id === (clean.body as Message).id)!.signals).toEqual([]);
    }
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const captioned = await request(app)
      .post(`/api/messaging/contracts/${contractId}/attachments`)
      .set(auth(freelancer.token))
      .field('content', 'segue o orçamento, chave pix no rodapé')
      .attach('file', pdf, { filename: 'orcamento.pdf', contentType: 'application/pdf' });
    expect([200, 201], JSON.stringify(captioned.body)).toContain(captioned.status);
    expect((captioned.body as Message).signals).toEqual(['pix']);

    // Fila: denúncia automática, sem denunciante, com o que foi achado; a limpa não entra.
    const queue = (
      await request(app).get('/api/admin/reports?status=pending').set(auth(admin.token)).expect(200)
    ).body as Group[];
    const group = queue.find((g) => g.targetType === 'message' && g.targetId === messageId);
    expect(group).toMatchObject({
      automatic: true,
      reports: 1,
      excerpt: text,
      reasons: [{ reason: 'off_platform', count: 1 }],
      descriptions: ['Sinalizado automaticamente: Pix, telefone, WhatsApp e negociar por fora.'],
    });
    expect(queue.some((g) => g.targetId === (clean.body as Message).id)).toBe(false);
    expect(
      queue.find(
        (g) => g.targetType === 'message' && g.targetId === (captioned.body as Message).id,
      ),
    ).toMatchObject({ automatic: true, descriptions: ['Sinalizado automaticamente: Pix.'] });
    const [rows] = await pool.query(
      'SELECT reporter_id FROM content_reports WHERE target_type = ? AND target_id = ?',
      ['message', messageId],
    );
    expect(rows).toEqual([{ reporter_id: null }]);

    // Ninguém "fez" a denúncia automática; a humana soma no mesmo grupo.
    for (const who of [client, freelancer]) {
      const mine = await request(app).get('/api/reports').set(auth(who.token)).expect(200);
      expect((mine.body as { targetId: number }[]).some((r) => r.targetId === messageId)).toBe(
        false,
      );
    }
    await request(app)
      .post('/api/reports')
      .set(auth(client.token))
      .send({ targetType: 'message', targetId: messageId, reason: 'off_platform' })
      .expect(201);
    const again = (
      await request(app).get('/api/admin/reports?status=pending').set(auth(admin.token)).expect(200)
    ).body as Group[];
    expect(again.find((g) => g.targetType === 'message' && g.targetId === messageId)).toMatchObject(
      {
        automatic: true,
        reports: 2,
      },
    );

    // A remoção pela fila (ADR 44) funciona a partir da denúncia automática.
    const removed = await request(app)
      .post(`/api/admin/reports/${group!.id}/remove-content`)
      .set(auth(admin.token))
      .send({ note: 'Pagamento por fora.' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ reports: 2, removalId: expect.any(Number) });
    const after = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token));
    const gone = (after.body.messages as Message[]).find((m) => m.id === messageId)!;
    expect(gone).toMatchObject({ content: '', signals: [] });
    expect(gone.removedAt).toEqual(expect.any(String));
  });
});
