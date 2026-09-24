import type { ModerationHealthDay } from '@escambo/types';
import { csvDocument, ptDecimal } from '../../utils/csv';
import type { HistorySeries } from './moderation.health';

/**
 * Saúde da moderação em CSV (ADR 55): a série por dia do painel, num arquivo que abre direto no
 * Excel pt-BR (ponto e vírgula, vírgula decimal, BOM), no mesmo molde do ledger financeiro. As
 * colunas têm nome em português e vêm na ordem em que o painel lê: o que a fila decidiu no dia,
 * o que o detector sinalizou, quanto demorou e se passou da meta.
 */

/** Horas com uma casa e vírgula decimal; vazio quando não há valor. */
const ptHours = (v: number | null): string => ptDecimal(v, 1);

/**
 * Rótulo do arquivo pelas pontas da série (dias de Brasília, os mesmos das linhas): o dia UTC de
 * geração diria "amanhã" às 22h daqui. A série nunca é vazia (listDays devolve ao menos hoje).
 */
export const moderationCsvFileName = (history: readonly ModerationHealthDay[]): string => {
  const first = history[0]?.day ?? 'sem-dia';
  const last = history[history.length - 1]?.day ?? first;
  return `escambo-moderacao-${first}_${last}.csv`;
};

/** "sim"/"nao" para a mediana do dia contra a meta; vazio num dia sem decisão. */
const overSla = (medianHours: number | null, slaHours: number): string =>
  medianHours == null ? '' : medianHours > slaHours ? 'sim' : 'nao';

export function moderationHistoryCsv(series: HistorySeries): string {
  const header = [
    'dia',
    'denuncias_recebidas',
    'sinalizacoes_automaticas',
    'decididas_com_acao',
    'dispensadas',
    'decididas_total',
    'mediana_horas',
    'meta_horas',
    'acima_da_meta',
  ];
  const lines = series.history.map((d) => [
    d.day,
    d.received,
    d.flagged,
    d.actioned,
    d.dismissed,
    d.actioned + d.dismissed,
    ptHours(d.medianHours),
    series.slaHours,
    overSla(d.medianHours, series.slaHours),
  ]);
  return csvDocument(header, lines);
}
