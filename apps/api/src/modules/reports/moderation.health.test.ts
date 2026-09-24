import { describe, expect, it } from 'vitest';
import {
  asHours,
  buildHistory,
  dayKey,
  listDays,
  median,
  quantile,
  ratio,
  tallyAutomatic,
} from './moderation.health';

describe('saúde da moderação (ADR 47)', () => {
  it('mediana e percentil com interpolação; vazio é null', () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([1, 3])).toBe(2);
    expect(median([5, 1, 3])).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9.1);
    expect(quantile([10, 20], 0)).toBe(10);
  });

  it('fração com três casas, null sem base; segundos em horas com uma casa', () => {
    expect(ratio(1, 3)).toBe(0.333);
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(2, 2)).toBe(1);
    expect(asHours(5400)).toBe(1.5);
    expect(asHours(100)).toBe(0);
  });

  it('sinalizações por resultado e por sinal: removida acerta, dispensada erra, pendente espera', () => {
    // Linhas do GROUP BY status × sinais, cada uma com a contagem (o driver pode devolver string).
    const tally = tallyAutomatic([
      { status: 'actioned', off_platform: 'pix,phone', n: 2 },
      { status: 'dismissed', off_platform: 'phone', n: '1' as unknown as number },
      { status: 'pending', off_platform: 'whatsapp', n: 1 },
      { status: 'reviewing', off_platform: null, n: 1 },
      { status: 'actioned', off_platform: 'pix,bogus', n: 1 },
    ]);
    expect(tally).toMatchObject({
      flagged: 6,
      pending: 2,
      dismissed: 1,
      actioned: 3,
      precision: 0.75,
    });
    // Empate em sinalizadas ordena pelo nome do sinal; "bogus" não é sinal e cai fora.
    expect(tally.signals).toEqual([
      { signal: 'phone', flagged: 3, actioned: 2, dismissed: 1, precision: 0.667 },
      { signal: 'pix', flagged: 3, actioned: 3, dismissed: 0, precision: 1 },
      { signal: 'whatsapp', flagged: 1, actioned: 0, dismissed: 0, precision: null },
    ]);
    expect(tallyAutomatic([])).toEqual({
      flagged: 0,
      pending: 0,
      dismissed: 0,
      actioned: 0,
      precision: null,
      signals: [],
    });
  });
});

describe('série por dia (ADR 50)', () => {
  it('dayKey e listDays contam no dia de Brasília, virando dia, mês e ano', () => {
    expect(dayKey(new Date('2026-01-01T02:59:00Z'))).toBe('2025-12-31');
    expect(dayKey(new Date('2026-01-01T03:00:00Z'))).toBe('2026-01-01');
    expect(listDays(new Date('2026-09-19T12:00:00Z'), new Date('2026-09-21T12:00:00Z'))).toEqual([
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
    ]);
    // 01:00 UTC ainda é o dia anterior em Brasília: a janela pega o pedaço do primeiro dia.
    expect(listDays(new Date('2026-09-21T01:00:00Z'), new Date('2026-09-21T23:00:00Z'))).toEqual([
      '2026-09-20',
      '2026-09-21',
    ]);
  });

  it('buildHistory preenche dia vazio com zero, soma o que entrou no dia e faz a mediana do dia', () => {
    const history = buildHistory(['2026-09-19', '2026-09-20', '2026-09-21'], {
      decisions: [
        { d: '2026-09-19', status: 'actioned', n: 2 },
        { d: '2026-09-19', status: 'dismissed', n: '1' as unknown as number },
        { d: '2026-09-21', status: 'actioned', n: 1 },
        { d: '2026-09-01', status: 'actioned', n: 9 }, // fora dos dias listados: ignorado
      ],
      byDay: [
        { d: '2026-09-19', n: 4, flagged: 0 },
        { d: '2026-09-21', n: 5, flagged: 3 },
        { d: '2026-09-21', n: '2' as unknown as number, flagged: '1' as unknown as number },
      ],
      seconds: [
        { d: '2026-09-19', secs: 3600 },
        { d: '2026-09-19', secs: 7200 },
        { d: '2026-09-21', secs: 1800 },
      ],
    });
    expect(history).toEqual([
      { day: '2026-09-19', received: 4, actioned: 2, dismissed: 1, flagged: 0, medianHours: 1.5 },
      { day: '2026-09-20', received: 0, actioned: 0, dismissed: 0, flagged: 0, medianHours: null },
      { day: '2026-09-21', received: 7, actioned: 1, dismissed: 0, flagged: 4, medianHours: 0.5 },
    ]);
  });
});
