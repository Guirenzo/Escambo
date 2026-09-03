import { useNavigate } from 'react-router-dom';
import type { Contract } from '@escambo/types';
import { Button, Pill } from '../../components/ui';
import { STATUS_LABEL, brl } from '../../lib/format';
import { useContractAction, useDeliverContract } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

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

export function ContractsCard({ contracts }: { contracts: Contract[] }) {
  const navigate = useNavigate();
  const toast = useToast();
  const act = useContractAction();
  const deliver = useDeliverContract();
  const busy = act.isPending || deliver.isPending;

  async function run(id: number, action: Action): Promise<void> {
    try {
      if (action === 'deliver') {
        const message = window.prompt('Mensagem da entrega:') ?? '';
        if (!message.trim()) return;
        await deliver.mutateAsync({ id, message });
      } else {
        await act.mutateAsync({ id, action });
      }
      toast.success('Contratação atualizada');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erro na ação');
    }
  }

  return (
    <ul className="list">
      {contracts.map((c) => (
        <li key={c.id}>
          <div className="grow">
            <strong>{c.title}</strong>
            <span className="muted"> · {brl(c.price)}</span>
            {c.paymentMode === 'credits' && <span className="tag"> créditos</span>}
            <div className="acts">
              <Button variant="mini" onClick={() => navigate(`/contratos/${c.id}`)}>
                💬 Abrir sala
              </Button>
              {actionsFor(c.status).map((a) => (
                <Button key={a.action} variant="mini" disabled={busy} onClick={() => void run(c.id, a.action)}>
                  {a.label}
                </Button>
              ))}
            </div>
          </div>
          <Pill status={c.status}>{STATUS_LABEL[c.status] ?? c.status}</Pill>
        </li>
      ))}
    </ul>
  );
}
