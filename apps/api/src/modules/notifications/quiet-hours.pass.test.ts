import { describe, expect, it } from 'vitest';
import {
  PUSH_TTL_MAX_SECONDS,
  PUSH_TTL_MIN_SECONDS,
  QUIET_PASS_CATEGORIES,
  pushTiming,
  quietPassOf,
} from './quiet-hours';

/**
 * O que sai durante o "não perturbe" (ADR 56): a lista fechada, a leitura do SET do banco e a
 * decisão pura do push. Janela 22→7 em Brasília (UTC−3): 22:00 = 01:00Z.
 */
const noite = { start: 22, end: 7 };
const liberado = {
  zone: 'America/Sao_Paulo' as const,
  window: noite,
  category: 'deadline' as const,
  allowed: ['deadline'] as const,
};
const as = (iso: string) => new Date(iso);

describe('lista do que pode sair no silêncio (ADR 56)', () => {
  it('é exatamente [deadline]: mudou, muda também o ADR, a Política e a migration', () => {
    expect([...QUIET_PASS_CATEGORIES]).toEqual(['deadline']);
  });

  it('quietPassOf lê o SET: NULL é nunca escolheu, vazio é nada, desconhecido some', () => {
    expect(quietPassOf(null)).toBeNull();
    expect(quietPassOf(undefined)).toBeNull();
    expect(quietPassOf('')).toEqual([]);
    expect(quietPassOf('deadline')).toEqual(['deadline']);
    expect(quietPassOf('deadline,xyz')).toEqual(['deadline']);
    expect(quietPassOf('xyz')).toEqual([]);
  });
});

describe('pushTiming (ADR 54 e 56)', () => {
  it('22:00 com o prazo liberado: sai, fura o silêncio e fica até 12 h no serviço de push', () => {
    expect(pushTiming({ ...liberado, now: as('2026-09-26T01:00:00Z') })).toEqual({
      hold: false,
      ttlSeconds: PUSH_TTL_MAX_SECONDS,
      breaksQuiet: true,
    });
  });

  it('22:00 com prazo e a pessoa sem liberar: retém', () => {
    expect(pushTiming({ ...liberado, allowed: [], now: as('2026-09-26T01:00:00Z') })).toEqual({
      hold: true,
    });
  });

  it('22:00 sem categoria, mesmo com a liberação: retém (liberar sozinho não passa)', () => {
    expect(pushTiming({ ...liberado, category: null, now: as('2026-09-26T01:00:00Z') })).toEqual({
      hold: true,
    });
  });

  it('06:59 liberado fura; 07:00 liberado já sai sem furar, com 12 h', () => {
    expect(pushTiming({ ...liberado, now: as('2026-09-26T09:59:00Z') })).toMatchObject({
      hold: false,
      breaksQuiet: true,
    });
    expect(pushTiming({ ...liberado, now: as('2026-09-26T10:00:00Z') })).toEqual({
      hold: false,
      ttlSeconds: PUSH_TTL_MAX_SECONDS,
      breaksQuiet: false,
    });
  });

  it('21:50 liberado leva 12 h sem furar; o comum leva o piso de 15 min, como no ADR 54', () => {
    expect(pushTiming({ ...liberado, now: as('2026-09-26T00:50:00Z') })).toEqual({
      hold: false,
      ttlSeconds: PUSH_TTL_MAX_SECONDS,
      breaksQuiet: false,
    });
    expect(pushTiming({ ...liberado, category: null, now: as('2026-09-26T00:50:00Z') })).toEqual({
      hold: false,
      ttlSeconds: PUSH_TTL_MIN_SECONDS,
      breaksQuiet: false,
    });
  });

  it('sem janela, liberado sai com 12 h e nunca fura', () => {
    expect(pushTiming({ ...liberado, window: null, now: as('2026-09-26T01:00:00Z') })).toEqual({
      hold: false,
      ttlSeconds: PUSH_TTL_MAX_SECONDS,
      breaksQuiet: false,
    });
  });

  it('janela diurna 13→14, às 13:30 liberado: fura', () => {
    expect(
      pushTiming({ ...liberado, window: { start: 13, end: 14 }, now: as('2026-09-25T16:30:00Z') }),
    ).toMatchObject({ hold: false, breaksQuiet: true });
  });

  it('o fuso da conta manda: 10:00Z é 07:00 em Brasília e 06:00 em Manaus', () => {
    const now = as('2026-09-26T10:00:00Z');
    expect(pushTiming({ ...liberado, now })).toMatchObject({ breaksQuiet: false });
    expect(pushTiming({ ...liberado, zone: 'America/Manaus', now })).toMatchObject({
      breaksQuiet: true,
    });
    expect(pushTiming({ ...liberado, zone: 'America/Manaus', category: null, now })).toEqual({
      hold: true,
    });
  });
});
