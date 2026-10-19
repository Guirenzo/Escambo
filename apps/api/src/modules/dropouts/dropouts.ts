/** Regras públicas da RN-026. Alterar os números exige nova versão dos documentos legais. */
export const DROPOUT_WINDOW_DAYS = 60;
export const DROPOUT_ALERT_AT = 3;
export const DROPOUT_AGREE_DAYS = 7;

const DAY = 24 * 60 * 60_000;

/** Só os fatos necessários à regra; a linha completa do repositório pode ter outros campos. */
export interface DropoutRow {
  readonly dropped_at: Date;
  readonly client_agreed_at: Date | null;
  readonly appealed_at: Date | null;
  readonly decision: 'excused' | 'upheld' | null;
}

export const dropoutSince = (now: Date): Date =>
  new Date(now.getTime() - DROPOUT_WINDOW_DAYS * DAY);

/** Janela inclusiva, como dropped_at >= :since; datas futuras nunca contam. */
export function counts(d: DropoutRow, now: Date): boolean {
  const at = d.dropped_at.getTime();
  return (
    at >= dropoutSince(now).getTime() &&
    at <= now.getTime() &&
    d.client_agreed_at === null &&
    (d.decision === null || d.decision === 'upheld')
  );
}

/** Até este instante inclusive há pelo menos três, se nenhuma outra desistência mudar. */
export function dropoutSummary(
  rows: readonly DropoutRow[],
  now: Date,
): { count: number; alert: boolean; alertUntil: Date | null } {
  const dates = rows
    .filter((d) => counts(d, now))
    .map((d) => d.dropped_at.getTime())
    .sort((a, b) => a - b);
  const count = dates.length;
  const alert = count >= DROPOUT_ALERT_AT;
  return {
    count,
    alert,
    // A (n−2)ª mais antiga é a terceira mais recente, mesmo com datas iguais.
    alertUntil: alert
      ? new Date(dates[count - DROPOUT_ALERT_AT]! + DROPOUT_WINDOW_DAYS * DAY)
      : null,
  };
}

/** Retrato informativo: inclui uma desistência virtual agora, sem gravar ou prometer o total futuro. */
export function withdrawalPreview(
  rows: readonly DropoutRow[],
  now: Date,
): { countAfter: number; alertUntil: Date | null } {
  const { count, alertUntil } = dropoutSummary(
    [...rows, { dropped_at: now, client_agreed_at: null, appealed_at: null, decision: null }],
    now,
  );
  return { countAfter: count, alertUntil };
}

export const agreeUntil = (droppedAt: Date): Date =>
  new Date(droppedAt.getTime() + DROPOUT_AGREE_DAYS * DAY);

/** A decisão upheld preserva os sete dias; confirmação registrada ou excused não reabre a ação. */
export const canAgree = (d: DropoutRow, now: Date): boolean =>
  d.client_agreed_at === null &&
  d.decision !== 'excused' &&
  d.dropped_at.getTime() <= now.getTime() &&
  now.getTime() <= agreeUntil(d.dropped_at).getTime();

/** Uma contestação por desistência, enquanto conta e nenhuma decisão foi tomada. */
export const canAppeal = (d: DropoutRow, now: Date): boolean =>
  counts(d, now) && d.appealed_at === null && d.decision === null;
