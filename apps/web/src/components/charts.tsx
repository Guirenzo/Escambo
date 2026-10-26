import { useState, type PointerEvent, type ReactNode } from 'react';
import { niceMax } from '../lib/chart';

/*
 * Gráficos do app em HTML e CSS (sem biblioteca): barras finas com ponta arredondada, grade de
 * fio, rótulos em rem (crescem com o texto do navegador) e uma dica ao passar o mouse ou tocar.
 * O desenho todo é uma imagem com resumo em texto (`role="img"`); os números exatos ficam na
 * tabela que cada tela põe ao lado, e a legenda (com os totais) fica fora da imagem.
 *
 * Cores por função (paleta validada, ver docs/acessibilidade.md): verde para a série principal,
 * azul para pessoas, âmbar para o que espera, cinza claro para o que é só contexto.
 */

export type VizTone = 'green' | 'blue' | 'amber' | 'muted';

export interface VizSeries {
  label: string;
  tone: VizTone;
}

export interface ColumnDatum {
  key: string;
  /** Rótulo curto do eixo ("09/2026", "14/09"). */
  axis: string;
  /** Rótulo completo, da dica ("semana de 14/09/2026"). */
  label: string;
  /** Um valor por série, na ordem de `series` (de baixo para cima na pilha). */
  values: number[];
}

/** Topo do eixo: o "redondo" de `niceMax`; com contagens inteiras, par (o meio também é inteiro). */
export function axisMax(max: number, integer: boolean): number {
  const top = niceMax(max);
  return integer && top % 2 === 1 ? top + 1 : top;
}

/**
 * De quantos em quantos o rótulo do eixo aparece, pela quantidade de períodos: na largura toda,
 * numa coluna média e numa estreita (o CSS escolhe pela largura do gráfico, @container).
 */
function axisSteps(n: number): [number, number, number] {
  if (n <= 8) return [1, 1, 2];
  if (n <= 14) return [1, 2, 3];
  if (n <= 31) return [3, 5, 10];
  if (n <= 62) return [7, 10, 15];
  return [10, 15, 30];
}

/** Rótulos do eixo x, alinhados com as colunas; os que não cabem ficam invisíveis. */
export function AxisX({ labels }: { labels: string[] }) {
  const [w, m, s] = axisSteps(labels.length);
  return (
    <div className={labels.length > 14 ? 'viz-x dense' : 'viz-x'}>
      {labels.map((label, i) => (
        <span
          key={i}
          className={[i % w === 0 && 'lw', i % m === 0 && 'lm', i % s === 0 && 'ln']
            .filter(Boolean)
            .join(' ')}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * Colunas por período, simples (uma série) ou empilhadas (as séries somam). A coluna mais alta
 * leva o valor escrito em cima; as outras mostram o valor na dica. Sem série não há legenda: o
 * título do cartão diz o que é.
 */
export function ColumnChart({
  data,
  series,
  summary,
  format,
  tick = format,
  integer = false,
  busy = false,
  className = '',
}: {
  data: ColumnDatum[];
  series: VizSeries[];
  /** O que o leitor de tela ouve no lugar do desenho (período, total, pico). */
  summary: string;
  /** Valor por extenso, na dica e no rótulo do pico ("R$ 1.275,00"). */
  format: (v: number) => string;
  /** Valor curto, no eixo ("R$ 1,5 mil"). */
  tick?: (v: number) => string;
  /** Contagens: o eixo fica em números inteiros. */
  integer?: boolean;
  /** Carregando outro período: o desenho anterior fica, apagado, até o novo chegar. */
  busy?: boolean;
  className?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const peak = Math.max(0, ...totals);
  const top = axisMax(peak, integer);
  const peakAt = peak > 0 ? totals.indexOf(peak) : -1;
  const n = data.length;

  function pick(e: PointerEvent<HTMLDivElement>): void {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const i = Math.floor(((e.clientX - box.left) / box.width) * n);
    setActive(Math.min(n - 1, Math.max(0, i)));
  }

  const tip = active !== null ? data[active] : undefined;
  return (
    <div className={['viz', busy ? 'busy' : '', className].filter(Boolean).join(' ')}>
      <div className="viz-figure" role="img" aria-label={summary}>
        <div className="viz-y">
          <span>{tick(top)}</span>
          <span>{tick(top / 2)}</span>
          <span>{tick(0)}</span>
        </div>
        <div
          className="viz-plot"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setActive(null)}
          onPointerCancel={() => setActive(null)}
        >
          <i className="viz-grid" style={{ bottom: '100%' }} />
          <i className="viz-grid" style={{ bottom: '50%' }} />
          {data.map((d, i) => {
            const total = totals[i]!;
            const height = top > 0 ? (total / top) * 100 : 0;
            return (
              <div key={d.key} className={`viz-col${active === i ? ' on' : ''}`}>
                {total > 0 && (
                  <div className="viz-stack" style={{ height: `${height}%` }}>
                    {/* De cima para baixo: a última série fica no topo da pilha. */}
                    {d.values
                      .map((v, s) => ({ v, s }))
                      .reverse()
                      .filter(({ v }) => v > 0)
                      .map(({ v, s }) => (
                        <span
                          key={s}
                          className={`viz-seg tone-${series[s]?.tone ?? 'green'}`}
                          style={{ flexGrow: v }}
                        />
                      ))}
                  </div>
                )}
                {i === peakAt && (
                  <span
                    className={`viz-peak${i === 0 ? ' at-start' : i === n - 1 ? ' at-end' : ''}`}
                    style={{ bottom: `${height}%` }}
                  >
                    {format(total)}
                  </span>
                )}
              </div>
            );
          })}
          {tip && active !== null && (
            <div
              className={`viz-tip${(active + 0.5) / n > 0.6 ? ' flip' : ''}`}
              style={{ left: `${((active + 0.5) / n) * 100}%` }}
            >
              {series.length === 1 ? (
                <strong>{format(tip.values[0] ?? 0)}</strong>
              ) : (
                <>
                  <strong>{format(totals[active]!)}</strong>
                  {series.map((s, k) => (
                    <span key={s.label} className="viz-tip-row">
                      <i className={`viz-key tone-${s.tone}`} />
                      {format(tip.values[k] ?? 0)} <span>{s.label}</span>
                    </span>
                  ))}
                </>
              )}
              <span className="viz-tip-label">{tip.label}</span>
            </div>
          )}
        </div>
        <AxisX labels={data.map((d) => d.axis)} />
      </div>
      {series.length > 1 && (
        <VizLegend
          items={series.map((s, k) => ({ ...s, value: sumAt(data, k) }))}
          format={format}
        />
      )}
    </div>
  );
}

const sumAt = (data: ColumnDatum[], k: number): number =>
  data.reduce((a, d) => a + (d.values[k] ?? 0), 0);

/** Legenda: a amostra da cor, o nome e o total (a cor nunca é a única pista). */
export function VizLegend({
  items,
  format,
}: {
  items: { label: string; tone: VizTone | 'line' | 'target'; value?: number | ReactNode }[];
  format?: (v: number) => string;
}) {
  return (
    <ul className="viz-legend">
      {items.map((it) => (
        <li key={it.label}>
          <i className={`viz-key tone-${it.tone}`} aria-hidden="true" />
          {it.label}
          {it.value !== undefined && (
            <>
              {' '}
              <strong>
                {typeof it.value === 'number' && format ? format(it.value) : it.value}
              </strong>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Linha por período com uma meta: a linha de 2 px liga os valores conhecidos (período sem valor
 * quebra o traço), cada ponto tem um marcador com anel da cor do fundo, e a meta é a linha
 * tracejada âmbar com o rótulo escrito. Ao passar o mouse, um fio vertical acha o período mais
 * perto e a dica mostra o valor e a meta.
 */
export function LineChart({
  points,
  labels,
  axis,
  target,
  summary,
  format,
  tick = format,
  busy = false,
}: {
  points: (number | null)[];
  /** Rótulo completo de cada ponto, da dica. */
  labels: string[];
  /** Rótulo curto de cada ponto, do eixo. */
  axis: string[];
  target?: { value: number; label: string };
  summary: string;
  format: (v: number) => string;
  tick?: (v: number) => string;
  busy?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;
  const known = points.filter((v): v is number => v !== null);
  const top = niceMax(Math.max(target?.value ?? 0, ...known, 1));
  const x = (i: number): number => ((i + 0.5) / n) * 100;
  const y = (v: number): number => (v / top) * 100;
  // Trechos contínuos de valores conhecidos (o SVG estica: o traço não, com non-scaling-stroke).
  const runs: string[] = [];
  let run: string[] = [];
  points.forEach((v, i) => {
    if (v === null) {
      if (run.length > 1) runs.push(run.join(' '));
      run = [];
      return;
    }
    run.push(`${x(i)},${100 - y(v)}`);
  });
  if (run.length > 1) runs.push(run.join(' '));

  function pick(e: PointerEvent<HTMLDivElement>): void {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    setActive(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * n))));
  }
  const value = active !== null ? points[active] : undefined;

  return (
    <div className={['viz', busy ? 'busy' : ''].filter(Boolean).join(' ')}>
      <div className="viz-figure" role="img" aria-label={summary}>
        <div className="viz-y">
          <span>{tick(top)}</span>
          <span>{tick(top / 2)}</span>
          <span>{tick(0)}</span>
        </div>
        <div
          className="viz-plot"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setActive(null)}
          onPointerCancel={() => setActive(null)}
        >
          <i className="viz-grid" style={{ bottom: '100%' }} />
          <i className="viz-grid" style={{ bottom: '50%' }} />
          {target && (
            <div className="viz-target" style={{ bottom: `${Math.min(100, y(target.value))}%` }}>
              <span>{target.label}</span>
            </div>
          )}
          {active !== null && <i className="viz-cross" style={{ left: `${x(active)}%` }} />}
          <svg className="viz-line" viewBox="0 0 100 100" preserveAspectRatio="none">
            {runs.map((p) => (
              <polyline key={p} points={p} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          {points.map((v, i) =>
            v === null ? null : (
              <i
                key={i}
                className={`viz-dot${active === i ? ' on' : ''}`}
                style={{ left: `${x(i)}%`, bottom: `${y(v)}%` }}
              />
            ),
          )}
          {active !== null && (
            <div
              className={`viz-tip${(active + 0.5) / n > 0.6 ? ' flip' : ''}`}
              style={{ left: `${x(active)}%` }}
            >
              <strong>{value === null || value === undefined ? 'sem dado' : format(value)}</strong>
              {target && (
                <span className="viz-tip-row">
                  <i className="viz-key tone-target" />
                  {target.label}
                </span>
              )}
              <span className="viz-tip-label">{labels[active]}</span>
            </div>
          )}
        </div>
        <AxisX labels={axis} />
      </div>
    </div>
  );
}
