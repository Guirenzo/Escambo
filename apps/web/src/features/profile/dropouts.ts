import type { ContractDropout, MyDropout } from '@escambo/types';

/** O cliente pode confirmar até o instante dos sete dias, inclusive. */
export function canAgreeDropout(d: ContractDropout, now: number): boolean {
  return (
    d.counts &&
    !d.agreedAt &&
    Number.isFinite(Date.parse(d.agreeUntil)) &&
    now <= Date.parse(d.agreeUntil)
  );
}

/** Aos 60 dias exatos a desistência já saiu do perfil público. */
export function dropoutCounts(d: Pick<MyDropout, 'status' | 'countsUntil'>, now: number): boolean {
  return d.status === 'counting' && Boolean(d.countsUntil) && Date.parse(d.countsUntil!) > now;
}

export function canAppealDropout(d: MyDropout, now: number): boolean {
  return d.canAppeal && !d.appealedAt && !d.decision && dropoutCounts(d, now);
}

export const validDropoutAppeal = (text: string): boolean =>
  text.trim().length >= 20 && text.trim().length <= 1000;
export const validDropoutDecision = (note: string): boolean =>
  note.trim().length >= 10 && note.trim().length <= 500;
