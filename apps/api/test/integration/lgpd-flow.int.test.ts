import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runExpireExports } from '../../src/jobs/expire-exports';
import { waitForNotification } from './notifications.helpers';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
  email: string;
  password: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_lgpd_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken, email, password };
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('LGPD: direitos do titular processados de verdade', () => {
  it('portabilidade: cópia gerada na hora, download só do titular, vence e o job apaga', async () => {
    const user = await registerAndLogin('freelancer');
    const other = await registerAndLogin('client');
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(user.token))
      .send({ fullName: 'Titular Exportável', city: 'Joinville' })
      .expect((r) => expect(r.status).toBeLessThan(300));
    await fundWallet(app, user.token, 40);

    const created = await request(app).post('/api/lgpd/export-requests').set(auth(user.token));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'ready' });
    expect(created.body.downloadUrl).toBe(`/api/lgpd/export-requests/${created.body.id}/download`);
    expect(new Date(created.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const id = created.body.id as number;
    expect(await waitForNotification(app, user.token, 'export_ready')).toBe(true);

    // Outro usuário não baixa; sem token, 401.
    await request(app)
      .get(`/api/lgpd/export-requests/${id}/download`)
      .set(auth(other.token))
      .expect(403);
    await request(app).get(`/api/lgpd/export-requests/${id}/download`).expect(401);

    // O titular baixa um JSON com os próprios dados.
    const dl = await request(app)
      .get(`/api/lgpd/export-requests/${id}/download`)
      .set(auth(user.token));
    expect(dl.status, dl.text.slice(0, 200)).toBe(200);
    expect(dl.headers['content-type']).toContain('application/json');
    expect(dl.headers['content-disposition']).toMatch(
      /attachment; filename="escambo-dados-\d{4}-\d{2}-\d{2}\.json"/,
    );
    const data = JSON.parse(dl.text) as {
      formato: string;
      titular: { email: string };
      perfis: { freelancer: { full_name: string } | null };
      consentimentos: unknown[];
      carteira: { extratoReais: { reason: string }[]; depositos: unknown[] };
    };
    expect(data.formato).toBe('escambo-export/1.0');
    expect(data.titular.email).toBe(user.email);
    expect(data.perfis.freelancer?.full_name).toBe('Titular Exportável');
    expect(data.carteira.extratoReais.map((t) => t.reason)).toEqual(['deposit']);
    expect(data.carteira.depositos).toHaveLength(1);

    // Lista reflete o download; depois de vencer, some o link e o job apaga o arquivo.
    const list = await request(app).get('/api/lgpd/export-requests').set(auth(user.token));
    expect(list.body[0]).toMatchObject({ id, status: 'downloaded' });
    await pool.query(
      `UPDATE data_export_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = :id`,
      { id },
    );
    const stale = await request(app).get('/api/lgpd/export-requests').set(auth(user.token));
    expect(stale.body[0]).toMatchObject({ id, status: 'expired', downloadUrl: null });
    await request(app)
      .get(`/api/lgpd/export-requests/${id}/download`)
      .set(auth(user.token))
      .expect(410);
    const job = await runExpireExports();
    expect(job.expired).toBeGreaterThanOrEqual(1);
    const [rows] = await pool.query<{ status: string; file_url: string | null }[] & unknown[]>(
      `SELECT status, file_url FROM data_export_requests WHERE id = :id`,
      { id },
    );
    expect((rows as { status: string; file_url: string | null }[])[0]).toMatchObject({
      status: 'expired',
      file_url: null,
    });
  });

  it('exclusão: barrada com contratação aberta ou saldo; admin conclui e a conta some; recusa avisa', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const busyFreelancer = await registerAndLogin('freelancer'); // fica com o contrato aberto
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(freelancer.token))
      .send({ fullName: 'Freela Que Sai', city: 'Joinville' })
      .expect((r) => expect(r.status).toBeLessThan(300));
    const me = await request(app).get('/api/auth/me').set(auth(freelancer.token));
    const freelancerUlid = me.body.ulid as string;

    // Cliente com contratação aberta não consegue pedir exclusão (nem com saldo parado).
    await fundWallet(app, client.token, 100);
    const contract = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: busyFreelancer.id,
      title: 'Contrato aberto',
      description: 'Contratação do teste de exclusão LGPD',
      price: 60,
    });
    expect(contract.status).toBe(201);
    const blocked = await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(client.token))
      .send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('deletion_blocked');
    expect(blocked.body.message).toContain('1 contratação(ões)');

    // Freelancer sem pendências pede a exclusão; aparece na fila do admin com as pendências zeradas.
    const asked = await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(freelancer.token))
      .send({ reason: 'Vou parar de trabalhar como freelancer.' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const deletionId = asked.body.id as number;
    await request(app).get('/api/admin/deletion-requests').set(auth(freelancer.token)).expect(403);
    const queue = await request(app).get('/api/admin/deletion-requests').set(auth(admin.token));
    expect(queue.status).toBe(200);
    const mine = queue.body.find((r: { id: number }) => r.id === deletionId);
    expect(mine).toMatchObject({
      userEmail: freelancer.email,
      userName: 'Freela Que Sai',
      activeContracts: 0,
      balance: 0,
      status: 'pending',
    });

    // Admin conclui: conta anonimizada, token vigente bloqueado, login e refresh negados, perfil some.
    const done = await request(app)
      .post(`/api/admin/deletion-requests/${deletionId}/complete`)
      .set(auth(admin.token));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('completed');
    await request(app).get('/api/auth/me').set(auth(freelancer.token)).expect(403);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: freelancer.email, password: freelancer.password });
    expect(login.status).toBe(401); // e-mail não existe mais
    await request(app).get(`/api/profiles/freelancer/${freelancerUlid}`).expect(404);
    const [users] = await pool.query<unknown[]>(
      `SELECT email, phone, password_hash, status, deleted_at FROM users WHERE id = :id`,
      { id: freelancer.id },
    );
    expect(
      (
        users as {
          email: string;
          password_hash: string | null;
          status: string;
          deleted_at: Date | null;
        }[]
      )[0],
    ).toMatchObject({
      email: `removido+${freelancer.id}@anon.escambo.invalid`,
      password_hash: null,
      status: 'banned',
    });
    await request(app)
      .post(`/api/admin/deletion-requests/${deletionId}/complete`)
      .set(auth(admin.token))
      .expect(409);

    // Recusa com justificativa: outro titular pede, admin recusa, titular vê a nota e é avisado.
    const another = await registerAndLogin('client');
    const ask2 = await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(another.token))
      .send({});
    expect(ask2.status).toBe(201);
    await request(app)
      .post(`/api/admin/deletion-requests/${ask2.body.id}/reject`)
      .set(auth(admin.token))
      .send({ note: 'x' })
      .expect(422);
    const rejected = await request(app)
      .post(`/api/admin/deletion-requests/${ask2.body.id}/reject`)
      .set(auth(admin.token))
      .send({ note: 'Há uma denúncia em análise sobre esta conta.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      adminNote: 'Há uma denúncia em análise sobre esta conta.',
    });
    const list = await request(app).get('/api/lgpd/deletion-requests').set(auth(another.token));
    expect(list.body[0]).toMatchObject({
      status: 'rejected',
      adminNote: 'Há uma denúncia em análise sobre esta conta.',
    });
    expect(await waitForNotification(app, another.token, 'deletion_rejected')).toBe(true);
    // Pode pedir de novo depois de uma recusa.
    await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(another.token))
      .send({})
      .expect(201);
  });
});
