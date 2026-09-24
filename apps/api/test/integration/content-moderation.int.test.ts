import sharp from 'sharp';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

/**
 * Moderação de avaliações e mensagens (ADR 44) contra o MySQL real: a avaliação removida sai da
 * nota média e do perfil e a contratação mostra a remoção; a mensagem removida vira aviso para as
 * duas partes e o anexo sai do ar; o autor contesta, e reverter devolve o conteúdo e a nota. Texto
 * removido conta para a revisão da conta, mas não bloqueia o envio de imagens.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  ulid: string;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer', domain = 'escambo.test'): Promise<Actor> {
  const email = `int_conteudo_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const a: Actor = {
    id: login.body.user.id,
    ulid: login.body.user.ulid,
    token: login.body.accessToken,
  };
  if (role === 'freelancer') {
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(a.token))
      .send({ fullName: 'Freela Moderado', city: 'Joinville' })
      .expect(200);
  }
  return a;
}

async function createContract(client: Actor, freelancer: Actor, title: string): Promise<number> {
  const res = await request(app).post('/api/contracts').set(auth(client.token)).send({
    freelancerId: freelancer.id,
    title,
    description: 'Contratação do teste de moderação de conteúdo',
    price: 50,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function completedContract(client: Actor, freelancer: Actor, title: string): Promise<number> {
  const id = await createContract(client, freelancer, title);
  for (const [who, action, body] of [
    [freelancer, 'accept', undefined],
    [freelancer, 'deliver', { message: 'Entregue.' }],
    [client, 'approve', undefined],
  ] as const) {
    const res = await request(app)
      .post(`/api/contracts/${id}/${action}`)
      .set(auth(who.token))
      .send(body);
    expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(200);
  }
  return id;
}

const report = async (reporter: Actor, targetType: string, targetId: number): Promise<number> => {
  const res = await request(app)
    .post('/api/reports')
    .set(auth(reporter.token))
    .send({
      targetType,
      targetId,
      reason: targetType === 'message' ? 'off_platform' : 'offensive',
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
};
const act = (a: Actor, id: number, action: string, note?: string) =>
  request(app).post(`/api/admin/reports/${id}/${action}`).set(auth(a.token)).send({ note });
const appeal = (a: Actor, id: number, text: string) =>
  request(app).post(`/api/moderation/removals/${id}/appeal`).set(auth(a.token)).send({ text });
const decide = (a: Actor, id: number, decision: 'uphold' | 'overturn', note?: string) =>
  request(app).post(`/api/admin/appeals/${id}/${decision}`).set(auth(a.token)).send({ note });

async function rating(freelancer: Actor): Promise<[number, number]> {
  const res = await request(app).get(`/api/profiles/freelancer/${freelancer.ulid}`).expect(200);
  return [Number(res.body.avgRating), Number(res.body.totalReviews)];
}

async function publicReviews(freelancer: Actor): Promise<string[]> {
  const res = await request(app).get(`/api/reviews?freelancerId=${freelancer.id}`).expect(200);
  return (res.body.items as { comment: string | null }[]).map((r) => r.comment ?? '');
}

interface ChatMessage {
  id: number;
  content: string;
  attachment: unknown;
  removedAt: string | null;
}
async function history(a: Actor, contractId: number): Promise<ChatMessage[]> {
  const res = await request(app).get(`/api/messaging/contracts/${contractId}`).set(auth(a.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.messages as ChatMessage[];
}

async function notificationsOf(
  a: Actor,
): Promise<{ type: string; title: string; data: Record<string, unknown> | null }[]> {
  const res = await request(app).get('/api/notifications').set(auth(a.token)).expect(200);
  return res.body.items;
}

afterAll(async () => {
  await pool.end();
});

describe('Moderação de avaliações e mensagens (ADR 44)', () => {
  it('avaliação removida sai da nota e do perfil, a contratação mostra a remoção e a contestação devolve', async () => {
    const client = await actor('client');
    const freelancer = await actor('freelancer');
    const admin = await actor('client', 'admin.escambo.test');
    await fundWallet(app, client.token, 500);
    const good = await completedContract(client, freelancer, 'Logo da padaria');
    const bad = await completedContract(client, freelancer, 'Cardápio da padaria');
    await request(app)
      .post('/api/reviews')
      .set(auth(client.token))
      .send({ contractId: good, rating: 5, comment: 'Excelente trabalho, recomendo.' })
      .expect(201);
    const created = await request(app)
      .post('/api/reviews')
      .set(auth(client.token))
      .send({ contractId: bad, rating: 1, comment: 'Um golpista, fujam dele.' })
      .expect(201);
    const reviewId = created.body.id as number;
    expect(await rating(freelancer)).toEqual([3, 2]);

    // O freelancer denuncia a avaliação e o admin remove.
    const reportId = await report(freelancer, 'review', reviewId);
    const removed = await act(
      admin,
      reportId,
      'remove-content',
      'Ofensa sem relação com o trabalho.',
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toEqual({
      status: 'actioned',
      reports: 1,
      referencesCleared: 0,
      fileRemoved: false,
      blocked: false,
      removalId: expect.any(Number),
      ownerStrikes: 1,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
    const removalId = removed.body.removalId as number;

    // Sai da nota e da lista pública; na contratação, as partes veem que foi removida.
    expect(await rating(freelancer)).toEqual([5, 1]);
    expect(await publicReviews(freelancer)).toEqual(['Excelente trabalho, recomendo.']);
    const contract = await request(app).get(`/api/contracts/${bad}`).set(auth(freelancer.token));
    expect(contract.body.review).toMatchObject({ comment: null, response: null });
    expect(contract.body.review.removedAt).toEqual(expect.any(String));
    const reply = await request(app)
      .post(`/api/reviews/${reviewId}/response`)
      .set(auth(freelancer.token))
      .send({ response: 'Não concordo com a avaliação.' });
    expect([reply.status, reply.body.error]).toEqual([409, 'review_removed']);

    // O autor é avisado e vê o texto removido; não bloqueia o envio de imagem.
    expect((await notificationsOf(client)).find((n) => n.type === 'content_removed')).toMatchObject(
      {
        title: 'Sua avaliação foi removida',
        data: { contentRemoved: 'review', removalId },
      },
    );
    const mine = await request(app)
      .get('/api/moderation/removals')
      .set(auth(client.token))
      .expect(200);
    expect(mine.body.removals[0]).toMatchObject({
      id: removalId,
      targetType: 'review',
      label: 'Avaliação',
      excerpt: 'Nota 1 de 5. Um golpista, fujam dele.',
      status: 'removed',
      canAppeal: true,
    });
    expect(mine.body.strikes).toMatchObject({
      strikes: 1,
      imageStrikes: 0,
      uploadsBlockedUntil: null,
    });

    // Contesta; o admin lê o texto (sem imagem) e reverte: a avaliação e a nota voltam.
    await appeal(
      client,
      removalId,
      'Fui mesmo lesado nessa contratação, a avaliação é verdadeira.',
    ).expect(200);
    const queue = await request(app).get('/api/admin/appeals').set(auth(admin.token)).expect(200);
    expect((queue.body as { id: number }[]).find((a) => a.id === removalId)).toMatchObject({
      targetType: 'review',
      excerpt: 'Nota 1 de 5. Um golpista, fujam dele.',
      imageUrl: null,
      hasImage: false,
    });
    await request(app)
      .get(`/api/admin/appeals/${removalId}/image`)
      .set(auth(admin.token))
      .expect(404);
    const decided = await decide(admin, removalId, 'overturn', 'Avaliação de experiência real.');
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body).toEqual({
      status: 'overturned',
      restoredReferences: 1,
      imageRestored: false,
      contentRestored: true,
      fileDeleted: false,
    });
    expect(await rating(freelancer)).toEqual([3, 2]);
    expect((await publicReviews(freelancer)).sort()).toEqual(
      ['Excelente trabalho, recomendo.', 'Um golpista, fujam dele.'].sort(),
    );
    expect((await notificationsOf(client)).find((n) => n.type === 'appeal_decided')).toMatchObject({
      title: 'Contestação aceita: seu conteúdo voltou',
      data: { removalId, decision: 'overturned' },
    });
  });

  it('mensagem removida vira aviso para as duas partes, o anexo sai do ar e a remoção mantida continua contando', async () => {
    const client = await actor('client');
    const freelancer = await actor('freelancer');
    const admin = await actor('client', 'admin.escambo.test');
    await fundWallet(app, client.token, 200);
    const contractId = await createContract(client, freelancer, 'Site da oficina');

    const text = await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .send({ content: 'Me paga no pix por fora que sai mais barato.' });
    expect([200, 201], JSON.stringify(text.body)).toContain(text.status);
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#3a7' },
    })
      .png()
      .toBuffer();
    const file = await request(app)
      .post(`/api/messaging/contracts/${contractId}/attachments`)
      .set(auth(freelancer.token))
      .field('content', 'chave do pix')
      .attach('file', png, { filename: 'pix.png', contentType: 'image/png' });
    expect([200, 201], JSON.stringify(file.body)).toContain(file.status);

    // Denúncia que não é de texto não remove conteúdo; a de mensagem não remove imagem.
    const userReport = await report(client, 'user', freelancer.id);
    const wrong = await act(admin, userReport, 'remove-content');
    expect([wrong.status, wrong.body.error]).toEqual([422, 'not_a_content_report']);
    const textReport = await report(client, 'message', text.body.id);
    const notImage = await act(admin, textReport, 'remove-image');
    expect([notImage.status, notImage.body.error]).toEqual([422, 'not_an_image_report']);

    const first = await act(admin, textReport, 'remove-content');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const fileReport = await report(client, 'message', file.body.id);
    const second = await act(admin, fileReport, 'remove-content', 'Chave de pagamento por fora.');
    expect(second.body).toMatchObject({ ownerStrikes: 2, uploadsBlockedUntil: null });

    // As duas partes veem o aviso, sem texto nem anexo; o anexo não abre mais.
    for (const who of [client, freelancer]) {
      const messages = await history(who, contractId);
      for (const id of [text.body.id, file.body.id]) {
        expect(messages.find((m) => m.id === id)).toMatchObject({
          content: '',
          attachment: null,
          removedAt: expect.any(String),
        });
      }
    }
    const download = await request(app)
      .get(`/api/messaging/attachments/${file.body.id}`)
      .set(auth(client.token));
    expect([download.status, download.body.error]).toEqual([410, 'message_removed']);

    // O autor vê as duas; duas remoções de texto não bloqueiam o envio de imagem.
    const mine = await request(app)
      .get('/api/moderation/removals')
      .set(auth(freelancer.token))
      .expect(200);
    expect(
      (mine.body.removals as { excerpt: string; label: string }[]).map((r) => [r.label, r.excerpt]),
    ).toEqual([
      ['Mensagem no chat', 'chave do pix'],
      ['Mensagem no chat', 'Me paga no pix por fora que sai mais barato.'],
    ]);
    expect(mine.body.strikes).toMatchObject({
      strikes: 2,
      imageStrikes: 0,
      uploadsBlockedUntil: null,
    });
    await request(app)
      .post('/api/media')
      .set(auth(freelancer.token))
      .field('purpose', 'portfolio')
      .attach('file', png, { filename: 'arte.png', contentType: 'image/png' })
      .expect(201);

    // Contestação mantida: a mensagem segue fora do ar e a remoção segue contando.
    const removalId = second.body.removalId as number;
    await appeal(
      freelancer,
      removalId,
      'Era só a chave para o reembolso combinado com o cliente.',
    ).expect(200);
    const upheld = await decide(admin, removalId, 'uphold', 'Pagamento fora da plataforma.');
    expect(upheld.body).toEqual({
      status: 'upheld',
      restoredReferences: 0,
      imageRestored: false,
      contentRestored: false,
      fileDeleted: false,
    });
    expect(
      (await history(client, contractId)).find((m) => m.id === file.body.id)!.removedAt,
    ).not.toBeNull();
    const after = await request(app)
      .get('/api/moderation/removals')
      .set(auth(freelancer.token))
      .expect(200);
    expect(after.body.strikes.strikes).toBe(2);
  });
});
