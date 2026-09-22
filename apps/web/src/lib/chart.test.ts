import { describe, expect, it } from 'vitest';
import { lineSegments, niceMax, scaleY, xAt } from './chart';

describe('gráficos da série histórica (ADR 50)', () => {
  it('niceMax cobre o valor com um topo redondo e nunca desce de 1', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(3)).toBe(3);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(17)).toBe(20);
    expect(niceMax(24)).toBe(30);
    expect(niceMax(96)).toBe(100);
    expect(niceMax(0.4)).toBe(1);
  });

  it('scaleY é proporcional e não divide por zero; xAt espaça por igual', () => {
    expect(scaleY(5, 10, 88)).toBe(44);
    expect(scaleY(0, 10, 88)).toBe(0);
    expect(scaleY(3, 0, 88)).toBe(0);
    expect(xAt(0, 4, 300)).toBe(0);
    expect(xAt(3, 4, 300)).toBe(300);
    expect(xAt(1, 4, 300)).toBe(100);
    expect(xAt(0, 1, 300)).toBe(150);
  });

  it('lineSegments quebra o traço no null e descarta ponto isolado', () => {
    expect(lineSegments([2, 4], 300, 100, 10)).toEqual(['0,80 300,60']);
    // O primeiro valor fica isolado (null na sequência): só o trecho final vira linha.
    expect(lineSegments([1, null, 2, 3], 300, 100, 10)).toEqual(['200,80 300,70']);
    expect(lineSegments([null, null], 300, 100, 10)).toEqual([]);
    expect(lineSegments([5], 300, 100, 10)).toEqual([]);
  });
});
