import type { Contract, ContractDeadline } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import { deadlinePill, momentText, untilLabel } from './deadline';

/** O relógio do prazo na tela (ADR 57): as horas-limite no fuso de quem lê. */
describe('momentText', () => {
  it('dia da semana, data e hora no fuso de quem lê', () => {
    // 12:00Z = 09:00 em Brasília, 08:00 em Manaus
    expect(momentText('2026-10-03T12:00:00.000Z', 'America/Sao_Paulo')).toBe(
      'sáb, 03/10, às 09:00',
    );
    expect(momentText('2026-10-03T12:00:00.000Z', 'America/Manaus')).toBe('sáb, 03/10, às 08:00');
    // Rio Branco (UTC−5): 02:30Z do dia 4 ainda é sábado, 21:30, lá.
    expect(momentText('2026-10-04T02:30:00.000Z', 'America/Rio_Branco')).toBe(
      'sáb, 03/10, às 21:30',
    );
    // sem fuso escolhido vale Brasília
    expect(momentText('2026-10-04T12:05:00.000Z', null)).toBe('dom, 04/10, às 09:05');
  });
});

describe('untilLabel', () => {
  it('minutos, horas, dias e horas', () => {
    expect(untilLabel(40 * 60_000)).toBe('40 min');
    expect(untilLabel(30_000)).toBe('1 min');
    expect(untilLabel(5 * 3_600_000 + 59 * 60_000)).toBe('5 h');
    expect(untilLabel(24 * 3_600_000)).toBe('1 dia');
    expect(untilLabel(4 * 86_400_000 + 3 * 3_600_000)).toBe('4 dias e 3 h');
    expect(untilLabel(-1)).toBe('0 min');
  });
});

describe('deadlinePill', () => {
  const d = (state: ContractDeadline['state']): Pick<Contract, 'deadlineAt' | 'deadline'> => ({
    deadlineAt: '2026-10-08T15:00:00.000Z',
    deadline: {
      state,
      noticeAt: null,
      mediationAt: null,
      extensionRequestsLeft: 2,
      undeliveredMilestones: 0,
      totalMilestones: 0,
      firstDeliveredAt: null,
    },
  });
  const now = new Date('2026-10-01T15:00:00Z');

  it('correndo mostra quanto falta; vencido, pedido e entregue têm rótulo próprio', () => {
    expect(deadlinePill(d('running'), now)).toEqual({ tone: 'ok', label: 'faltam 7 dias' });
    expect(deadlinePill(d('due'), now)).toEqual({ tone: 'late', label: 'venceu' });
    expect(deadlinePill(d('grace'), now)).toEqual({ tone: 'late', label: 'vencido' });
    expect(deadlinePill(d('paused'), now)).toEqual({ tone: 'paused', label: 'extensão pedida' });
    expect(deadlinePill(d('met'), now)).toEqual({ tone: 'met', label: 'entregue' });
  });

  it('sem prazo, proposta ou encerrada: nada', () => {
    for (const s of ['none', 'proposal', 'closed'] as const) {
      expect(deadlinePill(d(s), now)).toBeNull();
    }
  });
});
