import { describe, expect, it } from 'vitest';
import { lineSegments, niceMax, scaleY, stackBar, xAt } from './chart';

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

  it('stackBar tira o respiro de dentro da pilha: o pico encosta no teto sem passar', () => {
    // Base 102, altura útil 88 (teto em 14). Pico de 5 com os dois segmentos.
    const peak = stackBar(3, 2, 5, 88, 102);
    expect(peak.down!.y).toBeCloseTo(14);
    expect(peak.up!.y + peak.up!.h).toBeCloseTo(102);
    expect(peak.up!.h + 1 + peak.down!.h).toBeCloseTo(88);
    // Mesmo total, mesma altura, com ou sem os dois segmentos.
    const solo = stackBar(5, 0, 5, 88, 102);
    expect(solo.down).toBeNull();
    expect(solo.up!.y).toBeCloseTo(14);
    expect(stackBar(4, 1, 5, 88, 102).down!.y).toBeCloseTo(14);
    // Segmento pequeno não some; dia vazio não desenha nada.
    expect(stackBar(99, 1, 100, 88, 102).down!.h).toBeGreaterThanOrEqual(1);
    expect(stackBar(0, 0, 5, 88, 102)).toEqual({ up: null, down: null });
  });

  it('lineSegments quebra o traço no null e descarta ponto isolado', () => {
    expect(lineSegments([2, 4], 300, 100, 10)).toEqual(['0,80 300,60']);
    // O primeiro valor fica isolado (null na sequência): só o trecho final vira linha.
    expect(lineSegments([1, null, 2, 3], 300, 100, 10)).toEqual(['200,80 300,70']);
    expect(lineSegments([null, null], 300, 100, 10)).toEqual([]);
    expect(lineSegments([5], 300, 100, 10)).toEqual([]);
  });
});
