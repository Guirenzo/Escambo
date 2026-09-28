import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../config/db';
import { logger } from '../config/logger';
import {
  DEFAULT_DEADLINE_GRACE_HOURS,
  DEFAULT_PROPOSAL_EXPIRY_HOURS,
  DEFAULT_TACIT_APPROVAL_DAYS,
  extensionRespondBy,
  graceEndFrom,
} from '../modules/contracts/deadline-grace';
import { CLOSE_PENDING_EXTENSION, rn029Eligible } from '../modules/contracts/deadline-sql';
import { settingsRepository } from '../modules/settings/settings.repository';
import { clock } from '../utils/clock';
import { floorSecond, humanize, lastHumanAtOrBefore } from '../utils/human-hours';
import { timezoneOf } from '../utils/timezone';

/**
 * Reparo dos prazos (ADR 57): preenche, em Node e com as MESMAS funções de hora que a API usa ao
 * gravar, as colunas que as contratações de antes da 0027 não têm, e acerta o que a API antiga
 * possa gravar durante o deploy. Roda no fim do `db:migrate` e em toda rodada dos jobs (primeiro
 * da lista). Idempotente: cada UPDATE repete `<coluna> IS NULL`, e normalmente nada é tocado.
 *
 *  1. carência sem aviso (extensão aceita pela API antiga)            → grace_ends_at = NULL
 *  2. contador de pedidos zerado com pedido visível                   → 1 (conservador)
 *  3. pedido pendente fora da vez de quem entrega                      → 'closed'
 *  4. pedido pendente sem hora de resposta                            → 48 h a partir de agora
 *  5. aviso dado sem o fim da carência, com o prazo cobrando          → aviso + carência vigente
 *  6. proposta sem validade                                           → criação + horas vigentes
 *  7. entrega única sem a hora da aprovação tácita                    → última entrega + dias
 *  8. marco entregue sem a hora da aprovação tácita                   → entrega do marco + dias
 * Os instantes calculados passam pela hora humana no fuso ATUAL de quem é afetado. Toda escrita é
 * pela chave primária, repetindo o predicado da leitura: a mesma ordem de trava da API (linha
 * primeiro, índice depois), e um deadlock ou espera de trava só adia aquela linha para a próxima
 * rodada, sem derrubar o reparo nem a ação de quem está usando.
 */

const H = 3_600_000;
const DAY = 24 * H;
const BATCH = 200;

export interface RepairDeadlinesResult {
  graceWithoutNotice: number;
  requestCounters: number;
  closedExtensions: number;
  respondBy: number;
  graceEnds: number;
  proposalExpiry: number;
  approvalDue: number;
  milestoneApprovalDue: number;
}

async function each<T extends RowDataPacket>(
  sql: string,
  params: Record<string, Date | number | string | null>,
  fix: (row: T) => Promise<boolean>,
): Promise<number> {
  const [rows] = await pool.query<T[]>(sql, params);
  let n = 0;
  for (const row of rows) if (await fix(row)) n++;
  return n;
}

async function update(
  sql: string,
  params: Record<string, Date | number | string | null>,
): Promise<boolean> {
  try {
    const [res] = await pool.query<ResultSetHeader>(sql, params);
    return res.affectedRows > 0;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT') {
      logger.warn({ code, params }, 'reparo dos prazos: linha adiada para a próxima rodada');
      return false;
    }
    throw err;
  }
}

export async function runRepairDeadlines(now: Date = clock.now()): Promise<RepairDeadlinesResult> {
  const [graceHours, expiryHours, tacitDays] = await Promise.all([
    settingsRepository.getNumber('deadline_grace_hours', DEFAULT_DEADLINE_GRACE_HOURS),
    settingsRepository.getNumber('proposal_expiry_hours', DEFAULT_PROPOSAL_EXPIRY_HOURS),
    settingsRepository.getNumber('tacit_approval_days', DEFAULT_TACIT_APPROVAL_DAYS),
  ]);

  const GRACE_WITHOUT_NOTICE = 'grace_ends_at IS NOT NULL AND overdue_notified_at IS NULL';
  const graceWithoutNotice = await each<RowDataPacket>(
    `SELECT id FROM contracts WHERE ${GRACE_WITHOUT_NOTICE} LIMIT ${BATCH}`,
    {},
    (row) =>
      update(
        `UPDATE contracts SET grace_ends_at = NULL WHERE id = :id AND ${GRACE_WITHOUT_NOTICE}`,
        {
          id: row.id,
        },
      ),
  );
  const ZERO_COUNTER =
    "extension_requests = 0 AND extension_status IN ('pending', 'accepted', 'declined')";
  const requestCounters = await each<RowDataPacket>(
    `SELECT id FROM contracts WHERE ${ZERO_COUNTER} LIMIT ${BATCH}`,
    {},
    (row) =>
      update(`UPDATE contracts SET extension_requests = 1 WHERE id = :id AND ${ZERO_COUNTER}`, {
        id: row.id,
      }),
  );
  const OUT_OF_REACH = `c.extension_status = 'pending' AND NOT ${rn029Eligible('c')}`;
  const closedExtensions = await each<RowDataPacket>(
    `SELECT c.id FROM contracts c WHERE ${OUT_OF_REACH} LIMIT ${BATCH}`,
    {},
    (row) =>
      update(
        `UPDATE contracts c SET ${CLOSE_PENDING_EXTENSION('c')} WHERE c.id = :id AND ${OUT_OF_REACH}`,
        { id: row.id, now },
      ),
  );

  const respondBy = await each<RowDataPacket>(
    `SELECT c.id, c.extension_deadline_at, cu.timezone AS tz
       FROM contracts c JOIN users cu ON cu.id = c.client_id
      WHERE c.extension_status = 'pending' AND c.extension_respond_by IS NULL
      LIMIT ${BATCH}`,
    {},
    // Perto demais (ou passada) para decidir: expira na primeira rodada diurna do cliente.
    (row) =>
      update(
        `UPDATE contracts SET extension_respond_by = :v,
                extension_requests = GREATEST(extension_requests, 1)
          WHERE id = :id AND extension_respond_by IS NULL`,
        {
          id: row.id,
          v:
            extensionRespondBy({
              requestedAt: now,
              proposed: new Date(row.extension_deadline_at),
              zone: timezoneOf(row.tz),
            }) ?? floorSecond(now),
        },
      ),
  );

  const graceEnds = await each<RowDataPacket>(
    `SELECT c.id, c.overdue_notified_at, fu.timezone AS tz
       FROM contracts c JOIN users fu ON fu.id = c.freelancer_id
      WHERE c.status IN ('accepted', 'in_progress')
        AND c.overdue_notified_at IS NOT NULL AND c.grace_ends_at IS NULL
      LIMIT ${BATCH}`,
    {},
    (row) =>
      update(`UPDATE contracts SET grace_ends_at = :v WHERE id = :id AND grace_ends_at IS NULL`, {
        id: row.id,
        v: graceEndFrom(new Date(row.overdue_notified_at), graceHours, timezoneOf(row.tz)),
      }),
  );

  const proposalExpiry = await each<RowDataPacket>(
    `SELECT c.id, c.created_at, c.deadline_at, fu.timezone AS tz
       FROM contracts c JOIN users fu ON fu.id = c.freelancer_id
      WHERE c.status = 'pending' AND c.barter_agreement_id IS NULL
        AND c.proposal_expires_at IS NULL
      LIMIT ${BATCH}`,
    {},
    (row) => {
      const zone = timezoneOf(row.tz);
      let v = humanize(new Date(new Date(row.created_at).getTime() + expiryHours * H), zone);
      if (row.deadline_at) {
        const last = lastHumanAtOrBefore(new Date(row.deadline_at), zone);
        if (last.getTime() < v.getTime()) v = last;
      }
      return update(
        `UPDATE contracts SET proposal_expires_at = :v WHERE id = :id AND proposal_expires_at IS NULL`,
        { id: row.id, v: floorSecond(v) },
      );
    },
  );

  const approvalDue = await each<RowDataPacket>(
    `SELECT c.id, cu.timezone AS tz,
            (SELECT MAX(h.created_at) FROM contract_status_history h
              WHERE h.contract_id = c.id AND h.new_status = 'delivered') AS delivered_at
       FROM contracts c JOIN users cu ON cu.id = c.client_id
      WHERE c.status = 'delivered' AND c.approval_due_at IS NULL
      LIMIT ${BATCH}`,
    {},
    (row) => {
      const from = row.delivered_at ? new Date(row.delivered_at) : now;
      return update(
        `UPDATE contracts SET approval_due_at = :v WHERE id = :id AND approval_due_at IS NULL`,
        {
          id: row.id,
          v: floorSecond(humanize(new Date(from.getTime() + tacitDays * DAY), timezoneOf(row.tz))),
        },
      );
    },
  );

  const milestoneApprovalDue = await each<RowDataPacket>(
    `SELECT m.id, m.delivered_at, cu.timezone AS tz
       FROM contract_milestones m
       JOIN contracts c ON c.id = m.contract_id
       JOIN users cu ON cu.id = c.client_id
      WHERE m.status = 'delivered' AND m.approval_due_at IS NULL
      LIMIT ${BATCH}`,
    {},
    (row) => {
      const from = row.delivered_at ? new Date(row.delivered_at) : now;
      return update(
        `UPDATE contract_milestones SET approval_due_at = :v
          WHERE id = :id AND approval_due_at IS NULL`,
        {
          id: row.id,
          v: floorSecond(humanize(new Date(from.getTime() + tacitDays * DAY), timezoneOf(row.tz))),
        },
      );
    },
  );

  return {
    graceWithoutNotice,
    requestCounters,
    closedExtensions,
    respondBy,
    graceEnds,
    proposalExpiry,
    approvalDue,
    milestoneApprovalDue,
  };
}
