import type { Contract } from '@escambo/types';

/**
 * A carência da RN-029 como conta pura (ADR 56): o mesmo corte do SQL do job overdue-contracts,
 * para quem emite um aviso de prazo saber, no instante, se a mediação automática está contando e
 * até quando.
 */

/** Status em que o prazo de entrega corre (RN-028/029). Fonte única do SQL do repositório. */
export const DEADLINE_ACTIVE_STATUSES = ['accepted', 'in_progress', 'revision_requested'] as const;

/** Carência da RN-029 quando a chave não está gravada (a mesma do job). */
export const DEFAULT_DEADLINE_GRACE_HOURS = 24;

/**
 * Menos que isso para agir, acordar alguém não muda o desfecho a tempo: o aviso espera o fim do
 * silêncio (ADR 56). Folga sobre o intervalo dos jobs (5 min) para acordar, abrir o app e agir.
 */
export const GRACE_MIN_LEFT_MS = 15 * 60_000;

export type GraceState =
  { phase: 'idle' } | { phase: 'running'; endsAt: Date } | { phase: 'ending'; endsAt: Date };

/**
 * A carência em `now`, espelho de findOverdueBeyondGrace: só corre com o status em que o prazo
 * corre, o prazo vencido, o aviso de atraso já dado e nenhum pedido de extensão pendente (que
 * segura as duas fases). 'ending' = menos de GRACE_MIN_LEFT_MS, ou já acabou: a disputa sai numa
 * das próximas rodadas. Sem aviso de atraso ainda é 'idle': o próprio aviso da rodada seguinte
 * leva a hora-limite — um toque só.
 */
export function graceState(
  c: Pick<Contract, 'status' | 'deadlineAt' | 'overdueNotifiedAt' | 'extension'>,
  graceHours: number,
  now: Date,
): GraceState {
  if (!(DEADLINE_ACTIVE_STATUSES as readonly string[]).includes(c.status)) return { phase: 'idle' };
  if (c.deadlineAt === null || Date.parse(c.deadlineAt) >= now.getTime()) return { phase: 'idle' };
  if (c.overdueNotifiedAt === null) return { phase: 'idle' };
  if (c.extension?.status === 'pending') return { phase: 'idle' };
  const endsAt = new Date(Date.parse(c.overdueNotifiedAt) + graceHours * 3_600_000);
  return endsAt.getTime() - now.getTime() >= GRACE_MIN_LEFT_MS
    ? { phase: 'running', endsAt }
    : { phase: 'ending', endsAt };
}
