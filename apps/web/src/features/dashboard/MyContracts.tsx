import type { Contract, ContractStatus } from '@escambo/types';
import { useMemo, useState } from 'react';
import { Button, QueryState, Select } from '../../components/ui';
import { useContractList } from '../../lib/hooks';
import { ContractsCard } from './ContractsCard';

interface ContractFilter {
  value: string;
  label: string;
  status: ContractStatus[];
  empty: string;
}

/** Filtros do painel (RF-040): grupos que a pessoa reconhece, cada um com os status da API. */
export const CONTRACT_FILTERS: ContractFilter[] = [
  {
    value: 'all',
    label: 'Todas',
    status: [],
    empty: 'Nenhuma contratação ainda. Encontre um serviço em Serviços.',
  },
  {
    value: 'proposals',
    label: 'Propostas',
    status: ['pending'],
    empty: 'Nenhuma proposta esperando resposta.',
  },
  {
    value: 'active',
    label: 'Em andamento',
    status: ['accepted', 'in_progress', 'delivered', 'revision_requested'],
    empty: 'Nenhuma contratação em andamento.',
  },
  {
    value: 'disputed',
    label: 'Em disputa',
    status: ['disputed'],
    empty: 'Nenhuma contratação em disputa.',
  },
  {
    value: 'completed',
    label: 'Concluídas',
    status: ['completed'],
    empty: 'Nenhuma contratação concluída.',
  },
  {
    value: 'closed',
    label: 'Canceladas ou recusadas',
    status: ['cancelled', 'rejected'],
    empty: 'Nenhuma contratação cancelada ou recusada.',
  },
];

/**
 * "Minhas contratações" no Início (RF-040): o total vem da API (não só a página carregada), o filtro
 * por status vale no servidor e "Carregar mais" traz as próximas, sem repetir nenhuma.
 */
export function MyContracts() {
  const [filter, setFilter] = useState(CONTRACT_FILTERS[0]!.value);
  const current = CONTRACT_FILTERS.find((f) => f.value === filter) ?? CONTRACT_FILTERS[0]!;
  const list = useContractList(current.status);
  const pages = list.data?.pages;
  // Uma contratação nova entre uma página e outra empurra as seguintes: a repetida não aparece duas vezes.
  const items = useMemo(() => {
    const byId = new Map<number, Contract>();
    for (const p of pages ?? []) for (const c of p.items) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()];
  }, [pages]);
  const total = pages?.at(-1)?.total;
  const filtered = current.status.length > 0;

  return (
    <section className="section" aria-labelledby="my-contracts-title">
      <div className="section-head">
        <div>
          <h2 id="my-contracts-title">Minhas contratações</h2>
          {total !== undefined && (
            <p data-testid="contracts-total">
              {filtered ? `${total} com este status` : `${total} no total`}
            </p>
          )}
        </div>
        <label className="filter inline-filter">
          <span>Status</span>
          <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {CONTRACT_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <QueryState
        isLoading={list.isLoading}
        error={list.error}
        data={list.data}
        isEmpty={() => items.length === 0}
        empty={current.empty}
        onRetry={() => void list.refetch()}
      >
        {() => (
          <>
            <ContractsCard contracts={items} />
            {total !== undefined && total > items.length && (
              <div className="center load-more">
                <p className="muted tiny" data-testid="contracts-shown">
                  Mostrando {items.length} de {total}
                </p>
                {list.hasNextPage && (
                  <Button
                    variant="secondary"
                    onClick={() => void list.fetchNextPage()}
                    disabled={list.isFetchingNextPage}
                  >
                    {list.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}
