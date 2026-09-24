import { stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runPurgeAttachments } from '../../src/jobs/purge-attachments';
import { attachmentPath, uploadsDir } from '../../src/modules/messaging/attachments.storage';
import { fundWallet } from './wallet.helpers';

/**
 * Expurgo de anexos (ADR 31) contra MySQL e disco reais: retenção só sem contratação aberta,
 * LGPD leva os arquivos do titular na anonimização, órfãos no disco, painel e botão do admin.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 9),
]);
const DAY_MS = 86_400_000;

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer', admin = false): Promise<Actor> {
  const email = admin
    ? `purge_admin_${Date.now()}_${seq++}@admin.escambo.test`
    : `purge_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function makeContract(price = 400): Promise<{
  client: Actor;
  freelancer: Actor;
  contractId: number;
}> {
  const client = await registerAndLogin('client');
  const freelancer = await registerAndLogin('freelancer');
  await fundWallet(app, client.token, price);
  const created = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: 'Projeto com anexos a expurgar',
      description: 'Contrato usado para exercitar a retenção dos anexos do chat',
      price,
    })
    .expect(201);
  return { client, freelancer, contractId: created.body.id };
}

async function finish(contractId: number, client: Actor, freelancer: Actor): Promise<void> {
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

async function upload(
  contractId: number,
  who: Actor,
  name: string,
): Promise<{ id: number; url: string; key: string }> {
  const res = await request(app)
    .post(`/api/messaging/contracts/${contractId}/attachments`)
    .set(auth(who.token))
    .attach('file', PNG, { filename: name, contentType: 'image/png' })
    .expect(201);
  const [rows] = await pool.query('SELECT file_url FROM messages WHERE id = ?', [res.body.id]);
  return {
    id: res.body.id,
    url: res.body.attachment.url,
    key: (rows as { file_url: string }[])[0]!.file_url,
  };
}

const backdate = (messageId: number, days: number) =>
  pool.query('UPDATE messages SET created_at = ? WHERE id = ?', [
    new Date(Date.now() - days * DAY_MS),
    messageId,
  ]);

const exists = async (key: string): Promise<boolean> => {
  try {
    await stat(attachmentPath(key)!);
    return true;
  } catch {
    return false;
  }
};

afterAll(async () => {
  await pool.end();
});

describe('Expurgo de anexos (ADR 31)', () => {
  it('retenção: anexo velho fica enquanto há contratação aberta; encerrada, sai do disco e a mensagem diz por quê', async () => {
    const { client, freelancer, contractId } = await makeContract();
    const a = await upload(contractId, client, 'rascunho.png');
    await backdate(a.id, 200);

    // Contrato ainda pendente entre os dois: nada é removido.
    const first = await runPurgeAttachments({ force: true, trigger: 'admin' });
    expect(first.skipped).toBeNull();
    expect(await exists(a.key)).toBe(true);
    await request(app).get(a.url).set(auth(freelancer.token)).expect(200);

    await finish(contractId, client, freelancer);
    const second = await runPurgeAttachments({ force: true, trigger: 'admin' });
    expect(second.purged).toBeGreaterThanOrEqual(1);
    expect(await exists(a.key)).toBe(false);

    const gone = await request(app).get(a.url).set(auth(freelancer.token));
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe('attachment_purged');
    expect(gone.body.message).toContain('retenção');

    const history = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .expect(200);
    const msg = history.body.messages.find((m: { id: number }) => m.id === a.id);
    expect(msg.type).toBe('image');
    expect(msg.attachment).toMatchObject({ name: 'rascunho.png', purgedReason: 'retention' });
    expect(typeof msg.attachment.purgedAt).toBe('string');

    // Anexo recente no mesmo par não é tocado, mesmo com o contrato encerrado.
    const recent = await upload(contractId, freelancer, 'entrega.png');
    await runPurgeAttachments({ force: true });
    expect(await exists(recent.key)).toBe(true);
  });

  it('LGPD: anonimização do titular leva os arquivos que ele enviou; os da outra parte ficam', async () => {
    const { client, freelancer, contractId } = await makeContract();
    const mine = await upload(contractId, client, 'documento.png');
    const theirs = await upload(contractId, freelancer, 'proposta.png');
    await finish(contractId, client, freelancer); // cliente fica sem saldo e sem contrato aberto

    const req = await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(client.token))
      .send({ reason: 'Não uso mais' })
      .expect(201);
    const admin = await registerAndLogin('client', true);
    await request(app)
      .post(`/api/admin/deletion-requests/${req.body.id}/complete`)
      .set(auth(admin.token))
      .expect(200);

    expect(await exists(mine.key)).toBe(false);
    expect(await exists(theirs.key)).toBe(true);
    const gone = await request(app).get(mine.url).set(auth(freelancer.token));
    expect(gone.status).toBe(410);
    expect(gone.body.message).toContain('titular');
    await request(app).get(theirs.url).set(auth(freelancer.token)).expect(200);

    const history = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .expect(200);
    const purged = history.body.messages.find((m: { id: number }) => m.id === mine.id);
    expect(purged.attachment.purgedReason).toBe('lgpd');
  });

  it('painel: uso do volume, órfão velho removido no expurgo manual, órfão recente preservado; não-admin 403', async () => {
    const admin = await registerAndLogin('client', true);
    const someone = await registerAndLogin('client');
    await request(app).get('/api/admin/storage').set(auth(someone.token)).expect(403);

    const dir = path.join(uploadsDir(), '2020', '01');
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    const oldOrphan = path.join(dir, 'ORFAO-VELHO.png');
    const freshOrphan = path.join(dir, 'ORFAO-NOVO.png');
    await writeFile(oldOrphan, PNG);
    await writeFile(freshOrphan, PNG);
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
    await utimes(oldOrphan, twoDaysAgo, twoDaysAgo);

    const before = await request(app).get('/api/admin/storage').set(auth(admin.token)).expect(200);
    expect(before.body.attachments.orphans).toBeGreaterThanOrEqual(2);
    expect(before.body.retentionDays).toBe(180);

    const run = await request(app)
      .post('/api/admin/storage/purge')
      .set(auth(admin.token))
      .expect(200);
    expect(run.body.skipped).toBeNull();
    expect(run.body.orphansRemoved).toBeGreaterThanOrEqual(1);
    expect(await stat(oldOrphan).catch(() => null)).toBeNull();
    expect(await stat(freshOrphan)).toBeTruthy();

    const after = await request(app).get('/api/admin/storage').set(auth(admin.token)).expect(200);
    expect(after.body).toMatchObject({
      retentionDays: 180,
      purgeHour: 4,
      lastPurge: expect.objectContaining({ trigger: 'admin' }),
    });
    expect(after.body.attachments.orphans).toBe(before.body.attachments.orphans - 1);
    expect(after.body.uploads.files).toBeGreaterThanOrEqual(1);
    expect(after.body.attachments.purged).toBeGreaterThanOrEqual(2);
  });
});
