import type { BrazilTimezone } from '@escambo/types';
import { addDaysToDay, dayIn, endOfDayIn } from './timezone';

/**
 * Dias úteis do prazo de saque (RN-035): segunda a sexta no calendário de Brasília, que é o da
 * plataforma (quem paga é o admin, no expediente daqui), qualquer que seja o fuso de quem pede.
 * Feriados (nacionais, estaduais, municipais e bancários) ficam de fora de propósito: não há
 * calendário de feriados na plataforma, então um prazo pode cair num feriado e o admin paga antes
 * ou no dia útil seguinte. Puro, sem banco: a migration 0036 refaz a mesma conta em SQL.
 */
export const BUSINESS_DAYS_ZONE: BrazilTimezone = 'America/Sao_Paulo';

/** Sábado (6) ou domingo (0) num "AAAA-MM-DD" (calendário puro, sem fuso). */
function isWeekend(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * O n-ésimo dia útil DEPOIS de `day` (o próprio dia não conta, seja útil ou não): de uma sexta,
 * 1 dia útil é a segunda; de um sábado ou domingo, também. Zero devolve o próprio dia.
 */
export function addBusinessDays(day: string, n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`dias úteis inválidos: ${n}`);
  let current = day;
  for (let counted = 0; counted < n;) {
    current = addDaysToDay(current, 1);
    if (!isWeekend(current)) counted++;
  }
  return current;
}

/**
 * Prazo do saque pedido em `at`: o fim (23:59:59 de Brasília) do n-ésimo dia útil depois do dia do
 * pedido em Brasília. Sexta às 22h de Brasília ainda é sexta (já é sábado em UTC): por PIX, cai na
 * segunda. Fica gravado no saque: mudar o parâmetro depois não mexe no que já foi pedido.
 */
export function businessDueAt(at: Date, n: number): Date {
  return endOfDayIn(BUSINESS_DAYS_ZONE, addBusinessDays(dayIn(BUSINESS_DAYS_ZONE, at), n));
}
