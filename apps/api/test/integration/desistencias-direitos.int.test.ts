import type { AdminDropout, MyDropouts } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { dropoutsRepository } from '../../src/modules/dropouts/dropouts.repository';
import { dropoutsService } from '../../src/modules/dropouts/dropouts.service';
import { mailRepository } from '../../src/modules/mail/mail.repository';
import { mailService } from '../../src/modules/mail/mail.service';
import { setClockForTests } from '../../src/utils/clock';

const app = createApp();
const NOW = new Date('2026-10-09T15:00:00Z');
const DAY = 86_400_000;
const ownedUsers: number[] = [];
const ownedContracts: number[] = [];
interface Actor {
  id: number;
  key: string;
  token: string;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
const freeze = (at: Date) => setClockForTests(at, { frozen: true });
async function actor(role: 'client' | 'freelancer' | 'admin'): Promise<Actor> {
  const key = ulid();
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone)
     VALUES (:key, :email, :role, 'active', 'America/Rio_Branco')`,
    { key, email: `dropout-rights-${key}@escambo.test`, role },
  );
  ownedUsers.push(res.insertId);
  return {
    id: res.insertId,
    key,
    token: jwt.sign({ sub: key, uid: res.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}
async function fixture(droppedAt = NOW) {
  const client = await actor('client'),
    freelancer = await actor('freelancer');
  const [contract] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts (ulid, client_id, freelancer_id, title, description, price,
      platform_fee, freelancer_net, status, accepted_at, cancelled_at, created_at)
     VALUES (:key, :client, :freelancer, 'Desistência privada RN-026', 'Registro independente para testar direitos',
       100, 15, 85, 'cancelled', :droppedAt, :droppedAt, :droppedAt)`,
    { key: ulid(), client: client.id, freelancer: freelancer.id, droppedAt },
  );
  ownedContracts.push(contract.insertId);
  const [dropout] = await pool.query<ResultSetHeader>(
    `INSERT INTO freelancer_dropouts (contract_id, freelancer_id, dropped_at)
     VALUES (:cid, :uid, :droppedAt)`,
    { cid: contract.insertId, uid: freelancer.id, droppedAt },
  );
  return { client, freelancer, cid: contract.insertId, id: dropout.insertId };
}
async function raw(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM freelancer_dropouts WHERE id = :id',
    { id },
  );
  return rows[0]!;
}
async function mine(a: Actor): Promise<MyDropouts> {
  const res = await request(app).get('/api/profiles/me/dropouts').set(auth(a));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as MyDropouts;
}
const agree = (cid: number, a: Actor) =>
  request(app).post(`/api/contracts/${cid}/dropout/agreed`).set(auth(a));
const appeal = (
  id: number,
  a: Actor,
  text = 'Esta desistência foi combinada no chat da contratação',
) => request(app).post(`/api/profiles/me/dropouts/${id}/appeal`).set(auth(a)).send({ text });
const decide = (
  id: number,
  admin: Actor,
  decision: 'excuse' | 'uphold',
  note = 'Nota privada para fundamentar a decisão',
) => request(app).post(`/api/admin/dropouts/${id}/${decision}`).set(auth(admin)).send({ note });

/** Espera constatada pelo InnoDB, sem presumir que um setTimeout fez o pedido chegar à trava. */
async function whileUserLocked<T>(
  uid: number,
  work: () => PromiseLike<T>,
  beforeRelease: (conn: Awaited<ReturnType<typeof pool.getConnection>>) => Promise<void>,
) {
  const blocker = await pool.getConnection();
  let pending: Promise<T> | undefined;
  let committed = false;
  try {
    await blocker.beginTransaction();
    await blocker.query('SELECT id FROM users WHERE id = :uid FOR UPDATE', { uid });
    pending = Promise.resolve(work());
    let waiting = 0;
    const until = Date.now() + 5000;
    while (waiting < 1 && Date.now() < until) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
         WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'users'`,
      );
      waiting = Number(rows[0]!.n);
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting, 'o pedido esperou a trava real do usuário').toBeGreaterThanOrEqual(1);
    await beforeRelease(blocker);
    await blocker.commit();
    committed = true;
  } finally {
    if (!committed) await blocker.rollback();
    blocker.release();
    if (pending) await pending;
  }
  return pending!;
}

beforeEach(() => freeze(NOW));
afterEach(async () => {
  if (ownedUsers.length) {
    await pool.query('DELETE FROM admin_actions WHERE admin_id IN (:ids)', { ids: ownedUsers });
    await pool.query('DELETE FROM notifications WHERE user_id IN (:ids)', { ids: ownedUsers });
    await pool.query('DELETE FROM email_outbox WHERE user_id IN (:ids)', { ids: ownedUsers });
    await pool.query('DELETE FROM data_deletion_requests WHERE user_id IN (:ids)', {
      ids: ownedUsers,
    });
    await pool.query(
      "DELETE FROM content_reports WHERE target_type = 'user' AND target_id IN (:ids)",
      { ids: ownedUsers },
    );
  }
  if (ownedContracts.length)
    await pool.query('DELETE FROM contracts WHERE id IN (:ids)', { ids: ownedContracts });
  if (ownedUsers.length)
    await pool.query('DELETE FROM users WHERE id IN (:ids)', { ids: ownedUsers });
  ownedUsers.length = ownedContracts.length = 0;
});
afterAll(async () => {
  setClockForTests(null);
  await pool.end();
});

describe('RN-026: direitos, confirmação e privacidade no MySQL', () => {
  it('e-mail em voo espera users FOR UPDATE e não recria destinatário ou nota após anonimização', async () => {
    const f = await fixture();
    const to = `dropout-rights-${f.freelancer.key}@escambo.test`;
    await mailRepository.create({
      userId: f.freelancer.id,
      to,
      subject: 'Contestação anterior',
      template: 'notification',
      text: 'Nota privada anterior',
      html: '<p>Nota privada anterior</p>',
      provider: 'simulated',
    });
    const originalProvider = env.MAIL_PROVIDER;
    env.MAIL_PROVIDER = 'simulated';
    try {
      const result = await whileUserLocked(
        f.freelancer.id,
        () =>
          mailService.send({
            userId: f.freelancer.id,
            to,
            template: 'notification',
            vars: { title: 'Contestação analisada', body: 'Nota privada nova em voo' },
            requireActiveUser: true,
          }),
        async (blocker) => {
          await blocker.query('UPDATE users SET deleted_at = :now WHERE id = :uid', {
            now: NOW,
            uid: f.freelancer.id,
          });
          await blocker.query('DELETE FROM email_outbox WHERE user_id = :uid', {
            uid: f.freelancer.id,
          });
        },
      );
      expect(result).toBeNull();
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT id,to_email,text_body,html_body FROM email_outbox WHERE user_id = :uid',
        { uid: f.freelancer.id },
      );
      expect(rows).toHaveLength(0);
    } finally {
      env.MAIL_PROVIDER = originalProvider;
    }
  });
  it('só cliente do contrato confirma, no limite inclusivo de sete dias, sem dinheiro e sem conteúdo privado', async () => {
    const f = await fixture(new Date(NOW.getTime() - 7 * DAY));
    const outsider = await actor('client');
    await appeal(f.id, f.freelancer).expect(200);
    expect((await agree(f.cid, outsider)).status).toBe(404);
    expect((await agree(f.cid, f.freelancer)).status).toBe(404);
    const res = await agree(f.cid, f.client);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['agreeUntil', 'agreedAt', 'at', 'counts']);
    expect(res.body.counts).toBe(false);
    expect(res.body.agreedAt).toBe(NOW.toISOString());
    expect((await raw(f.id)).client_agreed_at).toEqual(NOW);
    expect((await agree(f.cid, f.client)).status).toBe(409);
    const [history] = await pool.query<RowDataPacket[]>(
      'SELECT note FROM contract_status_history WHERE contract_id = :cid',
      { cid: f.cid },
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.note).toContain('combinada');
    const [transactions] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM wallet_transactions WHERE contract_id = :cid',
      { cid: f.cid },
    );
    expect(transactions).toHaveLength(0);
    const [notices] = await pool.query<RowDataPacket[]>(
      'SELECT user_id, type, body FROM notifications WHERE user_id IN (:client,:freelancer)',
      { client: f.client.id, freelancer: f.freelancer.id },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ user_id: f.freelancer.id, type: 'dropout_decided' });
    expect(notices[0]!.body).not.toContain('chat da contratação');
  });

  it('um segundo depois do limite rejeita confirmação', async () => {
    const f = await fixture(new Date(NOW.getTime() - 7 * DAY - 1000));
    const res = await agree(f.cid, f.client);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('dropout_agree_closed');
    expect((await raw(f.id)).client_agreed_at).toBeNull();
  });

  it('reavalia a hora depois da espera no usuário, sem guardar o instante pré-lock', async () => {
    const f = await fixture(new Date(NOW.getTime() - 7 * DAY));
    const res = await whileUserLocked(
      f.freelancer.id,
      () => agree(f.cid, f.client),
      async () => freeze(new Date(NOW.getTime() + 1000)),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('dropout_agree_closed');
    expect((await raw(f.id)).client_agreed_at).toBeNull();
  });

  it('upheld mantém os sete dias de confirmação do cliente e depois deixa de contar', async () => {
    const f = await fixture();
    const admin = await actor('admin');
    await appeal(f.id, f.freelancer).expect(200);
    await decide(f.id, admin, 'uphold').expect(200);
    expect((await mine(f.freelancer)).count).toBe(1);
    await agree(f.cid, f.client).expect(200);
    expect((await mine(f.freelancer)).items[0]).toMatchObject({
      status: 'agreed',
      decision: 'upheld',
      canAppeal: false,
      countsUntil: null,
    });
    expect((await mine(f.freelancer)).count).toBe(0);
  });

  it('contestação é única, só do titular, continua contando e a decisão privada não chega à Sala', async () => {
    const f = await fixture();
    const outsider = await actor('freelancer'),
      admin = await actor('admin');
    expect((await appeal(f.id, outsider)).status).toBe(404);
    const appealRes = await appeal(f.id, f.freelancer);
    expect(appealRes.status).toBe(200);
    expect(appealRes.body).toMatchObject({
      canAppeal: false,
      status: 'counting',
      appealText: expect.stringContaining('chat'),
    });
    expect((await appeal(f.id, f.freelancer)).status).toBe(409);
    expect((await mine(f.freelancer)).count).toBe(1);
    const note = 'Nota sigilosa da equipe para o freelancer';
    await decide(f.id, admin, 'uphold', note).expect(200);
    expect((await mine(f.freelancer)).items[0]!.decisionNote).toBe(note);
    const detail = await request(app).get(`/api/contracts/${f.cid}`).set(auth(f.client));
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(note);
    expect(JSON.stringify(detail.body)).not.toContain('Esta desistência foi combinada');
    expect(detail.body.dropout.counts).toBe(true);
    const [actions] = await pool.query<RowDataPacket[]>(
      "SELECT action,description,ip_address FROM admin_actions WHERE target_type = 'dropout' AND target_id = :id",
      { id: f.id },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: 'dropout_upheld', description: note });
    expect(actions[0]!.ip_address).toBeTruthy();
    const [notices] = await pool.query<RowDataPacket[]>(
      'SELECT user_id,type,body FROM notifications WHERE user_id IN (:client,:freelancer)',
      { client: f.client.id, freelancer: f.freelancer.id },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      user_id: f.freelancer.id,
      type: 'dropout_decided',
      body: expect.stringContaining(note),
    });
  });

  it('excuse sem contestação reduz contagem, fecha acordo e não permite nova decisão', async () => {
    const f = await fixture();
    const admin = await actor('admin');
    expect((await decide(f.id, admin, 'uphold')).status).toBe(422);
    expect((await raw(f.id)).decision).toBeNull();
    await decide(f.id, admin, 'excuse').expect(200);
    expect((await mine(f.freelancer)).count).toBe(0);
    expect((await mine(f.freelancer)).items[0]).toMatchObject({
      status: 'excused',
      countsUntil: null,
    });
    expect((await agree(f.cid, f.client)).status).toBe(409);
    expect((await decide(f.id, admin, 'uphold')).status).toBe(409);
    const [actions] = await pool.query<RowDataPacket[]>(
      "SELECT action FROM admin_actions WHERE target_type = 'dropout' AND target_id = :id",
      { id: f.id },
    );
    expect(actions.map((r) => r.action)).toEqual(['dropout_excused']);
  });

  it('fila da equipe exige admin e exclui contestação depois da confirmação', async () => {
    const f = await fixture();
    const admin = await actor('admin');
    await appeal(f.id, f.freelancer).expect(200);
    expect(
      (await request(app).get('/api/admin/dropouts?status=appealed').set(auth(f.freelancer)))
        .status,
    ).toBe(403);
    const queue = await request(app).get('/api/admin/dropouts?status=appealed').set(auth(admin));
    expect(queue.status).toBe(200);
    const item = (queue.body as AdminDropout[]).find((r) => r.id === f.id);
    expect(item).toMatchObject({
      freelancer: { id: f.freelancer.id, ulid: f.freelancer.key },
      ownerCount: 1,
      clientAgreed: false,
    });
    await agree(f.cid, f.client).expect(200);
    const closed = await request(app).get('/api/admin/dropouts?status=appealed').set(auth(admin));
    expect((closed.body as AdminDropout[]).some((r) => r.id === f.id)).toBe(false);
    const owner = await request(app)
      .get(`/api/admin/users/${f.freelancer.key}/dropouts`)
      .set(auth(admin));
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject([{ clientAgreed: true, ownerCount: 0 }]);
  });

  it('janela inclusiva de 60 dias permite apelar até o instante final e expira no próximo segundo', async () => {
    const f = await fixture(new Date(NOW.getTime() - 60 * DAY));
    expect((await mine(f.freelancer)).count).toBe(1);
    await appeal(f.id, f.freelancer).expect(200);
    freeze(new Date(NOW.getTime() + 1000));
    expect((await mine(f.freelancer)).items[0]).toMatchObject({
      status: 'expired',
      countsUntil: null,
    });
    const g = await fixture(new Date(NOW.getTime() - 60 * DAY));
    const res = await appeal(g.id, g.freelancer);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('appeal_closed');
  });

  it.each(['appeal', 'decide'] as const)(
    '%s em voo não repõe texto depois da anonimização sob users FOR UPDATE',
    async (action) => {
      const f = await fixture();
      const admin = await actor('admin');
      const work = () =>
        action === 'appeal'
          ? Promise.resolve(appeal(f.id, f.freelancer))
          : Promise.resolve(decide(f.id, admin, 'excuse'));
      const res = await whileUserLocked(f.freelancer.id, work, async (blocker) => {
        await blocker.query('UPDATE users SET deleted_at = :now WHERE id = :uid', {
          now: NOW,
          uid: f.freelancer.id,
        });
        await blocker.query(
          'UPDATE freelancer_dropouts SET appeal_text = NULL, decision_note = NULL WHERE id = :id',
          { id: f.id },
        );
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('dropout_not_found');
      expect(await raw(f.id)).toMatchObject({
        appeal_text: null,
        decision_note: null,
        appealed_at: null,
        decision: null,
      });
    },
  );

  it.each(['excuse', 'uphold'] as const)(
    'anonimização remove a nota privada da decisão %s e da auditoria, preservando o fato e outras contas',
    async (decision) => {
      const f = await fixture();
      const other = await fixture();
      const admin = await actor('admin');
      if (decision === 'uphold') await appeal(f.id, f.freelancer).expect(200);
      const privateNote = 'Nota privada identificável do titular a ser anonimizado';
      const otherNote = 'Justificativa de outra conta que ainda está ativa';
      await decide(f.id, admin, decision, privateNote).expect(200);
      await decide(other.id, admin, 'excuse', otherNote).expect(200);
      const audit = async (id: number) =>
        (
          await pool.query<RowDataPacket[]>(
            `SELECT id, admin_id, action, target_type, target_id, description, created_at
              FROM admin_actions WHERE target_type = 'dropout' AND target_id = :id`,
            { id },
          )
        )[0];
      const before = await audit(f.id);
      expect(before).toHaveLength(1);
      expect(before[0]!.description).toBe(privateNote);
      const asked = await request(app)
        .post('/api/lgpd/deletion-requests')
        .set(auth(f.freelancer))
        .send({ reason: 'Fixture própria para conferir a remoção da justificativa privada' })
        .expect(201);
      await request(app)
        .post(`/api/admin/deletion-requests/${asked.body.id}/complete`)
        .set(auth(admin))
        .expect(200);
      const after = await audit(f.id);
      expect(after).toEqual([
        {
          ...before[0],
          description: 'Justificativa removida após anonimização do titular.',
        },
      ]);
      expect(await raw(f.id)).toMatchObject({
        appeal_text: null,
        decision_note: null,
        decision: decision === 'excuse' ? 'excused' : 'upheld',
      });
      expect((await audit(other.id))[0]!.description).toBe(otherNote);
      expect((await raw(other.id)).decision_note).toBe(otherNote);
    },
  );

  it('conta já anonimizada recusa mutation e drena evento sem abrir revisão', async () => {
    const f = await fixture();
    const admin = await actor('admin');
    await pool.query('UPDATE users SET deleted_at = :now WHERE id = :uid', {
      now: NOW,
      uid: f.freelancer.id,
    });
    await expect(
      dropoutsService.appeal(f.freelancer.id, f.id, 'Texto privado para testar anonimização'),
    ).rejects.toMatchObject({ code: 'dropout_not_found' });
    await expect(
      dropoutsService.decide(admin.id, f.id, 'excuse', 'Nota privada da equipe', null),
    ).rejects.toMatchObject({ code: 'dropout_not_found' });
    expect(await dropoutsRepository.reconcileReviews(f.freelancer.id)).toEqual({
      checked: 1,
      reviewOpened: false,
    });
    expect((await raw(f.id)).review_checked_at).toEqual(NOW);
    expect(
      await dropoutsRepository.saveDecisionNotification(f.freelancer.id, {
        type: 'dropout_decided',
        title: 'Aviso em voo',
        body: 'Nota privada da equipe',
      }),
    ).toBeNull();
    const [notices] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM notifications WHERE user_id = :uid',
      { uid: f.freelancer.id },
    );
    expect(notices).toHaveLength(0);
  });
});
