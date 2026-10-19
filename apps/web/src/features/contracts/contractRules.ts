import type { Contract, RevisionState } from '@escambo/types';

/** Ausente no rollout ou limite null: as revisões antigas continuam ilimitadas. */
export const revisionsExhausted = (state: RevisionState | null | undefined): boolean =>
  state != null && state.limit !== null && state.used >= state.limit;

export const revisionCount = (state: RevisionState): string =>
  state.limit === null ? `${state.used} usadas · sem limite` : `${state.used} de ${state.limit}`;

export const disputeWaiting = (c: Pick<Contract, 'disputeOpensAt'>, now = Date.now()): boolean =>
  c.disputeOpensAt != null && Date.parse(c.disputeOpensAt) > now;

export const GRANT_REVISION_CONFIRMATION =
  'Liberar mais uma revisão sem custo? O prazo de aprovação automática continua o mesmo; ela só para quando o cliente pedir a revisão.';
