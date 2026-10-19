import { describe, expect, it } from 'vitest';
import { isHumanInstant } from '../../utils/human-hours';
import { BRAZIL_TIMEZONES } from '../../utils/timezone';
import { money } from './cancel-policy';
import {
  canCounter,
  countersLeft,
  feePctOf,
  holdAdjust,
  madeByOf,
  milestoneNets,
  offerRespondBy,
  offerTerms,
  roundOf,
  sameShape,
  sameTerms,
  turnOf,
  type CounterOfferRequest,
  type OfferLike,
} from './offers';

const brt = (value: string): Date => new Date(`${value.replace(' ', 'T')}-03:00`);
const SP = 'America/Sao_Paulo' as const;
const toCents = (value: number): number => Math.round(value * 100);
function random(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('ofertas puras (ADR 61)', () => {
  it.each([
    [1, 'client', 'freelancer', 1, true, 2],
    [2, 'freelancer', 'client', 1, true, 2],
    [3, 'client', 'freelancer', 2, true, 1],
    [4, 'freelancer', 'client', 2, true, 1],
    [5, 'client', 'freelancer', 3, false, 0],
  ] as const)(
    'oferta %i: autor, vez, rodada e contrapropostas restantes',
    (seq, author, turn, round, counter, left) => {
      expect(madeByOf(seq)).toBe(author);
      expect(turnOf(seq)).toBe(turn);
      expect(roundOf(seq)).toBe(round);
      expect(canCounter(seq)).toBe(counter);
      expect(countersLeft(seq)).toBe(left);
    },
  );

  it.each([0, 6, -1, 1.5, NaN, Infinity])('recusa sequência inválida %s', (seq) => {
    for (const fn of [madeByOf, turnOf, roundOf, canCounter, countersLeft])
      expect(() => fn(seq)).toThrow(RangeError);
  });

  describe('taxa histórica', () => {
    it.each([
      ['33.33', '5.00', null, 15],
      ['10.00', '5.00', null, 50],
      ['10.00', '0.00', null, 0],
      ['10.00', '1.20', '12.00', 12],
      ['10.00', '1.25', '12.50', 12.5],
      ['10.01', '1.50', null, 15],
    ])('preço %s, taxa %s, snapshot %s → %s%%', (price, platform_fee, fee_percentage, pct) => {
      expect(feePctOf({ price: price!, platform_fee: platform_fee!, fee_percentage })).toBe(pct);
    });

    it('10,01 / 1,50 mantém 15% na oferta de 1.000,00', () => {
      const pct = feePctOf({ price: '10.01', platform_fee: '1.50', fee_percentage: null });
      expect(offerTerms({ price: 1000, pct, mode: 'cash' })).toEqual({
        price: 1000,
        fee: 150,
        net: 850,
        milestones: null,
      });
    });

    it.each([
      { price: '10.00', platform_fee: '1.25', fee_percentage: null },
      { price: '10.00', platform_fee: '1.50', fee_percentage: '12.00' },
      { price: '10.00', platform_fee: '5.10', fee_percentage: null },
      { price: '0.00', platform_fee: '0.00', fee_percentage: null },
      { price: 'NaN', platform_fee: '0.00', fee_percentage: null },
      { price: '10.005', platform_fee: '1.50', fee_percentage: null },
      { price: '10.00', platform_fee: '1.50', fee_percentage: '' },
    ])('dados históricos incoerentes falham explicitamente: %j', (row) => {
      expect(() => feePctOf(row)).toThrow(RangeError);
    });

    it('recupera o percentual inteiro em 5.000 preços de centavos até o teto da coluna', () => {
      const rand = random(61);
      for (let i = 0; i < 5000; i++) {
        const price = (1000 + Math.floor(rand() * (9_999_999_999 - 1000 + 1))) / 100;
        const pct = Math.floor(rand() * 51);
        const fee = money((price * pct) / 100);
        expect(
          feePctOf({ price: price.toFixed(2), platform_fee: fee.toFixed(2), fee_percentage: null }),
        ).toBe(pct);
      }
    });
  });

  describe('termos financeiros', () => {
    it('rateio direto mantém os arredondamentos normais e não depende de ids', () => {
      expect(milestoneNets([10.01, 10.01], 10.01, 50)).toEqual([5.01, 5]);
      expect(milestoneNets([300, 350], 552.5, 15)).toEqual([255, 297.5]);
      expect(milestoneNets([5, 5], 0, 50)).toEqual([0, 0]);
      expect(milestoneNets([5, 5], 10, 0)).toEqual([5, 5]);
      expect(milestoneNets([], 0, 0)).toEqual([]);
    });

    it('rateio direto conserva o líquido e os limites em parcelas de um centavo', () => {
      const amounts = Object.freeze([9.91, ...Array<number>(9).fill(0.01)]);
      const nets = milestoneNets(amounts, 5, 50);
      expect(nets.reduce((sum, value) => sum + toCents(value), 0)).toBe(500);
      nets.forEach((value, i) => {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(amounts[i]!);
      });
    });

    it('rateio direto recusa líquidos, valores e percentuais incoerentes', () => {
      for (const net of [-0.01, 10.01, 5.001, NaN, Infinity]) {
        expect(() => milestoneNets([5, 5], net, 50)).toThrow(RangeError);
      }
      for (const amount of [0, -0.01, 0.001, NaN, Infinity]) {
        expect(() => milestoneNets([amount, 5], 1, 50)).toThrow(RangeError);
      }
      for (const pct of [-1, 51, 12.345, NaN, Infinity]) {
        expect(() => milestoneNets([5, 5], 5, pct)).toThrow(RangeError);
      }
      expect(() => milestoneNets([], 0.01, 0)).toThrow(/soma/);
    });

    it('arredonda meio centavo e fecha preço = taxa + líquido', () => {
      expect(offerTerms({ price: 33.33, pct: 15, mode: 'cash' })).toEqual({
        price: 33.33,
        fee: 5,
        net: 28.33,
        milestones: null,
      });
      expect(offerTerms({ price: 10.01, pct: 50, mode: 'cash' }).net).toBe(5);
      expect(offerTerms({ price: 99_999_999.99, pct: 50, mode: 'cash' }).fee).toBe(50_000_000);
    });

    it('o último marco absorve o centavo e preserva ids, ordem, título e data', () => {
      const milestones = [
        { id: 7, title: 'Layout', amount: 10.01, dueAt: '2026-10-10T02:59:59Z' },
        { id: 9, title: 'Site', amount: 10.01, dueAt: null },
      ];
      expect(offerTerms({ price: 20.02, pct: 50, mode: 'cash', milestones })).toEqual({
        price: 20.02,
        fee: 10.01,
        net: 10.01,
        milestones: [
          { ...milestones[0], freelancerNet: 5.01 },
          { ...milestones[1], freelancerNet: 5 },
        ],
      });
      expect(milestones[1]).not.toHaveProperty('freelancerNet');
    });

    it('créditos inteiros não cobram taxa, inclusive por marcos', () => {
      expect(
        offerTerms({
          price: 20,
          pct: 0,
          mode: 'credits',
          milestones: [
            { id: 1, amount: 7, dueAt: null },
            { id: 2, amount: 13, dueAt: null },
          ],
        }),
      ).toEqual({
        price: 20,
        fee: 0,
        net: 20,
        milestones: [
          { id: 1, amount: 7, freelancerNet: 7, dueAt: null },
          { id: 2, amount: 13, freelancerNet: 13, dueAt: null },
        ],
      });
      expect(() => offerTerms({ price: 10.01, pct: 0, mode: 'credits' })).toThrow(/inteiros/);
      expect(() => offerTerms({ price: 10, pct: 15, mode: 'credits' })).toThrow(/taxa/);
      expect(() =>
        offerTerms({
          price: 10,
          pct: 0,
          mode: 'credits',
          milestones: [
            { id: 1, amount: 4.5, dueAt: null },
            { id: 2, amount: 5.5, dueAt: null },
          ],
        }),
      ).toThrow(/inteiros/);
    });

    it.each([NaN, Infinity, -1, 9.99, 10.005, 100_000_000])('recusa preço inválido %s', (price) => {
      expect(() => offerTerms({ price, pct: 15, mode: 'cash' })).toThrow(RangeError);
    });
    it.each([NaN, Infinity, -1, 50.01, 12.345])('recusa percentual inválido %s', (pct) => {
      expect(() => offerTerms({ price: 10, pct, mode: 'cash' })).toThrow(RangeError);
    });

    it('recusa marcos ausentes, duplicados, de soma errada ou valores inválidos', () => {
      const run = (milestones: { id: number; amount: number; dueAt: string | null }[]) =>
        offerTerms({ price: 10, pct: 50, mode: 'cash', milestones });
      expect(() => run([])).toThrow(/2 a 10/);
      expect(() => run([{ id: 1, amount: 10, dueAt: null }])).toThrow(/2 a 10/);
      expect(() =>
        run([
          { id: 1, amount: 5, dueAt: null },
          { id: 1, amount: 5, dueAt: null },
        ]),
      ).toThrow(/únicos/);
      expect(() =>
        run([
          { id: 1, amount: 5, dueAt: null },
          { id: 2, amount: 4.99, dueAt: null },
        ]),
      ).toThrow(/soma/);
      expect(() =>
        run([
          { id: 1, amount: 0, dueAt: null },
          { id: 2, amount: 10, dueAt: null },
        ]),
      ).toThrow(RangeError);
      expect(() =>
        run([
          { id: 1, amount: 5, dueAt: 'inválida' },
          { id: 2, amount: 5, dueAt: null },
        ]),
      ).toThrow(/data/);
    });

    it('parcelas de um centavo nunca criam líquido negativo nem maior que o marco', () => {
      for (const amounts of [
        [9.91, ...Array<number>(9).fill(0.01)],
        [...Array<number>(9).fill(1.11), 0.01],
        [...Array<number>(9).fill(0.01), 9.91],
      ]) {
        const terms = offerTerms({
          price: 10,
          pct: 50,
          mode: 'cash',
          milestones: amounts.map((amount, i) => ({ id: i + 1, amount, dueAt: null })),
        });
        expect(terms.milestones!.reduce((sum, m) => sum + toCents(m.freelancerNet), 0)).toBe(500);
        for (const m of terms.milestones!) {
          expect(m.freelancerNet).toBeGreaterThanOrEqual(0);
          expect(m.freelancerNet).toBeLessThanOrEqual(m.amount);
        }
      }
    });

    it('conserva centavos em 1.000 ofertas por marcos', () => {
      const rand = random(142);
      for (let i = 0; i < 1000; i++) {
        const count = 2 + Math.floor(rand() * 9);
        const priceCents = 1000 + Math.floor(rand() * 9_999_000);
        const part = Math.floor(priceCents / count);
        const milestones = Array.from({ length: count }, (_, j) => ({
          id: j + 1,
          amount: (j === count - 1 ? priceCents - part * (count - 1) : part) / 100,
          dueAt: null,
        }));
        const terms = offerTerms({
          price: priceCents / 100,
          pct: Math.floor(rand() * 51),
          mode: 'cash',
          milestones,
        });
        expect(toCents(terms.fee) + toCents(terms.net)).toBe(priceCents);
        expect(terms.milestones!.reduce((sum, m) => sum + toCents(m.freelancerNet), 0)).toBe(
          toCents(terms.net),
        );
        for (const m of terms.milestones!) {
          expect(m.freelancerNet).toBeGreaterThanOrEqual(0);
          expect(m.freelancerNet).toBeLessThanOrEqual(m.amount);
        }
      }
    });
  });

  describe('hora de resposta', () => {
    it.each([
      ['2026-10-06 16:40:00', 48, SP, '2026-10-19 23:59:59', '2026-10-08 16:40:00'],
      ['2026-10-06 20:45:00', 48, SP, '2026-10-19 23:59:59', '2026-10-09 09:00:00'],
      ['2026-10-06 19:30:00', 48, 'America/Manaus', '2026-10-19 23:59:59', '2026-10-08 19:30:00'],
      ['2026-10-06 21:45:00', 48, 'America/Manaus', '2026-10-19 23:59:59', '2026-10-09 10:00:00'],
      ['2026-10-06 22:00:00', 48, 'America/Noronha', null, '2026-10-09 08:00:00'],
      ['2026-10-07 11:00:00', 48, SP, '2026-10-08 23:59:59', '2026-10-08 20:29:59'],
      ['2026-10-08 20:00:00', 48, SP, '2026-10-08 23:59:59', null],
      ['2026-10-07 11:00:00', 24, SP, null, '2026-10-08 11:00:00'],
      ['2026-10-09 10:00:00', 168, SP, null, '2026-10-16 10:00:00'],
    ] as const)('%s + %i h, %s, prazo %s → %s', (now, hours, zone, deadline, result) => {
      expect(
        offerRespondBy({
          now: brt(now),
          hours,
          zone,
          deadline: deadline === null ? null : brt(deadline),
        }),
      ).toEqual(result === null ? null : brt(result));
    });

    it('inclui exatamente uma hora; exclui um milissegundo a menos e prazo passado', () => {
      const deadline = brt('2026-10-08 23:59:59');
      const now = brt('2026-10-08 19:29:59');
      expect(offerRespondBy({ now, hours: 48, zone: SP, deadline })).toEqual(
        brt('2026-10-08 20:29:59'),
      );
      expect(
        offerRespondBy({ now: new Date(now.getTime() + 1), hours: 48, zone: SP, deadline }),
      ).toBeNull();
      expect(
        offerRespondBy({ now, hours: 48, zone: SP, deadline: new Date(now.getTime() - 1) }),
      ).toBeNull();
      expect(now).toEqual(brt('2026-10-08 19:29:59'));
    });

    it('recusa configurações e datas inválidas', () => {
      for (const hours of [0, -1, 1.5, 721, NaN, Infinity])
        expect(() =>
          offerRespondBy({ now: brt('2026-10-06 12:00:00'), hours, zone: SP, deadline: null }),
        ).toThrow(RangeError);
      expect(() =>
        offerRespondBy({ now: new Date(NaN), hours: 48, zone: SP, deadline: null }),
      ).toThrow(/data/);
      expect(() =>
        offerRespondBy({
          now: brt('2026-10-06 12:00:00'),
          hours: 48,
          zone: SP,
          deadline: new Date(NaN),
        }),
      ).toThrow(/data/);
    });

    it('1.000 instantes nos cinco fusos: faixa humana, precisão de segundos, janela mínima e teto', () => {
      const rand = random(78);
      for (let i = 0; i < 1000; i++) {
        const zone = BRAZIL_TIMEZONES[i % BRAZIL_TIMEZONES.length]!;
        const now = new Date(
          Date.parse('2026-01-01T00:00:00Z') + Math.floor(rand() * 365 * 86_400_000),
        );
        const deadline = new Date(now.getTime() + (1 + Math.floor(rand() * 240)) * 3_600_000);
        const due = offerRespondBy({ now, hours: 24 + Math.floor(rand() * 145), zone, deadline });
        if (due === null) continue;
        expect(isHumanInstant(due, zone)).toBe(true);
        expect(due.getMilliseconds()).toBe(0);
        expect(due.getTime() - now.getTime()).toBeGreaterThanOrEqual(3_600_000);
        expect(due.getTime()).toBeLessThanOrEqual(deadline.getTime());
      }
    });
  });

  describe('reserva e comparação', () => {
    it('sobe, baixa, não muda e calcula 10,01 → 10,02 sem fração de centavo', () => {
      expect(holdAdjust(7, 500, 650)).toEqual([
        { userId: 7, balanceDelta: -150, pendingDelta: 150, reason: 'hold' },
      ]);
      expect(holdAdjust(7, 500, 450)).toEqual([
        { userId: 7, balanceDelta: 50, pendingDelta: -50, reason: 'hold_release' },
      ]);
      expect(holdAdjust(7, 500, 500)).toEqual([]);
      expect(holdAdjust(7, 10.01, 10.02)).toEqual([
        { userId: 7, balanceDelta: -0.01, pendingDelta: 0.01, reason: 'hold' },
      ]);
      expect(() => holdAdjust(0, 10, 11)).toThrow(/Cliente/);
      expect(() => holdAdjust(7, 10.001, 11)).toThrow(RangeError);
      expect(() => holdAdjust(7, 10, NaN)).toThrow(RangeError);
    });

    it('5.000 ajustes conservam o total da carteira e desfazem exatamente a diferença', () => {
      const rand = random(23);
      for (let i = 0; i < 5000; i++) {
        const held = Math.floor(rand() * 10_000_000) / 100;
        const next = Math.floor(rand() * 10_000_000) / 100;
        const effects = holdAdjust(7, held, next);
        const reverse = holdAdjust(7, next, held);
        if (held === next) {
          expect(effects).toEqual([]);
          continue;
        }
        expect(toCents(effects[0]!.balanceDelta) + toCents(effects[0]!.pendingDelta)).toBe(0);
        expect(toCents(held) + toCents(effects[0]!.pendingDelta)).toBe(toCents(next));
        expect(toCents(reverse[0]!.pendingDelta)).toBe(-toCents(effects[0]!.pendingDelta));
      }
    });

    const base: OfferLike = {
      price: 20,
      deadlineAt: '2026-10-20T02:59:59Z',
      milestones: [
        { id: 1, amount: 7, dueAt: '2026-10-15T02:59:59Z' },
        { id: 2, amount: 13, dueAt: null },
      ],
    };
    it('compara instantes equivalentes e detecta cada mudança relevante', () => {
      expect(
        sameTerms(base, {
          ...base,
          deadlineAt: new Date(base.deadlineAt!),
          milestones: [
            { id: 1, amount: 7, dueAt: '2026-10-14T23:59:59-03:00' },
            { id: 2, amount: 13, dueAt: null },
          ],
        }),
      ).toBe(true);
      expect(sameTerms(base, { ...base, price: 21 })).toBe(false);
      expect(sameTerms(base, { ...base, deadlineAt: null })).toBe(false);
      expect(sameTerms(base, { ...base, milestones: null })).toBe(false);
      expect(sameTerms(base, { ...base, milestones: [...base.milestones!].reverse() })).toBe(false);
      expect(
        sameTerms(base, {
          ...base,
          milestones: [{ ...base.milestones![0]!, amount: 8 }, base.milestones![1]!],
        }),
      ).toBe(false);
      expect(
        sameTerms(base, {
          ...base,
          milestones: [{ ...base.milestones![0]!, dueAt: null }, base.milestones![1]!],
        }),
      ).toBe(false);
      expect(
        sameTerms(
          { price: 10, deadlineAt: null },
          { price: 10, deadlineAt: null, milestones: null },
        ),
      ).toBe(true);
    });

    it('forma não muda prazo × sem prazo, nem ids, ordem ou entrega única × marcos', () => {
      const body: CounterOfferRequest = {
        seq: 2,
        price: 20,
        deadlineAt: '2026-10-20T02:59:59Z',
        message: 'Novo combinado',
        milestones: [
          { id: 1, amount: 8, dueAt: null },
          { id: 2, amount: 12, dueAt: null },
        ],
      };
      expect(sameShape({ deadline_at: brt('2026-10-15 23:59:59') }, [1, 2], body)).toBe(true);
      expect(sameShape({ deadline_at: null }, [1, 2], body)).toBe(false);
      expect(sameShape({ deadline_at: new Date() }, [2, 1], body)).toBe(false);
      expect(sameShape({ deadline_at: new Date() }, [1, 3], body)).toBe(false);
      expect(sameShape({ deadline_at: new Date() }, null, body)).toBe(false);
      expect(
        sameShape({ deadline_at: null }, null, {
          ...body,
          deadlineAt: null,
          milestones: undefined,
        }),
      ).toBe(true);
      expect(
        sameShape({ deadline_at: null }, null, { ...body, deadlineAt: null, milestones: [] }),
      ).toBe(false);
    });
  });
});
