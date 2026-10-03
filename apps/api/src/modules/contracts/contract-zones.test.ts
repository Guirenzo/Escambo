import type { BrazilTimezone } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import { addDaysToDay, dayIn, endOfDayIn } from '../../utils/timezone';
import { clientZoneOf, dayZoneOf, freelancerZoneOf } from './contract-zones';

/**
 * Os fusos de uma contratação (ADR 46 e 58). O fuso de uma data da contratação é calculado na
 * leitura: aquele em que ela marca 23:59:59, preferindo o de quem entrega e depois o do cliente.
 */

const ZONES: BrazilTimezone[] = [
  'America/Noronha',
  'America/Sao_Paulo',
  'America/Cuiaba',
  'America/Manaus',
  'America/Rio_Branco',
];

/** O fim de 09/10/2026 no fuso. */
const endOf9 = (zone: BrazilTimezone): Date => endOfDayIn(zone, '2026-10-09');

describe('freelancerZoneOf e clientZoneOf', () => {
  it('cada parte tem o fuso da própria coluna, e não a da outra', () => {
    const row = { freelancer_timezone: 'America/Manaus', client_timezone: 'America/Rio_Branco' };
    expect(freelancerZoneOf(row)).toBe('America/Manaus');
    expect(clientZoneOf(row)).toBe('America/Rio_Branco');
  });

  it('sem fuso (coluna nula, ausente ou com valor fora do Brasil), vale o horário de Brasília', () => {
    for (const value of [null, undefined, '', 'Europe/Lisbon', 'america/manaus']) {
      expect(freelancerZoneOf({ freelancer_timezone: value }), String(value)).toBe(
        'America/Sao_Paulo',
      );
      expect(clientZoneOf({ client_timezone: value }), String(value)).toBe('America/Sao_Paulo');
    }
    expect(freelancerZoneOf({})).toBe('America/Sao_Paulo');
    expect(clientZoneOf({})).toBe('America/Sao_Paulo');
  });
});

describe('dayZoneOf: o fuso em que a data é um dia', () => {
  const row = { freelancer_timezone: 'America/Manaus', client_timezone: 'America/Sao_Paulo' };

  it('sem data, é o fuso de quem entrega', () => {
    expect(dayZoneOf(row, null)).toBe('America/Manaus');
    expect(dayZoneOf(row, undefined)).toBe('America/Manaus');
    expect(dayZoneOf({}, null)).toBe('America/Sao_Paulo');
  });

  it('o fim do dia de quem entrega fica com ele; o fim do dia do cliente, com o cliente', () => {
    expect(dayZoneOf(row, endOf9('America/Manaus'))).toBe('America/Manaus');
    expect(dayZoneOf(row, endOf9('America/Sao_Paulo'))).toBe('America/Sao_Paulo');
  });

  it('a data pode chegar como texto ISO (a linha do banco) ou como Date', () => {
    expect(dayZoneOf(row, endOf9('America/Manaus').toISOString())).toBe('America/Manaus');
    expect(dayZoneOf(row, '2026-10-10T02:59:59.000Z')).toBe('America/Sao_Paulo');
  });

  it('o fim do dia num fuso em que ninguém está vira o nome daquele relógio', () => {
    expect(dayZoneOf(row, endOf9('America/Noronha'))).toBe('America/Noronha');
    expect(dayZoneOf(row, endOf9('America/Rio_Branco'))).toBe('America/Rio_Branco');
  });

  it('Cuiabá e Manaus marcam a mesma hora: vale o nome de quem está lá, primeiro quem entrega', () => {
    const at = endOf9('America/Manaus');
    expect(dayZoneOf({ freelancer_timezone: 'America/Cuiaba' }, at)).toBe('America/Cuiaba');
    expect(
      dayZoneOf(
        { freelancer_timezone: 'America/Sao_Paulo', client_timezone: 'America/Cuiaba' },
        at,
      ),
    ).toBe('America/Cuiaba');
    expect(
      dayZoneOf({ freelancer_timezone: 'America/Manaus', client_timezone: 'America/Cuiaba' }, at),
    ).toBe('America/Manaus');
    // Ninguém em Cuiabá: o nome do relógio é Manaus.
    expect(dayZoneOf({}, at)).toBe('America/Manaus');
  });

  it('data que não é fim de dia em nenhum relógio (contratação de antes do ADR 58): o fuso de quem entrega', () => {
    expect(dayZoneOf(row, new Date('2026-10-09T23:30:00Z'))).toBe('America/Manaus');
    expect(dayZoneOf({ client_timezone: 'America/Manaus' }, new Date('2026-10-09T23:30:00Z'))).toBe(
      'America/Sao_Paulo',
    );
  });

  it('propriedade: com o fim de qualquer dia em qualquer fuso, o fuso escolhido termina o dia naquele instante, para qualquer par de partes', () => {
    for (const freelancer of ZONES) {
      for (const client of ZONES) {
        for (const target of ZONES) {
          for (const n of [0, 30, 120, 200]) {
            const at = endOfDayIn(target, addDaysToDay('2026-10-09', n));
            const zone = dayZoneOf(
              { freelancer_timezone: freelancer, client_timezone: client },
              at,
            );
            const label = `${freelancer} / ${client} / fim do dia em ${target} (+${n})`;
            // O instante é o último segundo do dia no fuso escolhido: um segundo depois, outro dia.
            expect(dayIn(zone, new Date(at.getTime() + 1000)), label).toBe(
              addDaysToDay(dayIn(zone, at), 1),
            );
            // E é o mesmo dia que o fuso de onde veio: as duas partes leem o mesmo dia.
            expect(dayIn(zone, at), label).toBe(dayIn(target, at));
            // Se uma das partes está num relógio que serve, o nome é o dela (quem entrega primeiro).
            const own = [freelancer, client].find(
              (z) => dayIn(z, new Date(at.getTime() + 1000)) !== dayIn(z, at),
            );
            if (own) expect(zone, label).toBe(own);
          }
        }
      }
    }
  });
});
