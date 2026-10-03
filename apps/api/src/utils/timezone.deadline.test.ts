import type { BrazilTimezone } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import {
  BRAZIL_TIMEZONES,
  addDaysToDay,
  dayIn,
  deadlineZoneNote,
  endOfDayIn,
  formatDeadline,
  formatDeadlineDay,
  inferDeadlineZone,
  sameClock,
} from './timezone';

const NOR: BrazilTimezone = 'America/Noronha';
const BRT: BrazilTimezone = 'America/Sao_Paulo';
const CUI: BrazilTimezone = 'America/Cuiaba';
const MAN: BrazilTimezone = 'America/Manaus';
const RBR: BrazilTimezone = 'America/Rio_Branco';

const iso = (d: Date): string => d.toISOString();

/** O prazo como dia no horário de quem entrega (ADR 58): a mesma tabela vale para o web. */
describe('dia do prazo', () => {
  it('endOfDayIn: 23:59:59 do dia em cada fuso', () => {
    expect(iso(endOfDayIn(NOR, '2026-10-02'))).toBe('2026-10-03T01:59:59.000Z');
    expect(iso(endOfDayIn(BRT, '2026-10-02'))).toBe('2026-10-03T02:59:59.000Z');
    expect(iso(endOfDayIn(CUI, '2026-10-02'))).toBe('2026-10-03T03:59:59.000Z');
    expect(iso(endOfDayIn(MAN, '2026-10-02'))).toBe('2026-10-03T03:59:59.000Z');
    expect(iso(endOfDayIn(RBR, '2026-10-02'))).toBe('2026-10-03T04:59:59.000Z');
    expect(iso(endOfDayIn(BRT, '2026-12-31'))).toBe('2027-01-01T02:59:59.000Z');
  });

  it('endOfDayIn e addDaysToDay recusam o que não é AAAA-MM-DD', () => {
    expect(() => endOfDayIn(BRT, '02/10/2026')).toThrow('dia inválido');
    expect(() => addDaysToDay('2026-10-2', 1)).toThrow('dia inválido');
  });

  it('addDaysToDay é calendário puro: vira o ano, o mês e o ano bissexto', () => {
    expect(addDaysToDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysToDay('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToDay('2026-10-02', 0)).toBe('2026-10-02');
  });

  it('dayIn: o dia do instante no fuso de quem lê', () => {
    expect(dayIn(MAN, new Date('2026-10-03T03:59:59Z'))).toBe('2026-10-02');
    expect(dayIn(NOR, new Date('2026-10-03T02:59:59Z'))).toBe('2026-10-03');
  });

  it('sameClock: Manaus e Cuiabá marcam a mesma hora; Brasília e Manaus não', () => {
    const at = new Date('2026-10-02T12:00:00Z');
    expect(sameClock(MAN, CUI, at)).toBe(true);
    expect(sameClock(BRT, MAN, at)).toBe(false);
  });
});

describe('inferDeadlineZone', () => {
  const fimManaus = endOfDayIn(MAN, '2026-10-02');

  it('o cliente em 2º lugar preserva o dia que ele escolheu', () => {
    expect(inferDeadlineZone(fimManaus, [BRT, MAN])).toBe(MAN);
  });

  it('sem nenhum preferido batendo, a lista de reserva acha o relógio', () => {
    expect(inferDeadlineZone(fimManaus, [BRT, BRT])).toBe(MAN);
    expect(inferDeadlineZone(endOfDayIn(NOR, '2026-10-02'), [RBR])).toBe(NOR);
  });

  it('entre Cuiabá e Manaus (mesmo relógio) vale a ordem da preferência', () => {
    expect(inferDeadlineZone(fimManaus, [CUI, BRT])).toBe(CUI);
    expect(inferDeadlineZone(fimManaus, [MAN, CUI])).toBe(MAN);
    expect(inferDeadlineZone(endOfDayIn(CUI, '2026-10-02'), [BRT, CUI])).toBe(CUI);
  });

  it('instante que não é 23:59:59 em fuso nenhum fica no primeiro preferido', () => {
    expect(inferDeadlineZone(new Date('2026-10-02T23:59:59Z'), [BRT, MAN])).toBe(BRT);
    expect(inferDeadlineZone(new Date('2026-10-02T23:59:59Z'), [])).toBe(BRT);
  });
});

describe('formatDeadline e a nota do fuso', () => {
  const fimManaus = new Date('2026-10-03T03:59:59Z');

  it('quem está no mesmo relógio não vê nota; quem está em outro vê o horário de quem entrega', () => {
    expect(formatDeadline(fimManaus, MAN, MAN)).toBe('sex, 02/10/2026, até 23:59');
    expect(formatDeadline(fimManaus, MAN, BRT)).toBe(
      'sex, 02/10/2026, até 23:59 (horário de Manaus)',
    );
    expect(formatDeadline(fimManaus, MAN, CUI)).toBe('sex, 02/10/2026, até 23:59');
  });

  it('sem leitor (histórico, mediação), a nota vai sempre', () => {
    expect(formatDeadline(fimManaus, MAN)).toBe('sex, 02/10/2026, até 23:59 (horário de Manaus)');
    expect(deadlineZoneNote(fimManaus, BRT)).toBe(' (horário de Brasília)');
  });

  it('prazo legado que não é fim de dia mostra a hora real', () => {
    expect(formatDeadline(new Date('2026-10-02T23:59:59Z'), BRT, BRT)).toBe(
      'sex, 02/10/2026, até 20:59',
    );
  });

  it('virada de ano e outro relógio', () => {
    expect(formatDeadline(endOfDayIn(RBR, '2026-12-31'), RBR, NOR)).toBe(
      'qui, 31/12/2026, até 23:59 (horário de Rio Branco)',
    );
  });

  it('formatDeadlineDay: só o dia, para títulos', () => {
    expect(formatDeadlineDay(fimManaus, MAN)).toBe('sex, 02/10');
  });

  it('125 combinações: o mesmo dia para todos, e a nota some só no mesmo relógio', () => {
    for (const deadlineZone of BRAZIL_TIMEZONES) {
      for (const freelancer of BRAZIL_TIMEZONES) {
        const at = endOfDayIn(deadlineZone, '2026-10-02');
        const zone = inferDeadlineZone(at, [freelancer, BRT]);
        for (const reader of BRAZIL_TIMEZONES) {
          const text = formatDeadline(at, zone, reader);
          expect(text.startsWith('sex, 02/10/2026, até 23:59')).toBe(true);
          expect(text.includes('(horário de')).toBe(!sameClock(zone, reader, at));
        }
      }
    }
  });
});
