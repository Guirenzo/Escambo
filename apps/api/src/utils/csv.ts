/**
 * CSV que abre direto no Excel pt-BR: ponto e vírgula, vírgula decimal, BOM e CRLF. É o molde do
 * ledger financeiro (ADR 32) e da saúde da moderação (ADR 55); vive aqui para os dois falarem a
 * mesma língua com a planilha.
 */

/** Uma célula: aspas só quando o valor tem separador, aspas ou quebra de linha. */
export const csvCell = (v: string | number | null | undefined): string => {
  const s = v == null ? '' : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Número com vírgula decimal e casas fixas, sem separador de milhar; vazio quando não há valor. */
export const ptDecimal = (v: string | number | null | undefined, places: number): string =>
  v == null ? '' : Number(v).toFixed(places).replace('.', ',');

/** O arquivo inteiro: BOM (para o Excel reconhecer UTF-8), cabeçalho, linhas e CRLF no fim. */
export const csvDocument = (
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string =>
  '\uFEFF' +
  [header.map(csvCell).join(';'), ...rows.map((r) => r.map(csvCell).join(';'))].join('\r\n') +
  '\r\n';
