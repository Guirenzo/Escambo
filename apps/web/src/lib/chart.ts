/** Contas puras dos gráficos da série histórica do painel (ADR 50). */

/** Topo "redondo" do eixo: o menor 1, 2, 3, 4, 5, 6, 8 ou 10 × 10^k que cobre o valor. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const exp = Math.floor(Math.log10(value));
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const candidate = m * 10 ** exp;
    if (candidate >= value) return candidate;
  }
  return 10 ** (exp + 1);
}

/** Altura proporcional ao valor dentro de `height`; máximo zero (ou negativo) rende zero. */
export const scaleY = (value: number, max: number, height: number): number =>
  max <= 0 ? 0 : (value / max) * height;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface StackBar {
  up: { y: number; h: number } | null;
  down: { y: number; h: number } | null;
}

/**
 * Barra empilhada de dois segmentos sobre a linha de base `base`, com `gap` de respiro entre
 * eles tirado de dentro da pilha: a altura total é sempre proporcional à soma, então dias com o
 * mesmo total têm a mesma altura e o dia de pico encosta no teto sem passar dele. Segmento que
 * existe fica com pelo menos 1 de altura, para não sumir.
 */
export function stackBar(
  up: number,
  down: number,
  max: number,
  plot: number,
  base: number,
  gap = 1,
): StackBar {
  const total = scaleY(up + down, max, plot);
  const both = up > 0 && down > 0;
  const room = Math.max(total - (both ? gap : 0), 0);
  const upH = up > 0 ? Math.max(room * (up / (up + down)), 1) : 0;
  const downH = down > 0 ? Math.max(room - upH, 1) : 0;
  return {
    up: up > 0 ? { y: base - upH, h: upH } : null,
    down: down > 0 ? { y: base - upH - (both ? gap : 0) - downH, h: downH } : null,
  };
}

/** O x do ponto `i` numa série de `count` pontos espaçados por igual em `width`. */
export const xAt = (i: number, count: number, width: number): number =>
  count > 1 ? round1(i * (width / (count - 1))) : round1(width / 2);

/**
 * Trechos contíguos de valores conhecidos viram polilinhas ("x,y x,y …"); null quebra o traço
 * (dia sem valor) e ponto isolado fica de fora, porque o círculo do dia já o mostra.
 */
export function lineSegments(
  values: readonly (number | null)[],
  width: number,
  height: number,
  max: number,
): string[] {
  const runs: string[][] = [];
  let current: string[] | null = null;
  values.forEach((value, i) => {
    if (value === null) {
      current = null;
      return;
    }
    if (!current) {
      current = [];
      runs.push(current);
    }
    current.push(`${xAt(i, values.length, width)},${round1(height - scaleY(value, max, height))}`);
  });
  return runs.filter((run) => run.length >= 2).map((run) => run.join(' '));
}
