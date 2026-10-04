import type { BrazilTimezone } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import {
  REMINDER_MIN_AGE_MS,
  REMINDER_SLOT_MIN_LEFT_MS,
  nineAtOrBefore,
  reminderDue,
  reminderSlot,
} from './human-hours';
import { BRAZIL_TIMEZONES, endOfDayIn, localInstant, localParts } from './timezone';

const BRT: BrazilTimezone = 'America/Sao_Paulo';
const MAN: BrazilTimezone = 'America/Manaus';
const RBR: BrazilTimezone = 'America/Rio_Branco';
const NOR: BrazilTimezone = 'America/Noronha';

/** "2026-10-01 09:00[:ss]" no relógio de parede do fuso. */
function at(zone: BrazilTimezone, text: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) throw new Error(text);
  return localInstant(zone, +m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
}

const SEX_FIM = endOfDayIn(BRT, '2026-10-02');

/**
 * Quando cada lembrete sai (ADR 58), na semana de seg 28/09 a dom 04/10/2026. A tabela é a C.4 do
 * desenho: cada linha saiu do protótipo e várias matam um mutante (nomeado no fim da linha).
 */
describe('reminderSlot', () => {
  const cases: [string, Date | null, Date, BrazilTimezone, Date | null][] = [
    // [caso, início, vencimento, fuso de quem recebe, slot]
    ['1 entrega, véspera', at(BRT, '2026-09-28 11:00'), SEX_FIM, BRT, at(BRT, '2026-10-01 09:00')],
    ['1a Manaus', at(MAN, '2026-09-28 11:00'), endOfDayIn(MAN, '2026-10-02'), MAN, new Date('2026-10-01T13:00:00Z')],
    ['1b Rio Branco', at(RBR, '2026-09-28 11:00'), endOfDayIn(RBR, '2026-10-02'), RBR, new Date('2026-10-01T14:00:00Z')],
    ['1c Noronha', at(NOR, '2026-09-28 11:00'), endOfDayIn(NOR, '2026-10-02'), NOR, new Date('2026-10-01T11:00:00Z')],
    ['2 véspera 1 h depois do início: o próprio dia', at(BRT, '2026-10-01 08:00'), SEX_FIM, BRT, at(BRT, '2026-10-02 09:00')],
    ['3 12 h 01 até o dia', at(BRT, '2026-10-01 20:59'), SEX_FIM, BRT, at(BRT, '2026-10-02 09:00')],
    ['4 o dia fica 11 h 30 depois: nenhum', at(BRT, '2026-10-01 21:30'), SEX_FIM, BRT, null],
    ['5 véspera com 12 h 01', at(BRT, '2026-09-30 20:59'), SEX_FIM, BRT, at(BRT, '2026-10-01 09:00')],
    ['6 borda das 12 h na véspera', at(BRT, '2026-09-30 21:01'), SEX_FIM, BRT, at(BRT, '2026-10-02 09:00')],
    ['7 prazo de Rio Branco, freelancer hoje em Noronha', at(NOR, '2026-09-28 11:00'), endOfDayIn(RBR, '2026-10-02'), NOR, at(NOR, '2026-10-01 09:00')],
    ['8 prazo de Noronha, freelancer hoje em Rio Branco', at(RBR, '2026-09-28 11:00'), endOfDayIn(NOR, '2026-10-02'), RBR, at(RBR, '2026-10-01 09:00')],
    ['9 legado às 23:59:59Z', at(BRT, '2026-09-28 11:00'), new Date('2026-10-02T23:59:59Z'), BRT, at(BRT, '2026-10-01 09:00')],
    ['10 tácita de 5 dias', at(BRT, '2026-09-29 18:20'), at(BRT, '2026-10-04 18:20'), BRT, at(BRT, '2026-10-03 09:00')],
    ['11 tácita levada para as 9h', at(BRT, '2026-09-29 21:30'), at(BRT, '2026-10-05 09:00'), BRT, at(BRT, '2026-10-04 09:00')],
    ['12 tácita de entrega de madrugada', at(BRT, '2026-09-29 03:00'), at(BRT, '2026-10-04 09:00'), BRT, at(BRT, '2026-10-03 09:00')],
    ['13 tácita de 1 dia: véspera é o início, dia é o vencimento', at(BRT, '2026-09-29 09:00'), at(BRT, '2026-09-30 09:00'), BRT, null],
    ['14 tácita de 1 dia ao meio-dia', at(BRT, '2026-09-29 12:00'), at(BRT, '2026-09-30 12:00'), BRT, at(BRT, '2026-09-30 09:00')],
    ['15 tácita de 1 dia às 16h', at(BRT, '2026-09-29 16:00'), at(BRT, '2026-09-30 16:00'), BRT, at(BRT, '2026-09-30 09:00')],
    ['16 12 h exatas valem (≥, não >)', at(BRT, '2026-09-29 21:00'), at(BRT, '2026-10-01 09:00'), BRT, at(BRT, '2026-09-30 09:00')],
    ['17 véspera 10 h depois; dia = vencimento', at(BRT, '2026-09-29 23:00'), at(BRT, '2026-10-01 09:00'), BRT, null],
    ['18 proposta de 72 h', at(BRT, '2026-09-28 10:15'), at(BRT, '2026-10-01 10:15'), BRT, at(BRT, '2026-09-30 09:00')],
    ['19 proposta da noite', at(BRT, '2026-09-28 22:00'), at(BRT, '2026-10-02 09:00'), BRT, at(BRT, '2026-10-01 09:00')],
    ['20 proposta com prazo perto', at(BRT, '2026-09-30 10:00'), at(BRT, '2026-10-01 20:29:59'), BRT, at(BRT, '2026-10-01 09:00')],
    ['21 12 h 15 desde o início', at(BRT, '2026-09-30 20:45'), at(BRT, '2026-10-01 20:29:59'), BRT, at(BRT, '2026-10-01 09:00')],
    ['22 menos de 12 h até o dia', at(BRT, '2026-09-30 21:30'), at(BRT, '2026-10-01 20:29:59'), BRT, null],
    ['23 proposta a 3 h de expirar', at(BRT, '2026-10-01 17:30'), at(BRT, '2026-10-01 20:29:59'), BRT, null],
    ['24 pedido de extensão de 48 h', at(BRT, '2026-09-29 16:40'), at(BRT, '2026-10-01 16:40'), BRT, at(BRT, '2026-09-30 09:00')],
    ['25 extensão para sexta', at(BRT, '2026-10-01 08:00'), at(BRT, '2026-10-02 11:59:59'), BRT, at(BRT, '2026-10-02 09:00')],
    ['26 extensão para sábado', at(BRT, '2026-10-01 22:00'), at(BRT, '2026-10-03 11:59:59'), BRT, at(BRT, '2026-10-03 09:00')],
    ['27 resposta em 12 h', at(BRT, '2026-10-01 23:59'), at(BRT, '2026-10-02 11:59:59'), BRT, null],
    ['28 sobram 2 h 29 min 59 s: nenhum (2 h 30, não 2 h)', at(BRT, '2026-10-01 22:00'), at(BRT, '2026-10-03 11:29:59'), BRT, null],
    ['29 borda das 2 h 30', at(BRT, '2026-10-01 22:00'), at(BRT, '2026-10-03 11:30:59'), BRT, at(BRT, '2026-10-03 09:00')],
    ['30 entrega depois da recusa às 15h', at(BRT, '2026-10-01 15:00'), SEX_FIM, BRT, at(BRT, '2026-10-02 09:00')],
    ['31 2º pedido para a mesma data', at(BRT, '2026-10-01 10:30'), at(BRT, '2026-10-02 11:59:59'), BRT, at(BRT, '2026-10-02 09:00')],
    ['sem início: só a véspera conta', null, SEX_FIM, BRT, at(BRT, '2026-10-01 09:00')],
  ];

  it.each(cases)('%s', (_name, start, due, zone, expected) => {
    expect(reminderSlot({ start, due, zone })).toEqual(expected);
  });
});

describe('reminderDue', () => {
  const sab9 = at(BRT, '2026-10-03 09:00');
  const sabVence = at(BRT, '2026-10-03 11:59:59');

  it('sai a partir do slot, e nunca com menos de 2 h pela frente', () => {
    const due = (now: string): boolean =>
      reminderDue({ now: at(BRT, now), slot: sab9, due: sabVence, zone: BRT });
    expect(due('2026-10-03 08:59:59')).toBe(false);
    expect(due('2026-10-03 09:00:00')).toBe(true);
    expect(due('2026-10-03 09:59:59')).toBe(true);
    expect(due('2026-10-03 10:00:00')).toBe(false);
  });

  it('só de dia (9h às 21h) no fuso de quem recebe', () => {
    const qui9 = at(BRT, '2026-10-01 09:00');
    const due = (now: string): boolean =>
      reminderDue({ now: at(BRT, now), slot: qui9, due: SEX_FIM, zone: BRT });
    expect(due('2026-10-01 20:59:59')).toBe(true);
    expect(due('2026-10-01 21:00:00')).toBe(false);
    expect(due('2026-10-02 09:00:00')).toBe(true);
    expect(due('2026-10-02 21:59:59')).toBe(false);
  });

  it('sem slot, nunca', () => {
    expect(reminderDue({ now: at(BRT, '2026-10-01 12:00'), slot: null, due: SEX_FIM, zone: BRT })).toBe(false);
  });
});

describe('nineAtOrBefore', () => {
  it('as 9h de hoje se já passaram; senão, as de ontem', () => {
    expect(nineAtOrBefore(at(BRT, '2026-10-01 09:00'), BRT)).toEqual(at(BRT, '2026-10-01 09:00'));
    expect(nineAtOrBefore(at(BRT, '2026-10-01 08:59:59'), BRT)).toEqual(at(BRT, '2026-09-30 09:00'));
  });
});

describe('propriedades do slot (20.000 casos de semente fixa)', () => {
  it('sempre às 9h locais, 12 h depois do início, e entre 2 h 30 e 48 h antes do vencimento', () => {
    let seed = 58;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const base = Date.UTC(2026, 8, 28);
    let withSlot = 0;
    for (let i = 0; i < 20_000; i++) {
      const zone = BRAZIL_TIMEZONES[Math.floor(rand() * BRAZIL_TIMEZONES.length)]!;
      const start = new Date(base + Math.floor(rand() * 7 * 24 * 3600) * 1000);
      const due = new Date(start.getTime() + Math.floor(rand() * 6 * 24 * 3600) * 1000);
      const slot = reminderSlot({ start, due, zone });
      if (!slot) continue;
      withSlot++;
      const p = localParts(zone, slot);
      expect([p.hour, p.minute, p.second]).toEqual([9, 0, 0]);
      expect(slot.getTime()).toBeGreaterThanOrEqual(start.getTime() + REMINDER_MIN_AGE_MS);
      expect(due.getTime() - slot.getTime()).toBeGreaterThanOrEqual(REMINDER_SLOT_MIN_LEFT_MS);
      expect(due.getTime() - slot.getTime()).toBeLessThan(48 * 3_600_000);
    }
    expect(withSlot).toBeGreaterThan(10_000);
    // 20.000 casos com Intl levam ~1 s sozinhos; com a máquina ou o runner do CI carregados, passam dos
    // 5 s padrão sem nada de errado.
  }, 30_000);
});
