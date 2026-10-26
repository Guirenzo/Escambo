import { fireEvent } from '@testing-library/react';

/**
 * Passa o ponteiro sobre a coluna `i` de `n` de um gráfico (components/charts.tsx): o jsdom não faz
 * layout, então a área do gráfico ganha 10 px por coluna e o evento cai no meio da coluna.
 */
export function hoverColumn(figure: HTMLElement, i: number, n: number): void {
  const plot = figure.querySelector<HTMLElement>('.viz-plot')!;
  plot.getBoundingClientRect = () => ({ left: 0, width: n * 10 }) as DOMRect;
  fireEvent.pointerMove(plot, { clientX: i * 10 + 5 });
}
