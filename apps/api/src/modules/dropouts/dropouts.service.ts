import type {
  AdminDropout,
  ContractDropout,
  DropoutSummary,
  MyDropout,
  MyDropouts,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { clock } from '../../utils/clock';
import { HttpError } from '../../utils/http-error';
import { formatDate, timezoneOf } from '../../utils/timezone';
import { notificationsService, type NotifyInput } from '../notifications/notifications.service';
import { agreeUntil, canAppeal, counts, DROPOUT_WINDOW_DAYS, dropoutSummary } from './dropouts';
import {
  dropoutsRepository,
  type DropoutMutation,
  type FullDropoutRow,
} from './dropouts.repository';

const DAY = 24 * 60 * 60_000;
const iso = (at: Date | null): string | null => at?.toISOString() ?? null;

/** DTO privado do titular. O contrato e o perfil público usam projeções menores. */
export function toMyDropout(row: FullDropoutRow, now: Date): MyDropout {
  const counting = counts(row, now);
  return {
    id: row.id,
    contractId: row.contract_id,
    contractTitle: row.contract_title,
    droppedAt: row.dropped_at.toISOString(),
    countsUntil: counting
      ? new Date(row.dropped_at.getTime() + DROPOUT_WINDOW_DAYS * DAY).toISOString()
      : null,
    status:
      row.client_agreed_at !== null
        ? 'agreed'
        : row.decision === 'excused'
          ? 'excused'
          : counting
            ? 'counting'
            : 'expired',
    appealText: row.appeal_text,
    appealedAt: iso(row.appealed_at),
    canAppeal: canAppeal(row, now),
    decision: row.decision,
    decisionNote: row.decision_note,
  };
}

function success(
  outcome: DropoutMutation,
  closedCode: string,
  closedMessage: string,
): { row: FullDropoutRow; now: Date } {
  if ('row' in outcome) return outcome;
  if (outcome.refused === 'not_found')
    throw new HttpError(404, 'Desistência não encontrada', 'dropout_not_found');
  if (outcome.refused === 'appeal_required') {
    throw new HttpError(
      422,
      'Só é possível manter uma desistência que foi contestada',
      'dropout_appeal_required',
    );
  }
  throw new HttpError(409, closedMessage, closedCode);
}

async function notify(row: FullDropoutRow, params: NotifyInput): Promise<void> {
  // A decisão já foi confirmada. Falha de aviso não transforma o resultado em uma tentativa 409.
  try {
    const saved = await dropoutsRepository.saveDecisionNotification(row.freelancer_id, params);
    if (saved) notificationsService.dispatch(saved);
  } catch (err) {
    logger.warn({ err, dropoutId: row.id }, 'desistência decidida: aviso não enviado');
  }
}

async function adminRows(rows: FullDropoutRow[], now: Date): Promise<AdminDropout[]> {
  const ownerCounts = new Map<number, number>();
  for (const uid of new Set(rows.map((r) => r.freelancer_id))) {
    ownerCounts.set(
      uid,
      dropoutSummary(await dropoutsRepository.listCounting(uid, now), now).count,
    );
  }
  return rows.map((row) => ({
    ...toMyDropout(row, now),
    freelancer: { id: row.freelancer_id, ulid: row.freelancer_ulid, name: row.freelancer_name },
    clientAgreed: row.client_agreed_at !== null,
    ownerCount: ownerCounts.get(row.freelancer_id) ?? 0,
  }));
}

export const dropoutsService = {
  async publicSummary(uid: number, now = clock.now()): Promise<DropoutSummary> {
    const { count, alert } = dropoutSummary(await dropoutsRepository.listCounting(uid, now), now);
    return { count, windowDays: 60, alert };
  },

  async myDropouts(uid: number): Promise<MyDropouts> {
    const now = clock.now();
    const [rows, acceptedInWindow] = await Promise.all([
      dropoutsRepository.listMine(uid),
      dropoutsRepository.acceptedInWindow(uid, now),
    ]);
    const { count, alert, alertUntil } = dropoutSummary(rows, now);
    return {
      items: rows.map((r) => toMyDropout(r, now)),
      count,
      alert,
      alertUntil: iso(alertUntil),
      acceptedInWindow,
    };
  },

  async agree(contractId: number, clientId: number): Promise<ContractDropout> {
    const { row, now } = success(
      await dropoutsRepository.agree(contractId, clientId, 'user'),
      'dropout_agree_closed',
      'A confirmação vale até 7 dias depois da desistência e só uma vez',
    );
    await notify(row, {
      type: 'dropout_decided',
      title: `Desistência combinada: ${row.contract_title}`,
      body: 'O cliente confirmou que a desistência foi combinada com ele: ela não conta mais no seu perfil.',
      data: { dropoutId: row.id, decision: 'agreed' },
    });
    // A Sala não recebe a contestação ou nota privada, mesmo depois da confirmação.
    return {
      at: row.dropped_at.toISOString(),
      agreedAt: iso(row.client_agreed_at),
      agreeUntil: agreeUntil(row.dropped_at).toISOString(),
      counts: counts(row, now),
    };
  },

  async appeal(uid: number, dropoutId: number, text: string): Promise<MyDropout> {
    const { row, now } = success(
      await dropoutsRepository.appeal(uid, dropoutId, text),
      'appeal_closed',
      'Só é possível contestar uma vez, enquanto esta desistência conta no seu perfil',
    );
    return toMyDropout(row, now);
  },

  async listAppealed(): Promise<AdminDropout[]> {
    return adminRows(await dropoutsRepository.listAppealed(), clock.now());
  },

  async listForUser(ulid: string): Promise<AdminDropout[]> {
    const uid = await dropoutsRepository.userIdByUlid(ulid);
    if (uid === undefined) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    return adminRows(await dropoutsRepository.listMine(uid), clock.now());
  },

  async decide(
    adminId: number,
    id: number,
    decision: 'excuse' | 'uphold',
    note: string,
    ip: string | null,
  ): Promise<MyDropout> {
    const { row, now } = success(
      await dropoutsRepository.decide(adminId, id, decision, note, ip),
      'dropout_decided_already',
      'Esta desistência já foi decidida ou confirmada pelo cliente',
    );
    const until = new Date(row.dropped_at.getTime() + DROPOUT_WINDOW_DAYS * DAY);
    const upheldBody = counts(row, now)
      ? `${row.contract_title}: a desistência continua contando no seu perfil até ${formatDate(until, timezoneOf(row.freelancer_timezone))}. ${note}`
      : `${row.contract_title}: a equipe manteve o registro. O prazo de 60 dias em que ele conta no perfil já terminou. ${note}`;
    await notify(row, {
      type: 'dropout_decided',
      title:
        decision === 'excuse'
          ? `A desistência não conta mais: ${row.contract_title}`
          : 'Contestação analisada: a desistência foi mantida',
      body:
        decision === 'excuse'
          ? `A equipe do Escambo decidiu que esta desistência não conta: ${note}`
          : upheldBody,
      data: { dropoutId: id, decision: row.decision },
    });
    return toMyDropout(row, now);
  },

  async afterDropout(freelancerId: number, _contractId: number, _now: Date): Promise<void> {
    // A hora é relida sob trava: o job e o caminho imediato aplicam a mesma janela atual.
    await dropoutsRepository.reconcileReviews(freelancerId);
  },

  async reconcilePending(limit = 100): Promise<{ processed: number; reviewsOpened: number }> {
    let remaining = Math.max(1, Math.min(500, Math.trunc(limit) || 1));
    const pending = await dropoutsRepository.findReviewPending(remaining);
    let processed = 0;
    let reviewsOpened = 0;
    const failures: unknown[] = [];
    for (const uid of new Set(pending.map((r) => r.freelancer_id))) {
      if (!remaining) break;
      try {
        const result = await dropoutsRepository.reconcileReviews(uid, remaining);
        processed += result.checked;
        remaining -= result.checked;
        if (result.reviewOpened) reviewsOpened++;
      } catch (err) {
        failures.push(err);
        logger.warn({ err, freelancerId: uid }, 'revisão de desistências continua pendente');
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Falha ao reconciliar revisões de desistências');
    return { processed, reviewsOpened };
  },
};
