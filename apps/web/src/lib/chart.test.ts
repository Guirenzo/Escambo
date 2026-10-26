import { describe, expect, it } from 'vitest';
import { niceMax } from './chart';

describe('eixo dos gráficos (components/charts.tsx)', () => {
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
});
