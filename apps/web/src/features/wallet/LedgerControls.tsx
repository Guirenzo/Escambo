import { Button } from '../../components/ui';
import { timezoneLabel } from '../../lib/timezones';

/**
 * Peças dos extratos da Carteira (RF-047), as mesmas para R$ e para créditos: o período em dias
 * no fuso da conta, as páginas juntas e o "Carregar mais".
 */

/** Período do extrato: dias "AAAA-MM-DD"; vazio = sem limite daquele lado. */
export interface LedgerPeriod {
  from: string;
  to: string;
}

export const NO_PERIOD: LedgerPeriod = { from: '', to: '' };

/** As duas datas preenchidas e a inicial depois da final: a tela avisa e nada vai à API. */
export const isInvertedPeriod = ({ from, to }: LedgerPeriod): boolean =>
  from !== '' && to !== '' && from > to;

/** As páginas juntas; um lançamento novo no meio da paginação não aparece duas vezes. */
export function uniqueItems<T extends { id: number }>(pages: { items: T[] }[] | undefined): T[] {
  const seen = new Set<number>();
  return (pages ?? [])
    .flatMap((p) => p.items)
    .filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
}

/** "De", "Até" e "Limpar período", com o fuso em que os dias são lidos. */
export function PeriodFilter({
  value,
  onChange,
  timezone,
}: {
  value: LedgerPeriod;
  onChange: (next: LedgerPeriod) => void;
  timezone: string | null | undefined;
}) {
  const { from, to } = value;
  return (
    <>
      <div className="filters-bar" role="group" aria-label="Período do extrato">
        <label className="filter">
          De
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => onChange({ from: e.target.value, to })}
          />
        </label>
        <label className="filter">
          Até
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => onChange({ from, to: e.target.value })}
          />
        </label>
        {(from || to) && (
          <Button type="button" variant="ghost" onClick={() => onChange(NO_PERIOD)}>
            Limpar período
          </Button>
        )}
      </div>
      <p className="muted tiny">Dias no horário de {timezoneLabel(timezone)}.</p>
    </>
  );
}

/** "Carregar mais" de um extrato paginado: some na última página e trava enquanto busca. */
export function LoadMore({
  query,
}: {
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => Promise<unknown>;
  };
}) {
  if (!query.hasNextPage) return null;
  return (
    <div className="center">
      <Button
        type="button"
        variant="secondary"
        onClick={() => void query.fetchNextPage()}
        disabled={query.isFetchingNextPage}
      >
        {query.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
      </Button>
    </div>
  );
}
