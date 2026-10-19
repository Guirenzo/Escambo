import type { WithdrawalMethod } from '@escambo/types';
import { addDaysToDay, dayIn, endOfDayIn } from './deadline';
import { WEEKDAY_SHORT } from './format';

/**
 * Prazo do saque em dias úteis (RN-035): segunda a sexta no calendário de Brasília, sem descontar
 * feriados. Espelho de utils/business-days.ts da API (mesma tabela de vetores nos testes): o
 * formulário prevê o dia antes do pedido; o prazo que vale é o que a API grava e devolve (dueAt).
 */
export const BUSINESS_DAYS_ZONE = 'America/Sao_Paulo';

/** Os padrões da RN-035, enquanto os parâmetros da plataforma não chegam. */
export const DEFAULT_WITHDRAWAL_BUSINESS_DAYS: Record<WithdrawalMethod, number> = {
  pix: 1,
  bank: 2,
};

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/** O n-ésimo dia útil DEPOIS de `day` ("AAAA-MM-DD"): de sexta, sábado ou domingo, 1 é a segunda. */
export function addBusinessDays(day: string, n: number): string {
  let current = day;
  for (let counted = 0; counted < n;) {
    current = addDaysToDay(current, 1);
    const weekday = weekdayOf(current);
    if (weekday !== 0 && weekday !== 6) counted++;
  }
  return current;
}

/** Prazo de um saque pedido agora, em ISO: 23:59:59 de Brasília do n-ésimo dia útil. */
export function withdrawalDueAt(n: number, now: Date = new Date()): string {
  return endOfDayIn(BUSINESS_DAYS_ZONE, addBusinessDays(dayIn(BUSINESS_DAYS_ZONE, now), n));
}

/** "qua, 21/10": o dia do prazo no calendário de Brasília (é o dia que conta, em qualquer fuso). */
export function dueDayText(iso: string): string {
  const day = dayIn(BUSINESS_DAYS_ZONE, iso);
  const [, month, date] = day.split('-');
  return `${WEEKDAY_SHORT[weekdayOf(day)]}, ${date}/${month}`;
}

/** "1 dia útil", "2 dias úteis". */
export const businessDaysLabel = (n: number): string =>
  n === 1 ? '1 dia útil' : `${n} dias úteis`;
