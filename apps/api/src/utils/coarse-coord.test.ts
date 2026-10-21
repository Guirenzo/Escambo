import { describe, expect, it } from 'vitest';
import { COARSE_COORD_DECIMALS, coarseCoord } from './coarse-coord';

/** Casas decimais de um número como o JSON o escreve (sem notação científica nos casos abaixo). */
const decimals = (n: number): number => (String(n).split('.')[1] ?? '').length;

describe('coarseCoord (localização pública a ~1 km)', () => {
  it('corta para 2 casas, positivo e negativo', () => {
    expect(COARSE_COORD_DECIMALS).toBe(2);
    expect(coarseCoord(-26.30449)).toBe(-26.3);
    expect(coarseCoord(-48.84561234)).toBe(-48.85);
    expect(coarseCoord(26.30449)).toBe(26.3);
    expect(coarseCoord(48.84561234)).toBe(48.85);
    expect(coarseCoord(-23.5505199)).toBe(-23.55);
  });

  it('sem localização continua sem localização: null, undefined e não-número viram null', () => {
    expect(coarseCoord(null)).toBeNull();
    expect(coarseCoord(undefined)).toBeNull();
    expect(coarseCoord(Number.NaN)).toBeNull();
    expect(coarseCoord(Number.POSITIVE_INFINITY)).toBeNull();
    expect(coarseCoord(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('zero é coordenada válida (Equador e Greenwich), e o que arredonda para zero sai 0 sem sinal', () => {
    expect(coarseCoord(0)).toBe(0);
    expect(Object.is(coarseCoord(-0.001), 0)).toBe(true);
    expect(Object.is(coarseCoord(-0.0049), 0)).toBe(true);
    expect(Object.is(coarseCoord(-0), 0)).toBe(true);
    expect(coarseCoord(0.0049)).toBe(0);
  });

  it('o meio vai para longe do zero, igual nos dois hemisférios', () => {
    expect(coarseCoord(0.005)).toBe(0.01);
    expect(coarseCoord(-0.005)).toBe(-0.01);
    expect(coarseCoord(26.305)).toBe(26.31);
    expect(coarseCoord(-26.305)).toBe(-26.31);
    expect(coarseCoord(-26.3049999)).toBe(-26.3);
  });

  it('ponto flutuante: 1,005 (1,00499… no binário) não cai para 1,00, e o resultado não carrega lixo', () => {
    expect(coarseCoord(1.005)).toBe(1.01);
    expect(coarseCoord(-1.005)).toBe(-1.01);
    expect(coarseCoord(-48.845)).toBe(-48.85);
    expect(coarseCoord(0.1 + 0.2)).toBe(0.3);
    for (const v of [-26.30449, -48.84561234, 12.3456789, -0.12345, 89.999, -179.99999]) {
      const c = coarseCoord(v)!;
      expect(decimals(c), `${v} -> ${c}`).toBeLessThanOrEqual(COARSE_COORD_DECIMALS);
      // Nunca anda mais que meia casa (~550 m) do valor exato.
      expect(Math.abs(c - v), String(v)).toBeLessThanOrEqual(0.005 + 1e-9);
    }
  });

  it('os extremos da faixa ficam onde estão', () => {
    expect(coarseCoord(90)).toBe(90);
    expect(coarseCoord(-90)).toBe(-90);
    expect(coarseCoord(180)).toBe(180);
    expect(coarseCoord(-180)).toBe(-180);
    expect(coarseCoord(-179.999)).toBe(-180);
  });
});
