import type { Contract } from '@escambo/types';

const brl = (v: number): string => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendente',
  accepted: 'Aceito',
  rejected: 'Recusado',
  in_progress: 'Em andamento',
  delivered: 'Entregue',
  revision_requested: 'Revisão',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  disputed: 'Disputa',
};

export function ContractsCard({ contracts }: { contracts: Contract[] }) {
  return (
    <section className="card wide">
      <h3>🤝 Minhas contratações</h3>
      {contracts.length === 0 ? (
        <p className="muted">Nenhuma contratação ainda.</p>
      ) : (
        <ul className="list">
          {contracts.map((c) => (
            <li key={c.id}>
              <div>
                <strong>{c.title}</strong>
                <span className="muted"> · {brl(c.price)}</span>
              </div>
              <span className={`pill status-${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
