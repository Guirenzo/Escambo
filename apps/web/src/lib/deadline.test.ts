import type { BrazilTimezone, Contract, ContractDeadline } from '@escambo/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDaysToDay,
  dayIn,
  deadlineInfo,
  deadlinePill,
  deadlineText,
  deadlineZoneNote,
  endOfDayIn,
  momentText,
  sameClock,
  spreadDays,
  todayIn,
  untilLabel,
} from './deadline';

const NOR: BrazilTimezone = 'America/Noronha';
const BRT: BrazilTimezone = 'America/Sao_Paulo';
const CUI: BrazilTimezone = 'America/Cuiaba';
const MAN: BrazilTimezone = 'America/Manaus';
const RBR: BrazilTimezone = 'America/Rio_Branco';
const ZONES = [NOR, BRT, CUI, MAN, RBR] as const;

/** O relógio de cada fuso em 2026 (sem horário de verão): a referência dos testes de "mesmo relógio". */
const UTC_OFFSET: Record<BrazilTimezone, number> = {
  'America/Noronha': -2,
  'America/Sao_Paulo': -3,
  'America/Cuiaba': -4,
  'America/Manaus': -4,
  'America/Rio_Branco': -5,
};

/** Fim de 02/10/2026 em Manaus: sexta, 23:59:59 lá. */
const FIM_MANAUS = '2026-10-03T03:59:59.000Z';

afterEach(() => vi.useRealTimers());

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

/**
 * O prazo como dia no horário de quem entrega (ADR 58). A mesma tabela de vetores de
 * apps/api/src/utils/timezone.deadline.test.ts: a tela e os avisos dizem o mesmo dia.
 */
describe('dia do prazo (mesma tabela da API)', () => {
  it('endOfDayIn: 23:59:59 do dia em cada fuso', () => {
    expect(endOfDayIn(NOR, '2026-10-02')).toBe('2026-10-03T01:59:59.000Z');
    expect(endOfDayIn(BRT, '2026-10-02')).toBe('2026-10-03T02:59:59.000Z');
    expect(endOfDayIn(CUI, '2026-10-02')).toBe('2026-10-03T03:59:59.000Z');
    expect(endOfDayIn(MAN, '2026-10-02')).toBe('2026-10-03T03:59:59.000Z');
    expect(endOfDayIn(RBR, '2026-10-02')).toBe('2026-10-03T04:59:59.000Z');
    expect(endOfDayIn(BRT, '2026-12-31')).toBe('2027-01-01T02:59:59.000Z');
  });

  it('addDaysToDay é calendário puro: vira o ano, o mês e o ano bissexto', () => {
    expect(addDaysToDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysToDay('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToDay('2026-10-02', 0)).toBe('2026-10-02');
    expect(addDaysToDay('2026-10-02', 7)).toBe('2026-10-09');
  });

  it('dayIn: o dia do instante no fuso, de um ISO ou de um Date', () => {
    expect(dayIn(MAN, '2026-10-03T03:59:59Z')).toBe('2026-10-02');
    expect(dayIn(NOR, '2026-10-03T02:59:59Z')).toBe('2026-10-03');
    expect(dayIn(MAN, new Date('2026-10-03T03:59:59Z'))).toBe('2026-10-02');
    expect(dayIn(BRT, new Date('2026-01-05T03:00:00Z'))).toBe('2026-01-05');
  });

  it('todayIn: o "hoje" de cada fuso no mesmo instante; sem instante, o relógio de agora', () => {
    const at = new Date('2026-10-03T02:30:00Z');
    expect(todayIn(NOR, at)).toBe('2026-10-03'); // 00:30 em Noronha
    expect(todayIn(BRT, at)).toBe('2026-10-02'); // 23:30 em Brasília
    expect(todayIn(MAN, at)).toBe('2026-10-02'); // 22:30 em Manaus
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    expect(todayIn(NOR)).toBe('2026-10-03');
    expect(todayIn(MAN)).toBe('2026-10-02');
  });

  it('sameClock: Manaus e Cuiabá marcam a mesma hora; Brasília e Manaus não', () => {
    const at = new Date('2026-10-02T12:00:00Z');
    expect(sameClock(MAN, CUI, at)).toBe(true);
    expect(sameClock(BRT, MAN, at)).toBe(false);
    expect(sameClock(BRT, BRT, at)).toBe(true);
    for (const a of ZONES) {
      for (const b of ZONES) expect(sameClock(a, b, at)).toBe(UTC_OFFSET[a] === UTC_OFFSET[b]);
    }
  });
});

describe('deadlineText e a nota do fuso', () => {
  it('o prazo como dia, no fuso dele: "sex, 02/10/2026, até 23:59"', () => {
    expect(deadlineText(FIM_MANAUS, MAN)).toBe('sex, 02/10/2026, até 23:59');
    // O mesmo instante lido em Brasília seria outro dia: por isso o fuso do prazo vai junto.
    expect(deadlineText(FIM_MANAUS, BRT)).toBe('sáb, 03/10/2026, até 00:59');
  });

  it('prazo legado que não é fim de dia mostra a hora real', () => {
    expect(deadlineText('2026-10-02T23:59:59Z', BRT)).toBe('sex, 02/10/2026, até 20:59');
  });

  it('virada de ano', () => {
    expect(deadlineText(endOfDayIn(RBR, '2026-12-31'), RBR)).toBe('qui, 31/12/2026, até 23:59');
  });

  it('a nota sai só para quem está em outro RELÓGIO: Manaus lido de Cuiabá não leva nota', () => {
    expect(deadlineZoneNote(FIM_MANAUS, MAN, MAN)).toBe('');
    expect(deadlineZoneNote(FIM_MANAUS, MAN, BRT)).toBe(' (horário de Manaus)');
    expect(deadlineZoneNote(FIM_MANAUS, MAN, CUI)).toBe('');
    expect(deadlineZoneNote(FIM_MANAUS, CUI, BRT)).toBe(' (horário de Cuiabá e Campo Grande)');
    expect(deadlineZoneNote(endOfDayIn(RBR, '2026-12-31'), RBR, NOR)).toBe(
      ' (horário de Rio Branco)',
    );
  });

  it('quem não escolheu fuso lê em Brasília', () => {
    expect(deadlineZoneNote(FIM_MANAUS, MAN, null)).toBe(' (horário de Manaus)');
    expect(deadlineZoneNote(FIM_MANAUS, MAN, undefined)).toBe(' (horário de Manaus)');
    expect(deadlineZoneNote('2026-10-03T02:59:59.000Z', BRT, null)).toBe('');
  });

  it('25 combinações: o mesmo dia para todos, e a nota some só no mesmo relógio', () => {
    for (const zone of ZONES) {
      const at = endOfDayIn(zone, '2026-10-02');
      for (const reader of ZONES) {
        expect(deadlineText(at, zone)).toBe('sex, 02/10/2026, até 23:59');
        const note = deadlineZoneNote(at, zone, reader);
        expect(note === '').toBe(UTC_OFFSET[zone] === UTC_OFFSET[reader]);
      }
    }
  });
});

describe('spreadDays', () => {
  it('espalha os dias por igual e o último cai no prazo', () => {
    expect(spreadDays('2026-09-28', '2026-10-05', 2)).toEqual(['2026-10-02', '2026-10-05']);
    expect(spreadDays('2026-09-28', '2026-10-05', 1)).toEqual(['2026-10-05']);
    expect(spreadDays('2026-09-10', '2026-09-20', 5)).toEqual([
      '2026-09-12',
      '2026-09-14',
      '2026-09-16',
      '2026-09-18',
      '2026-09-20',
    ]);
  });

  it('com um dia só de folga, nenhum marco cai antes de amanhã: todos no dia seguinte', () => {
    const d = '2026-10-02';
    const next = addDaysToDay(d, 1);
    expect(spreadDays(d, next, 2)).toEqual([next, next]);
  });

  it('com o prazo no próprio dia de partida (abaixo do mínimo), nenhum marco cai hoje: todos amanhã', () => {
    const d = '2026-10-02';
    expect(spreadDays(d, d, 2)).toEqual(['2026-10-03', '2026-10-03']);
  });

  it('atravessa o mês e o ano no calendário puro', () => {
    expect(spreadDays('2026-12-30', '2027-01-02', 3)).toEqual([
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });
});

describe('deadlineInfo: dias de calendário no fuso do prazo', () => {
  it('prazo de Manaus às 22:30 de lá vence hoje, mesmo com Brasília já perto da meia-noite', () => {
    const now = new Date('2026-10-03T02:30:00Z'); // 22:30 em Manaus, 23:30 em Brasília
    expect(deadlineInfo(FIM_MANAUS, MAN, now)).toEqual({
      daysLeft: 0,
      tone: 'soon',
      label: 'vence hoje',
    });
    // Lido no fuso errado (Brasília), o mesmo prazo "venceria amanhã".
    expect(deadlineInfo(FIM_MANAUS, BRT, now)).toEqual({
      daysLeft: 1,
      tone: 'soon',
      label: 'vence amanhã',
    });
  });

  it('conta em dias de calendário e marca o tom', () => {
    const now = new Date('2026-09-10T15:00:00Z'); // 10/09, meio-dia em Brasília
    const end = (day: string): string => endOfDayIn(BRT, day);
    expect(deadlineInfo(null, BRT, now)).toBeNull();
    expect(deadlineInfo(undefined, BRT, now)).toBeNull();
    expect(deadlineInfo(end('2026-09-20'), BRT, now)).toEqual({
      daysLeft: 10,
      tone: 'ok',
      label: 'faltam 10 dias',
    });
    expect(deadlineInfo(end('2026-09-14'), BRT, now)).toEqual({
      daysLeft: 4,
      tone: 'ok',
      label: 'faltam 4 dias',
    });
    expect(deadlineInfo(end('2026-09-13'), BRT, now)).toEqual({
      daysLeft: 3,
      tone: 'soon',
      label: 'faltam 3 dias',
    });
    expect(deadlineInfo(end('2026-09-12'), BRT, now)).toEqual({
      daysLeft: 2,
      tone: 'soon',
      label: 'faltam 2 dias',
    });
    expect(deadlineInfo(end('2026-09-11'), BRT, now)).toEqual({
      daysLeft: 1,
      tone: 'soon',
      label: 'vence amanhã',
    });
    expect(deadlineInfo(end('2026-09-10'), BRT, now)).toEqual({
      daysLeft: 0,
      tone: 'soon',
      label: 'vence hoje',
    });
  });

  it('vencido: "venceu hoje", "atrasada há 1 dia", "atrasada há N dias"', () => {
    const now = new Date('2026-09-10T15:00:00Z');
    expect(deadlineInfo('2026-09-10T12:00:00Z', BRT, now)).toEqual({
      daysLeft: 0,
      tone: 'late',
      label: 'venceu hoje',
    });
    expect(deadlineInfo(endOfDayIn(BRT, '2026-09-09'), BRT, now)).toEqual({
      daysLeft: -1,
      tone: 'late',
      label: 'atrasada há 1 dia',
    });
    expect(deadlineInfo(endOfDayIn(BRT, '2026-09-08'), BRT, now)).toEqual({
      daysLeft: -2,
      tone: 'late',
      label: 'atrasada há 2 dias',
    });
  });

  it('o "hoje" e o dia do prazo são os dois do fuso do prazo, não só um deles', () => {
    // 23:30 de sex 02/10 em Manaus; em Brasília já é sáb 03/10, 00:30.
    const now = new Date('2026-10-03T03:30:00Z');
    expect(deadlineInfo(endOfDayIn(MAN, '2026-10-04'), MAN, now)).toEqual({
      daysLeft: 2,
      tone: 'soon',
      label: 'faltam 2 dias',
    });
    // 23:30 de sáb 03/10 em Manaus (em Brasília, já 00:30 de dom 04/10): um dia de atraso, não dois.
    expect(
      deadlineInfo(endOfDayIn(MAN, '2026-10-02'), MAN, new Date('2026-10-04T03:30:00Z')),
    ).toEqual({ daysLeft: -1, tone: 'late', label: 'atrasada há 1 dia' });
  });

  it('no instante exato do prazo ainda "vence hoje"; um segundo depois já é o dia seguinte lá', () => {
    expect(deadlineInfo(FIM_MANAUS, MAN, new Date(FIM_MANAUS))).toEqual({
      daysLeft: 0,
      tone: 'soon',
      label: 'vence hoje',
    });
    // 00:00 de sáb 03/10 em Manaus.
    expect(deadlineInfo(FIM_MANAUS, MAN, new Date('2026-10-03T04:00:00Z'))).toEqual({
      daysLeft: -1,
      tone: 'late',
      label: 'atrasada há 1 dia',
    });
  });

  it('o atraso também conta em dias no fuso do prazo: 22:30 do dia seguinte em Manaus é "há 1 dia"', () => {
    const now = new Date('2026-10-04T02:30:00Z'); // sáb 03/10, 22:30 em Manaus; 23:30 em Brasília
    expect(deadlineInfo(FIM_MANAUS, MAN, now)).toEqual({
      daysLeft: -1,
      tone: 'late',
      label: 'atrasada há 1 dia',
    });
    // Lido em Brasília, o mesmo instante do prazo já é sábado: pareceria "venceu hoje".
    expect(deadlineInfo(FIM_MANAUS, BRT, now)).toEqual({
      daysLeft: 0,
      tone: 'late',
      label: 'venceu hoje',
    });
  });

  it('sem instante, conta a partir de agora', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T02:30:00Z'));
    expect(deadlineInfo(FIM_MANAUS, MAN)?.label).toBe('vence hoje');
  });
});

describe('deadlinePill', () => {
  const d = (
    state: ContractDeadline['state'],
    o: Partial<Pick<Contract, 'deadlineAt' | 'deadlineZone'>> = {},
  ): Pick<Contract, 'deadlineAt' | 'deadline' | 'deadlineZone'> => ({
    deadlineAt: '2026-10-08T15:00:00.000Z',
    deadlineZone: BRT,
    deadline: {
      state,
      noticeAt: null,
      mediationAt: null,
      extensionRequestsLeft: 2,
      undeliveredMilestones: 0,
      totalMilestones: 0,
      firstDeliveredAt: null,
    },
    ...o,
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

  it('correndo sem data gravada: nada; correndo com a hora já passada: "venceu"', () => {
    expect(deadlinePill(d('running', { deadlineAt: null }), now)).toBeNull();
    expect(deadlinePill(d('running', { deadlineAt: '2026-10-01T14:00:00Z' }), now)).toEqual({
      tone: 'late',
      label: 'venceu',
    });
  });

  it('a contagem é no fuso do prazo; sem o fuso (API antiga, no deploy), vale Brasília', () => {
    const at = new Date('2026-10-03T02:30:00Z');
    expect(deadlinePill(d('running', { deadlineAt: FIM_MANAUS, deadlineZone: MAN }), at)).toEqual({
      tone: 'soon',
      label: 'vence hoje',
    });
    const legacy = d('running', { deadlineAt: FIM_MANAUS });
    delete (legacy as { deadlineZone?: BrazilTimezone }).deadlineZone;
    expect(deadlinePill(legacy, at)).toEqual({ tone: 'soon', label: 'vence amanhã' });
  });
});
