import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { hoverColumn } from '../test/charts';
import { axisMax, ColumnChart, LineChart, VizLegend, type ColumnDatum } from './charts';

const brl = (v: number): string => `R$ ${v}`;
const day = (d: number, values: number[]): ColumnDatum => ({
  key: `2026-10-${String(d).padStart(2, '0')}`,
  axis: `${String(d).padStart(2, '0')}/10`,
  label: `dia ${d}`,
  values,
});

describe('axisMax', () => {
  it('arredonda o topo para cima e, com contagens, deixa o meio inteiro', () => {
    expect(axisMax(850, false)).toBe(1000);
    expect(axisMax(3, false)).toBe(3);
    expect(axisMax(3, true)).toBe(4);
    expect(axisMax(0, true)).toBe(2);
  });
});

describe('ColumnChart', () => {
  const data = [day(1, [0]), day(2, [5]), day(3, [20])];

  it('é uma imagem com resumo; colunas proporcionais ao topo do eixo e o pico escrito', () => {
    render(
      <ColumnChart
        data={data}
        series={[{ label: 'Ganhos', tone: 'green' }]}
        summary="Ganhos por dia: total R$ 25."
        format={brl}
      />,
    );
    const chart = screen.getByRole('img', { name: 'Ganhos por dia: total R$ 25.' });
    expect(
      [...chart.querySelectorAll<HTMLElement>('.viz-stack')].map((b) => b.style.height),
    ).toEqual(['25%', '100%']);
    expect(chart.querySelectorAll('.viz-seg.tone-green')).toHaveLength(2);
    expect(chart.querySelector('.viz-peak')).toHaveTextContent('R$ 20');
    expect(chart.querySelector('.viz-peak')).toHaveClass('at-end');
    expect([...chart.querySelectorAll('.viz-y span')].map((s) => s.textContent)).toEqual([
      'R$ 20',
      'R$ 10',
      'R$ 0',
    ]);
    // Uma série só: o título diz o que é, sem caixa de legenda.
    expect(document.querySelector('.viz-legend')).toBeNull();
  });

  it('a dica mostra o valor e o período da coluna sob o ponteiro, e some ao sair', () => {
    render(
      <ColumnChart
        data={data}
        series={[{ label: 'Ganhos', tone: 'green' }]}
        summary="Ganhos"
        format={brl}
      />,
    );
    const chart = screen.getByRole('img', { name: 'Ganhos' });
    hoverColumn(chart, 1, 3);
    const tip = chart.querySelector('.viz-tip')!;
    expect(tip).toHaveTextContent('R$ 5dia 2');
    expect(tip).not.toHaveClass('flip');
    expect(chart.querySelectorAll('.viz-col')[1]).toHaveClass('on');
    // Perto da borda direita, a dica abre para a esquerda.
    hoverColumn(chart, 2, 3);
    expect(chart.querySelector('.viz-tip')).toHaveClass('flip');
    fireEvent.pointerLeave(chart.querySelector('.viz-plot')!);
    expect(chart.querySelector('.viz-tip')).toBeNull();
  });

  it('empilhado: a última série no topo, a dica com o total e cada série, e a legenda com os totais', () => {
    render(
      <ColumnChart
        data={[day(1, [2, 1]), day(2, [0, 3]), day(3, [0, 0])]}
        series={[
          { label: 'Com ação', tone: 'green' },
          { label: 'Dispensadas', tone: 'muted' },
        ]}
        summary="Decisões"
        format={String}
        integer
      />,
    );
    const chart = screen.getByRole('img', { name: 'Decisões' });
    const first = chart.querySelectorAll('.viz-stack')[0]!;
    expect([...first.children].map((c) => c.className)).toEqual([
      'viz-seg tone-muted',
      'viz-seg tone-green',
    ]);
    // Segmento zerado não entra na pilha; período sem nada não tem coluna.
    expect(chart.querySelectorAll('.viz-stack')[1]!.children).toHaveLength(1);
    expect(chart.querySelectorAll('.viz-stack')).toHaveLength(2);
    expect([...chart.querySelectorAll('.viz-y span')].map((s) => s.textContent)).toEqual([
      '4',
      '2',
      '0',
    ]);
    hoverColumn(chart, 0, 3);
    expect(chart.querySelector('.viz-tip')).toHaveTextContent('32 Com ação1 Dispensadasdia 1');
    const legend = document.querySelector('.viz-legend')!;
    expect(within(legend as HTMLElement).getByText(/^Com ação/)).toHaveTextContent('Com ação 2');
    expect(within(legend as HTMLElement).getByText(/^Dispensadas/)).toHaveTextContent(
      'Dispensadas 4',
    );
  });

  it('sem nenhum valor: eixo de 0 a 2 nas contagens, sem coluna nem pico', () => {
    render(
      <ColumnChart
        data={[day(1, [0]), day(2, [0])]}
        series={[{ label: 'Ativos', tone: 'blue' }]}
        summary="Ninguém"
        format={String}
        integer
        busy
      />,
    );
    const chart = screen.getByRole('img', { name: 'Ninguém' });
    expect(chart.querySelector('.viz-stack')).toBeNull();
    expect(chart.querySelector('.viz-peak')).toBeNull();
    expect(chart.querySelector('.viz-y span')).toHaveTextContent('2');
    // Carregando outro período: o desenho fica, apagado.
    expect(chart.parentElement).toHaveClass('viz', 'busy');
  });

  it('os rótulos do eixo rareiam pela quantidade de colunas', () => {
    const many = Array.from({ length: 30 }, (_, i) => day(i + 1, [i]));
    render(
      <ColumnChart
        data={many}
        series={[{ label: 'G', tone: 'green' }]}
        summary="Mês"
        format={String}
      />,
    );
    const axis = screen.getByRole('img', { name: 'Mês' }).querySelector('.viz-x')!;
    expect(axis).toHaveClass('dense');
    const shown = (cls: string) => [...axis.querySelectorAll(`.${cls}`)].map((s) => s.textContent);
    expect(shown('lw')).toHaveLength(10);
    expect(shown('lm')).toEqual(['01/10', '06/10', '11/10', '16/10', '21/10', '26/10']);
    expect(shown('ln')).toEqual(['01/10', '11/10', '21/10']);
    // O pico na primeira coluna encosta na borda esquerda.
    render(
      <ColumnChart
        data={[day(1, [9]), day(2, [1])]}
        series={[{ label: 'G', tone: 'green' }]}
        summary="Início"
        format={String}
      />,
    );
    expect(screen.getByRole('img', { name: 'Início' }).querySelector('.viz-peak')).toHaveClass(
      'at-start',
    );
  });
});

describe('LineChart', () => {
  const props = {
    points: [6, 30, null, 12],
    labels: ['21/09', '22/09', '23/09', '24/09'],
    axis: ['21/09', '22/09', '23/09', '24/09'],
    target: { value: 24, label: 'meta 24 h' },
    summary: 'Tempo até decidir',
    format: (v: number) => `${v} h`,
  };

  it('linha com quebra no dia sem valor, marcadores, meta escrita e o eixo até o topo redondo', () => {
    render(<LineChart {...props} />);
    const chart = screen.getByRole('img', { name: 'Tempo até decidir' });
    // Trecho contínuo só dos dois primeiros dias; o último, isolado, fica só no marcador.
    const lines = chart.querySelectorAll('polyline');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.getAttribute('points')).toBe('12.5,80 37.5,0');
    expect(chart.querySelectorAll('.viz-dot')).toHaveLength(3);
    expect(within(chart).getByText('meta 24 h')).toBeInTheDocument();
    expect((chart.querySelector('.viz-target') as HTMLElement).style.bottom).toBe('80%');
    expect(chart.querySelector('.viz-y span')).toHaveTextContent('30 h');
  });

  it('o fio vertical acha o dia e a dica mostra a mediana, a meta e o dia; sem valor, diz isso', () => {
    render(<LineChart {...props} />);
    const chart = screen.getByRole('img', { name: 'Tempo até decidir' });
    hoverColumn(chart, 1, 4);
    expect(chart.querySelector('.viz-cross')).toBeInTheDocument();
    expect(chart.querySelector('.viz-tip')).toHaveTextContent('30 hmeta 24 h22/09');
    hoverColumn(chart, 2, 4);
    expect(chart.querySelector('.viz-tip')).toHaveTextContent('sem dado');
    expect(chart.querySelector('.viz-tip')).toHaveClass('flip');
    fireEvent.pointerCancel(chart.querySelector('.viz-plot')!);
    expect(chart.querySelector('.viz-tip')).toBeNull();
  });

  it('sem meta e sem valor: eixo mínimo de 1, sem linha', () => {
    render(<LineChart {...props} points={[null, null]} target={undefined} busy />);
    const chart = screen.getByRole('img', { name: 'Tempo até decidir' });
    expect(chart.querySelectorAll('polyline')).toHaveLength(0);
    expect(chart.querySelector('.viz-target')).toBeNull();
    expect(chart.querySelector('.viz-y span')).toHaveTextContent('1 h');
  });
});

describe('VizLegend', () => {
  it('amostra, nome e valor (formatado quando é número)', () => {
    render(
      <VizLegend
        items={[
          { label: 'Receita', tone: 'green', value: 10 },
          { label: 'Meta', tone: 'target', value: '24 h' },
          { label: 'Linha', tone: 'line' },
        ]}
        format={(v) => `R$ ${v}`}
      />,
    );
    expect(screen.getByText(/^Receita/)).toHaveTextContent('Receita R$ 10');
    expect(screen.getByText(/^Meta/)).toHaveTextContent('Meta 24 h');
    expect(screen.getByText('Linha')).toBeInTheDocument();
  });
});
