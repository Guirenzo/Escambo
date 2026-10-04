import request from 'supertest';
import type { RowDataPacket } from 'mysql2';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PASS = 'senha-integracao-123';

let seq = 0;
async function freelancerComId(): Promise<{ id: number; token: string }> {
  const email = `boost_${Date.now()}_${seq++}@escambo.test`;
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASS, role: 'freelancer' })
    .expect(201);
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASS })
    .expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function freelancer(): Promise<string> {
  return (await freelancerComId()).token;
}

/**
 * Espera até haver `n` pedidos de trava parados neste banco: é como o teste sabe que cada
 * requisição chegou ao ponto em que espera a outra, sem depender de tempo.
 */
async function esperarTravasParadas(n: number): Promise<void> {
  const limite = Date.now() + 10_000;
  for (;;) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM performance_schema.data_locks
        WHERE OBJECT_SCHEMA = DATABASE() AND LOCK_STATUS = 'WAITING'`,
    );
    const paradas = Number(rows[0]!.n);
    if (paradas >= n) return;
    if (Date.now() > limite) {
      throw new Error(`esperava ${n} pedido(s) de trava parado(s), há ${paradas}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createService(token: string, title: string): Promise<number> {
  const res = await request(app).post('/api/services').set(auth(token)).send({
    categoryId: 10,
    title,
    description: 'Serviço de teste para impulsionamento',
    priceType: 'fixed',
    price: 100,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function credits(token: string): Promise<number> {
  const res = await request(app).get('/api/wallet').set(auth(token));
  return res.body.credits;
}

async function planId(token: string, durationDays: number): Promise<number> {
  const res = await request(app).get('/api/boosts/plans').set(auth(token));
  const plan = (res.body as { id: number; durationDays: number }[]).find(
    (p) => p.durationDays === durationDays,
  );
  return plan!.id;
}

afterAll(async () => {
  await pool.end();
});

describe('Impulsionamento (Boosts) pago em créditos', () => {
  it('lista os planos com custo em créditos', async () => {
    const token = await freelancer();
    const res = await request(app).get('/api/boosts/plans').set(auth(token));
    expect(res.status).toBe(200);
    const p7 = (res.body as { durationDays: number; costCredits: number }[]).find(
      (p) => p.durationDays === 7,
    );
    expect(p7?.costCredits).toBe(30); // round(29.90)
  });

  it('compra debita créditos, ativa o boost e coloca o serviço no topo da busca', async () => {
    const a = await freelancer();
    await credits(a); // concede o bônus (100)
    const serviceA = await createService(a, 'BoostRank Alpha');
    const p7 = await planId(a, 7);

    const buy = await request(app)
      .post('/api/boosts')
      .set(auth(a))
      .send({ serviceId: serviceA, planId: p7 });
    expect(buy.status).toBe(201);
    expect(buy.body).toMatchObject({ serviceId: serviceA, status: 'active' });
    expect(await credits(a)).toBe(70); // 100 - 30

    const mine = await request(app).get('/api/boosts').set(auth(a));
    expect(mine.body).toHaveLength(1);

    // Um segundo serviço, mais novo, SEM boost.
    const b = await freelancer();
    await createService(b, 'BoostRank Beta');

    // Busca isolada: o impulsionado (mais antigo) vem antes do mais novo.
    const search = await request(app).get('/api/services?q=BoostRank');
    expect(search.status).toBe(200);
    const titles = (search.body.items as { title: string; boosted?: boolean }[]).map(
      (s) => s.title,
    );
    expect(titles.indexOf('BoostRank Alpha')).toBeLessThan(titles.indexOf('BoostRank Beta'));
    const alpha = (search.body.items as { title: string; boosted?: boolean }[]).find(
      (s) => s.title === 'BoostRank Alpha',
    );
    expect(alpha?.boosted).toBe(true);
  });

  it('recusa com 409 quando faltam créditos', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Sem Saldo');
    const other = await createService(f, 'BoostRank Sem Saldo 2');
    const p30 = await planId(f, 30); // custa 100 créditos

    await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p30 })
      .expect(201); // 100 -> 0
    // Outro serviço (o mesmo cairia na RN-017): agora o que barra é o saldo.
    const again = await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: other, planId: p30 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('insufficient_credits');
  });

  it('RN-017: com um impulsionamento ativo no serviço, o segundo é recusado com 409 e nada é cobrado', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Ativo');
    const p7 = await planId(f, 7);

    const first = await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p7 })
      .expect(201);
    const again = await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p7 });

    expect(again.status).toBe(409);
    expect(again.body.error).toBe('boost_active');
    expect(again.body.message).toMatch(
      /^Este serviço já tem um impulsionamento ativo até \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}; um novo só depois que ele terminar \(RN-017\)$/,
    );
    expect(await credits(f)).toBe(70); // só a primeira compra
    const mine = await request(app).get('/api/boosts').set(auth(f));
    expect((mine.body as { id: number }[]).map((b) => b.id)).toEqual([first.body.id]);

    // Depois que o atual termina, um novo pode ser contratado.
    await pool.query(`UPDATE boosts SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = :id`, {
      id: first.body.id,
    });
    await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p7 })
      .expect(201);
    expect(await credits(f)).toBe(40);
  });

  it('RN-017 sem corrida: compras simultâneas do mesmo serviço criam um impulsionamento só e cobram uma vez', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Corrida');
    const p7 = await planId(f, 7); // 30 créditos: o saldo daria para três

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        request(app).post('/api/boosts').set(auth(f)).send({ serviceId: service, planId: p7 }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.error)).toEqual([
      'boost_active',
      'boost_active',
    ]);
    expect(await credits(f)).toBe(70);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM boosts WHERE service_id = :service`,
      { service },
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('RN-017 com as duas compras paradas na mesma trava: a segunda espera a primeira terminar e vê o impulsionamento dela', async () => {
    const f = await freelancerComId();
    await credits(f.token); // 100
    const service = await createService(f.token, 'BoostRank Fila');
    const p7 = await planId(f.token, 7); // 30 créditos: o saldo daria para três

    // Uma terceira conexão segura a carteira em modo compartilhado: as duas compras passam pela
    // criação da carteira e param juntas no FOR UPDATE, as duas já com a transação aberta.
    const segura = await pool.getConnection();
    try {
      await segura.beginTransaction();
      await segura.query(`SELECT credits_balance FROM wallets WHERE user_id = :id FOR SHARE`, {
        id: f.id,
      });
      const compras = [0, 1].map(() =>
        request(app)
          .post('/api/boosts')
          .set(auth(f.token))
          .send({ serviceId: service, planId: p7 })
          .then((res) => res),
      );
      await esperarTravasParadas(2);
      await segura.commit();

      const results = await Promise.all(compras);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.error).toBe('boost_active');
    } finally {
      // Se algo falhou no meio, a trava não pode ficar presa na conexão que volta para o pool.
      await segura.rollback().catch(() => undefined);
      segura.release();
    }
    expect(await credits(f.token)).toBe(70);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM boosts WHERE service_id = :service`,
      { service },
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('comprar o impulsionamento do serviço pedido enquanto aceita a troca que paga a torna não dá deadlock', async () => {
    const proponente = await freelancerComId();
    const receptor = await freelancerComId(); // paga a torna no aceite e impulsiona o serviço pedido
    await credits(receptor.token); // 100 créditos
    await fundWallet(app, receptor.token, 100); // R$ 100 para a torna
    const oferecido = await createService(proponente.token, 'BoostTroca Oferecido');
    const pedido = await createService(receptor.token, 'BoostTroca Pedido');
    const p7 = await planId(receptor.token, 7);
    const proposta = await request(app).post('/api/barters').set(auth(proponente.token)).send({
      receiverId: receptor.id,
      offeredServiceId: oferecido,
      requestedServiceId: pedido,
      offeredDescription: 'Ofereço o serviço de 300',
      requestedDescription: 'Quero o serviço de 200',
      estimatedValueOffered: 300,
      estimatedValueRequested: 200,
    });
    expect(proposta.status, JSON.stringify(proposta.body)).toBe(201);
    expect(proposta.body).toMatchObject({ cashPayerId: receptor.id, tornaStatus: 'pending' });

    // Fixa a ordem que fechava o ciclo: segurando o usuário do proponente, o aceite reserva a
    // torna (trava a carteira do receptor) e para no primeiro contrato da troca; a compra começa
    // aí e para na carteira. Solto o proponente, o aceite cria o contrato do serviço pedido, que
    // pede o serviço pela chave estrangeira. Se a compra tivesse travado o serviço, cada um
    // esperaria o outro e o MySQL derrubaria um deles (ER_LOCK_DEADLOCK, 500).
    const segura = await pool.getConnection();
    try {
      await segura.beginTransaction();
      await segura.query(`SELECT id FROM users WHERE id = :id FOR UPDATE`, { id: proponente.id });
      const aceite = request(app)
        .post(`/api/barters/${proposta.body.id}/accept`)
        .set(auth(receptor.token))
        .then((res) => res);
      await esperarTravasParadas(1);
      const compra = request(app)
        .post('/api/boosts')
        .set(auth(receptor.token))
        .send({ serviceId: pedido, planId: p7 })
        .then((res) => res);
      await esperarTravasParadas(2);
      await segura.commit();

      const [aceitou, comprou] = await Promise.all([aceite, compra]);
      expect(aceitou.status, JSON.stringify(aceitou.body)).toBe(200);
      expect(aceitou.body).toMatchObject({ status: 'active', tornaStatus: 'held' });
      expect(comprou.status, JSON.stringify(comprou.body)).toBe(201);
      expect(comprou.body).toMatchObject({ serviceId: pedido, status: 'active' });
    } finally {
      // Se algo falhou no meio, a trava não pode ficar presa na conexão que volta para o pool.
      await segura.rollback().catch(() => undefined);
      segura.release();
    }
    const carteira = await request(app).get('/api/wallet').set(auth(receptor.token));
    expect(carteira.body).toMatchObject({ credits: 70, balance: 0, balancePending: 100 });
  });

  it('serviço pausado não é impulsionado (409 service_inactive) e nada é cobrado', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Pausado');
    await request(app)
      .patch(`/api/services/${service}`)
      .set(auth(f))
      .send({ isActive: false })
      .expect(200);
    const p7 = await planId(f, 7);

    const res = await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p7 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('service_inactive');
    expect(await credits(f)).toBe(100);
  });

  it('não deixa impulsionar serviço de outro (403)', async () => {
    const owner = await freelancer();
    await credits(owner);
    const service = await createService(owner, 'BoostRank Alheio');
    const other = await freelancer();
    await credits(other);
    const p7 = await planId(other, 7);
    const res = await request(app)
      .post('/api/boosts')
      .set(auth(other))
      .send({ serviceId: service, planId: p7 });
    expect(res.status).toBe(403);
  });
});
