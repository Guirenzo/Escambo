import type { Contract } from '@escambo/types';
import { deadlineInfo, WEEKDAY_SHORT } from './format';
import { DEFAULT_TIMEZONE } from './timezones';

/**
 * O relógio do prazo na tela (ADR 57): as horas-limite que a API grava (aviso, disputa, resposta
 * a um pedido, aprovação automática, validade da proposta) aparecem no fuso de quem lê, porque é
 * ele quem vai agir. Espelho de formatDue (apps/api/src/utils/timezone.ts), com vírgula antes do
 * "às" para caber numa frase.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** "sáb, 03/10, às 09:00" no fuso de quem lê (Brasília para quem não escolheu). */
export function momentText(iso: string, zone: string | null | undefined): string {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(zone ?? DEFAULT_TIMEZONE).formatToParts(new Date(iso))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  const weekday = new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay();
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${WEEKDAY_SHORT[weekday]}, ${two(p.day!)}/${two(p.month!)}, às ${two(p.hour!)}:${two(p.minute!)}`;
}

/** "4 dias e 3 h", "5 h", "40 min": quanto falta até um instante. */
export function untilLabel(ms: number): string {
  if (ms <= 0) return '0 min';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours - days * 24;
  const d = days === 1 ? '1 dia' : `${days} dias`;
  return rest > 0 ? `${d} e ${rest} h` : d;
}

export interface DeadlinePill {
  tone: 'ok' | 'soon' | 'late' | 'paused' | 'met';
  label: string;
}

/**
 * A pílula do prazo, pelo estado que a API calculou: quanto falta enquanto corre; "venceu" antes
 * do aviso; "vencido" na carência; "extensão pedida" enquanto o cliente decide; "entregue" quando
 * não há mais o que cobrar. Sem prazo, proposta ou encerrada: nada.
 */
export function deadlinePill(
  c: Pick<Contract, 'deadlineAt' | 'deadline'>,
  now: Date = new Date(),
): DeadlinePill | null {
  switch (c.deadline?.state) {
    case 'running': {
      const info = deadlineInfo(c.deadlineAt, now);
      if (!info) return null;
      return info.tone === 'late'
        ? { tone: 'late', label: 'venceu' }
        : { tone: info.tone, label: info.label };
    }
    case 'due':
      return { tone: 'late', label: 'venceu' };
    case 'grace':
      return { tone: 'late', label: 'vencido' };
    case 'paused':
      return { tone: 'paused', label: 'extensão pedida' };
    case 'met':
      return { tone: 'met', label: 'entregue' };
    default:
      return null;
  }
}
