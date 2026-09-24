import type { ModerationSlaReportState } from '@escambo/types';
import { dayKey } from './moderation.day';

/**
 * A marca do relatório diário da meta da moderação (ADR 55): uma linha JSON em
 * `platform_settings`, fora dos parâmetros editáveis (como a do expurgo de anexos). Módulo folha
 * de propósito — o painel e o job leem daqui sem puxar um ao outro. Só contas puras.
 */

export const REPORT_STATE_KEY = 'moderation_sla_report_state';

/** Entre uma tentativa e outra no mesmo dia (SMTP fora do ar às 8h não perde o dia). */
export const RETRY_AFTER_MS = 60 * 60_000;
/** Tentativas de envio por dia com a meta estourada. */
export const MAX_ATTEMPTS = 3;

/** JSON guardado → estado; qualquer coisa que não seja o esperado vale como "nunca conferiu". */
export function parseState(raw: string | null): ModerationSlaReportState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ModerationSlaReportState>;
    if (typeof v.day !== 'string' || typeof v.at !== 'string') return null;
    return {
      day: v.day,
      at: v.at,
      breached: v.breached === true,
      slaHours: Number(v.slaHours ?? 0),
      recipients: Number(v.recipients ?? 0),
      delivered: Number(v.delivered ?? 0),
      attempts: Number(v.attempts ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Está na hora de conferir? Dia novo de Brasília: sim. Mesmo dia: só para tentar de novo — sem
 * admin encontrado (um pode ter entrado), ou com a meta estourada e nenhuma entrega aceita, até
 * três vezes — e sempre com uma hora de descanso. Dia conferido sem estouro não reabre.
 */
export function isDue(state: ModerationSlaReportState | null, now: Date): boolean {
  if (!state || state.day !== dayKey(now)) return true;
  const rested = now.getTime() - new Date(state.at).getTime() >= RETRY_AFTER_MS;
  if (state.recipients === 0) return rested;
  if (state.breached && state.delivered === 0 && state.attempts < MAX_ATTEMPTS) return rested;
  return false;
}

/** O estado gravado ANTES do envio: a trava do dia; `delivered` é atualizado depois. */
export function nextState(
  prev: ModerationSlaReportState | null,
  now: Date,
  breached: boolean,
  slaHours: number,
  recipients: number,
): ModerationSlaReportState {
  const today = dayKey(now);
  const sameDay = prev?.day === today;
  return {
    day: today,
    at: now.toISOString(),
    breached,
    slaHours,
    recipients,
    delivered: sameDay ? (prev?.delivered ?? 0) : 0,
    attempts: (sameDay ? (prev?.attempts ?? 0) : 0) + (breached && recipients > 0 ? 1 : 0),
  };
}
