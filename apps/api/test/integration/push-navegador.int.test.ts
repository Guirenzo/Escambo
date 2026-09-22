import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { notificationsService } from '../../src/modules/notifications/notifications.service';

/**
 * Avisos push no navegador (ADR 52) contra o MySQL real, com o provedor simulado: assinar,
 * reassinar o mesmo aparelho, receber o push junto com a notificação in-app (o envio marca a
 * assinatura), o aviso de teste, desligar e o isolamento entre contas.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const password = 'senha-integracao-123';
let seq = 0;

async function actor(): Promise<{ id: number; token: string }> {
  const email = `int_push_${Date.now()}_${seq++}@escambo.test`;
  await request(app).post('/api/auth/register').send({ email, password }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

const device = (tag: string) => ({
  endpoint: `https://push.escambo.test/${tag}-${Date.now()}-${seq++}`,
  p256dh: 'BExemploDeChavePublicaDoAparelho1234567890',
  auth: 'segredoDoAparelho123',
});

const devicesOf = async (userId: number): Promise<number> => {
  const [rows] = await pool.query<{ n: number }[] & { length: number }>(
    'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = :userId',
    { userId },
  );
  return Number(rows[0]?.n ?? 0);
};

const lastSent = async (endpoint: string): Promise<Date | null> => {
  const [rows] = await pool.query<{ last_sent_at: Date | null }[] & { length: number }>(
    'SELECT last_sent_at FROM push_subscriptions WHERE endpoint = :endpoint',
    { endpoint },
  );
  return rows[0]?.last_sent_at ?? null;
};

afterAll(async () => {
  await pool.end();
});

describe('Avisos push no navegador (ADR 52)', () => {
  it('assina, recebe junto com a notificação, testa, desliga e não vaza entre contas', async () => {
    const dono = await actor();
    const outro = await actor();
    const status = () => request(app).get('/api/notifications/push').set(auth(dono.token));

    const first = (await status().expect(200)).body as {
      devices: number;
      publicKey: string;
      subscribed: boolean;
    };
    expect(first.devices).toBe(0);
    expect(first.publicKey.length).toBeGreaterThan(20);
    expect(first.subscribed).toBe(false);

    // Dois aparelhos da mesma conta; reassinar o primeiro atualiza em vez de duplicar.
    const celular = device('celular');
    const note = device('note');
    for (const d of [
      celular,
      note,
      { ...celular, p256dh: 'BChaveRenovadaPeloNavegador0000000000' },
    ]) {
      await request(app).post('/api/notifications/push').set(auth(dono.token)).send(d).expect(201);
    }
    expect(((await status().expect(200)).body as { devices: number }).devices).toBe(2);

    // A notificação in-app leva o push junto: o provedor simulado marca as assinaturas.
    expect(await lastSent(celular.endpoint)).toBeNull();
    await notificationsService.notify(dono.id, {
      type: 'contract_proposal',
      title: 'Proposta de contratação',
      body: 'Alguém quer contratar você',
      data: { contractId: 123 },
    });
    await expect
      .poll(async () => (await lastSent(celular.endpoint)) !== null, { timeout: 5000 })
      .toBe(true);
    expect(await lastSent(note.endpoint)).not.toBeNull();

    // Tipo de ruído (chat) não bate no aparelho: a marca não muda.
    const before = await lastSent(note.endpoint);
    await notificationsService.notify(dono.id, {
      type: 'message_received',
      title: 'Nova mensagem',
      body: 'oi',
    });
    expect(await lastSent(note.endpoint)).toEqual(before);

    // Aviso de teste sai para os dois aparelhos.
    const test = await request(app)
      .post('/api/notifications/push/test')
      .set(auth(dono.token))
      .expect(200);
    expect(test.body).toMatchObject({ sent: 2, removed: 0, failed: 0 });

    // A conta vizinha não vê nem apaga aparelho alheio.
    expect(
      (
        (await request(app).get('/api/notifications/push').set(auth(outro.token)).expect(200))
          .body as { devices: number }
      ).devices,
    ).toBe(0);
    await request(app)
      .delete('/api/notifications/push')
      .set(auth(outro.token))
      .send({ endpoint: celular.endpoint })
      .expect(404);
    expect(((await status().expect(200)).body as { devices: number }).devices).toBe(2);

    // Desligar o aparelho tira só ele.
    await request(app)
      .delete('/api/notifications/push')
      .set(auth(dono.token))
      .send({ endpoint: celular.endpoint })
      .expect(204);
    expect(((await status().expect(200)).body as { devices: number }).devices).toBe(1);

    // Endpoint inválido é 422; endereço que não é https também; sem sessão, 401.
    await request(app)
      .post('/api/notifications/push')
      .set(auth(dono.token))
      .send({ endpoint: 'nao-e-url', p256dh: 'x', auth: 'y' })
      .expect(422);
    await request(app)
      .post('/api/notifications/push')
      .set(auth(dono.token))
      .send({ ...device('interno'), endpoint: 'https://127.0.0.1/interno' })
      .expect(422);
    await request(app).get('/api/notifications/push').expect(401);
  });

  it('o aparelho emprestado não aparece ligado para quem não assinou nele', async () => {
    const ana = await actor();
    const bruno = await actor();
    const aparelho = device('emprestado');
    await request(app)
      .post('/api/notifications/push')
      .set(auth(ana.token))
      .send(aparelho)
      .expect(201);

    const paraAna = await request(app)
      .get('/api/notifications/push')
      .query({ endpoint: aparelho.endpoint })
      .set(auth(ana.token))
      .expect(200);
    expect(paraAna.body).toMatchObject({ devices: 1, subscribed: true });

    // Mesmo navegador, outra conta: a assinatura guardada não é dela.
    const paraBruno = await request(app)
      .get('/api/notifications/push')
      .query({ endpoint: aparelho.endpoint })
      .set(auth(bruno.token))
      .expect(200);
    expect(paraBruno.body).toMatchObject({ devices: 0, subscribed: false });
  });

  it('sair de todos os aparelhos desliga os avisos junto', async () => {
    const dono = await actor();
    for (const tag of ['casa', 'trabalho']) {
      await request(app)
        .post('/api/notifications/push')
        .set(auth(dono.token))
        .send(device(tag))
        .expect(201);
    }
    const status = () => request(app).get('/api/notifications/push').set(auth(dono.token));
    expect(((await status().expect(200)).body as { devices: number }).devices).toBe(2);

    // Sair de todos costuma ser aparelho perdido: as sessões caem e os avisos também.
    await request(app).post('/api/auth/logout-all').set(auth(dono.token)).expect(200);

    expect(await devicesOf(dono.id)).toBe(0);
    expect(((await status().expect(200)).body as { devices: number }).devices).toBe(0);
  });
});
