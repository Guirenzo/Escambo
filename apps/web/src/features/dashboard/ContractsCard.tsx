import { useState } from 'react';
import type { Contract } from '@escambo/types';
import { api } from '../../lib/api';
import { useContractView } from '../../lib/contract-view';
import { STATUS_LABEL, brl } from '../../lib/format';

type Action = 'accept' | 'reject' | 'approve' | 'cancel' | 'deliver';

function actionsFor(status: string): { label: string; action: Action }[] {
  switch (status) {
    case 'pending':
      return [
        { label: 'Aceitar', action: 'accept' },
        { label: 'Recusar', action: 'reject' },
        { label: 'Cancelar', action: 'cancel' },
      ];
    case 'accepted':
    case 'in_progress':
    case 'revision_requested':
      return [
        { label: 'Registrar entrega', action: 'deliver' },
        { label: 'Cancelar', action: 'cancel' },
      ];
    case 'delivered':
      return [{ label: 'Aprovar', action: 'approve' }];
    default:
      return [];
  }
}

export function ContractsCard({ contracts, onChange }: { contracts: Contract[]; onChange: () => void }) {
  const { open } = useContractView();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(id: number, action: Action) {
    setBusy(id);
    setError(null);
    try {
      if (action === 'deliver') {
        const message = window.prompt('Mensagem da entrega:') ?? '';
        if (!message.trim()) return;
        await api.deliverContract(id, message);
      } else {
        await api.contractAction(id, action);
      }
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro na ação');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card wide">
      <h3>🤝 Minhas contratações</h3>
      {error && <p className="error">{error}</p>}
      {contracts.length === 0 ? (
        <p className="muted">Nenhuma contratação ainda.</p>
      ) : (
        <ul className="list">
          {contracts.map((c) => (
            <li key={c.id}>
              <div className="grow">
                <strong>{c.title}</strong>
                <span className="muted"> · {brl(c.price)}</span>
                <div className="acts">
                  <button className="mini" onClick={() => open(c.id)}>
                    💬 Abrir sala
                  </button>
                  {actionsFor(c.status).map((a) => (
                    <button key={a.action} className="mini" disabled={busy === c.id} onClick={() => run(c.id, a.action)}>
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              <span className={`pill status-${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
