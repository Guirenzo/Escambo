import type { ResultSetHeader } from 'mysql2/promise';
import { ulid } from 'ulid';
import { afterAll, describe, expect, it } from 'vitest';
import { inTransaction, pool } from '../../src/config/db';
import { notificationsRepository } from '../../src/modules/notifications/notifications.repository';

/** SQL real: resumos opcionais preservam suspensos e não alcançam banidos/excluídos. */
const ZONE = 'America/Manaus';
const DAY_START = new Date('2026-10-13T04:00:00Z');
const HELD_AT = new Date('2026-10-13T03:00:00Z');
type State = 'active' | 'suspended' | 'banned' | 'deleted';
const candidateIds: number[] = [];

async function candidate(state: State = 'active'): Promise<number> {
  const key = ulid();
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, deleted_at, timezone, email_frequency,
       digest_hour, push_quiet_start, push_quiet_end)
     VALUES (:key, :email, 'client', :status, :deletedAt, :zone, 'daily', 8, 22, 7)`,
    {
      key,
      email: `notification-state-${key}@escambo.test`,
      status: state === 'deleted' ? 'active' : state,
      deletedAt: state === 'deleted' ? DAY_START : null,
      zone: ZONE,
    },
  );
  candidateIds.push(result.insertId);
  return result.insertId;
}

async function held(
  uid: number,
  options: { read?: boolean; held?: boolean } = {},
): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO notifications (user_id, type, title, body, channel, is_read, push_held_at)
     VALUES (:uid, 'chat_message', 'Aviso fictício retido', 'Resumo do teste RN-007',
       'in_app', :isRead, :heldAt)`,
    { uid, isRead: options.read ? 1 : 0, heldAt: options.held === false ? null : HELD_AT },
  );
  return result.insertId;
}

async function cohort() {
  const active = await candidate('active');
  const suspended = await candidate('suspended');
  const banned = await candidate('banned');
  const deleted = await candidate('deleted');
  const ids = [active, suspended, banned, deleted];
  for (const id of ids) await held(id);
  return { active, suspended, banned, deleted, ids };
}

const only = (rows: { id: number }[], ids: readonly number[]) =>
  rows.map((row) => row.id).filter((id) => ids.includes(id));

afterAll(async () => {
  try {
    if (candidateIds.length) {
      // Somente fixtures deste arquivo: nenhum candidato elegível sobra para jobs de outras suítes.
      await inTransaction(async (conn) => {
        await conn.query('DELETE FROM notifications WHERE user_id IN (:ids)', {
          ids: candidateIds,
        });
        await conn.query('DELETE FROM users WHERE id IN (:ids)', { ids: candidateIds });
      });
    }
  } finally {
    await pool.end();
  }
});

describe('RN-007 — candidatos dos resumos opcionais por estado atual no MySQL', () => {
  it('resumo diário inclui ativo/suspenso e exclui banido/excluído com os mesmos horários', async () => {
    const actors = await cohort();
    const due = await notificationsRepository.usersForDigest(DAY_START, 9, 8, ZONE);
    expect(only(due, actors.ids)).toEqual([actors.active, actors.suspended]);
  });

  it('resumo do silêncio inclui ativo/suspenso e exclui banido/excluído, todos com retidos não lidos', async () => {
    const actors = await cohort();
    for (const id of actors.ids) expect(await notificationsRepository.countHeld(id)).toBe(1);
    const due = await notificationsRepository.usersForQuietSummary(ZONE, 9);
    expect(only(due, actors.ids)).toEqual([actors.active, actors.suspended]);
  });

  it('relê o estado depois da seleção anterior, incluindo suspensão e reativação sem cache', async () => {
    const uid = await candidate();
    await held(uid);
    const due = async () => ({
      digest: only(await notificationsRepository.usersForDigest(DAY_START, 9, 8, ZONE), [uid]),
      quiet: only(await notificationsRepository.usersForQuietSummary(ZONE, 9), [uid]),
    });
    expect(await due()).toEqual({ digest: [uid], quiet: [uid] });
    await pool.query("UPDATE users SET status = 'banned' WHERE id = :uid", { uid });
    expect(await due()).toEqual({ digest: [], quiet: [] });
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = :uid", { uid });
    expect(await due()).toEqual({ digest: [uid], quiet: [uid] });
    await pool.query('UPDATE users SET deleted_at = :at WHERE id = :uid', { uid, at: DAY_START });
    expect(await due()).toEqual({ digest: [], quiet: [] });
    await pool.query("UPDATE users SET status = 'active', deleted_at = NULL WHERE id = :uid", {
      uid,
    });
    expect(await due()).toEqual({ digest: [uid], quiet: [uid] });
  });

  it('preserva preferências, horário, marca diária e avisos ainda por resumir para suspensos', async () => {
    const valid = await candidate('suspended');
    const later = await candidate('suspended');
    const off = await candidate('suspended');
    const sentToday = await candidate('suspended');
    const wrongZone = await candidate('suspended');
    const read = await candidate('suspended');
    const notHeld = await candidate('suspended');
    const alreadySummarized = await candidate('suspended');
    const ids = [valid, later, off, sentToday, wrongZone, read, notHeld, alreadySummarized];
    for (const uid of [valid, later, off, sentToday, wrongZone]) await held(uid);
    await held(read, { read: true });
    await held(notHeld, { held: false });
    const summaryId = await held(alreadySummarized);
    await pool.query('UPDATE users SET digest_hour = 10 WHERE id = :uid', { uid: later });
    await pool.query("UPDATE users SET email_frequency = 'off' WHERE id = :uid", { uid: off });
    await pool.query('UPDATE users SET last_digest_at = :at WHERE id = :uid', {
      uid: sentToday,
      at: DAY_START,
    });
    await pool.query("UPDATE users SET timezone = 'America/Sao_Paulo' WHERE id = :uid", {
      uid: wrongZone,
    });
    await pool.query('UPDATE users SET push_quiet_summary_id = :summaryId WHERE id = :uid', {
      uid: alreadySummarized,
      summaryId,
    });

    expect(only(await notificationsRepository.usersForDigest(DAY_START, 9, 8, ZONE), ids)).toEqual([
      valid,
      read,
      notHeld,
      alreadySummarized,
    ]);
    // Preferências de e-mail não retiram o aviso do resumo de push; leitura e marca d'água retiram.
    expect(only(await notificationsRepository.usersForQuietSummary(ZONE, 9), ids)).toEqual([
      valid,
      later,
      off,
      sentToday,
    ]);
    expect(only(await notificationsRepository.usersForQuietSummary(ZONE, 23), ids)).toEqual([]);
  });
});
