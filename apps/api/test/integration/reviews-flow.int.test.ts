import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * Avaliações fecham o ciclo do contrato: aprovação → nota do cliente → reputação do freelancer
 * (perfil, card do serviço e Escambo Score). Regras: só o cliente avalia, só contratação
 * concluída, uma avaliação por contrato, freelancer responde uma vez.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `rev_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

/** Contratação levada até 'completed' (create → accept → deliver → approve). */
async function completedContract(
  client: Actor,
  freelancer: Actor,
  serviceId: number,
): Promise<number> {
  const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
    freelancerId: freelancer.id,
    serviceId,
    title: 'Serviço para avaliar',
    description: 'Contratação criada pelo teste de integração de avaliações',
    price: 300,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
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

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Avaliações (reviews) — fecham o ciclo da contratação', () => {
  it('cliente avalia contratação concluída; a nota chega ao perfil, ao detalhe do contrato e ao card do serviço', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');

    const profile = await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(freelancer.token))
      .send({ fullName: 'Fulana Freela', city: 'Joinville' });
    expect(profile.status, JSON.stringify(profile.body)).toBeLessThan(300);

    const cats = await request(app).get('/api/categories');
    const svc = await request(app)
      .post('/api/services')
      .set(auth(freelancer.token))
      .send({
        categoryId: cats.body[0].id,
        title: `Serviço avaliado ${Date.now()}`,
        description: 'Serviço criado para o teste de avaliações',
        priceType: 'fixed',
        price: 300,
        deliveryDays: 3,
        isRemote: true,
      });
    expect(svc.status, JSON.stringify(svc.body)).toBe(201);

    // Contrato ainda pendente não pode ser avaliado.
    const pending = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Ainda pendente',
        description: 'Não concluída ainda.',
        price: 100,
      });
    expect(pending.status).toBe(201);
    const early = await request(app)
      .post('/api/reviews')
      .set(auth(client.token))
      .send({ contractId: pending.body.id, rating: 5 });
    expect(early.status).toBe(409);

    const contractId = await completedContract(client, freelancer, svc.body.id);

    // Antes de avaliar: sem review no detalhe e hasReview=false na lista.
    const before = await request(app).get(`/api/contracts/${contractId}`).set(auth(client.token));
    expect(before.status).toBe(200);
    expect(before.body.review).toBeNull();
    expect(before.body.hasReview).toBe(false);

    // Freelancer não avalia a própria contratação.
    const byFreelancer = await request(app)
      .post('/api/reviews')
      .set(auth(freelancer.token))
      .send({ contractId, rating: 5 });
    expect(byFreelancer.status).toBe(403);

    // Cliente avalia.
    const review = await request(app)
      .post('/api/reviews')
      .set(auth(client.token))
      .send({ contractId, rating: 4, comment: 'Ótimo trabalho, entrega no prazo.' });
    expect(review.status, JSON.stringify(review.body)).toBe(201);
    expect(review.body).toMatchObject({
      contractId,
      rating: 4,
      revieweeId: freelancer.id,
      response: null,
    });

    // Uma avaliação por contrato.
    const again = await request(app)
      .post('/api/reviews')
      .set(auth(client.token))
      .send({ contractId, rating: 1 });
    expect(again.status).toBe(409);

    // Detalhe e lista refletem a avaliação.
    const detail = await request(app)
      .get(`/api/contracts/${contractId}`)
      .set(auth(freelancer.token));
    expect(detail.body.hasReview).toBe(true);
    expect(detail.body.review).toMatchObject({
      rating: 4,
      comment: 'Ótimo trabalho, entrega no prazo.',
    });
    const list = await request(app).get('/api/contracts').set(auth(client.token));
    const row = (list.body.items as { id: number; hasReview: boolean }[]).find(
      (c) => c.id === contractId,
    );
    expect(row?.hasReview).toBe(true);

    // Perfil do freelancer: nota média e contagem recalculadas na mesma transação.
    const me = await request(app).get('/api/profiles/me').set(auth(freelancer.token));
    expect(me.status).toBe(200);
    expect(me.body.freelancer).toMatchObject({ avgRating: 4, totalReviews: 1 });

    // Card do serviço mostra quem presta e a reputação.
    const search = await request(app).get('/api/services').query({ q: svc.body.title });
    expect(search.status).toBe(200);
    expect(search.body.items[0]).toMatchObject({
      id: svc.body.id,
      ownerName: 'Fulana Freela',
      ownerRating: 4,
      ownerReviews: 1,
    });

    // Resposta do freelancer: uma vez, só ele.
    const reviewId = review.body.id as number;
    const clientReply = await request(app)
      .post(`/api/reviews/${reviewId}/response`)
      .set(auth(client.token))
      .send({ response: 'Eu não posso responder' });
    expect(clientReply.status).toBe(403);
    const reply = await request(app)
      .post(`/api/reviews/${reviewId}/response`)
      .set(auth(freelancer.token))
      .send({ response: 'Obrigada! Foi um prazer.' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const replyAgain = await request(app)
      .post(`/api/reviews/${reviewId}/response`)
      .set(auth(freelancer.token))
      .send({ response: 'De novo' });
    expect(replyAgain.status).toBe(409);

    // Lista pública de avaliações do freelancer traz a resposta; o detalhe do contrato também.
    const pub = await request(app).get('/api/reviews').query({ freelancerId: freelancer.id });
    expect(pub.status).toBe(200);
    expect(pub.body.items[0]).toMatchObject({
      id: reviewId,
      rating: 4,
      response: 'Obrigada! Foi um prazer.',
    });
    const detail2 = await request(app).get(`/api/contracts/${contractId}`).set(auth(client.token));
    expect(detail2.body.review.response).toBe('Obrigada! Foi um prazer.');
  });
});
