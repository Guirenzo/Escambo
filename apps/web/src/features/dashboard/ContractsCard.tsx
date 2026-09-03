import { MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Contract } from '@escambo/types';
import { Button, Pill } from '../../components/ui';
import { STATUS_LABEL, brl, dt } from '../../lib/format';
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

const MODE_LABEL: Record<string, string> = { cash: 'Dinheiro', credits: 'Créditos', barter: 'Troca' };

/** Tabela de contratações com ações inline e acesso à sala (timeline + chat). */
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
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Contratação</th>
            <th>Modalidade</th>
            <th className="right">Valor</th>
            <th>Status</th>
            <th>Criada</th>
            <th className="right">Ações</th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((c) => (
            <tr key={c.id}>
              <td>
                <strong>{c.title}</strong>
              </td>
              <td>
                {c.paymentMode === 'cash' ? (
                  <span className="muted">{MODE_LABEL.cash}</span>
                ) : (
                  <span className="tag">{MODE_LABEL[c.paymentMode] ?? c.paymentMode}</span>
                )}
              </td>
              <td className="num">{c.paymentMode === 'credits' ? `${Math.round(c.price)} cr` : brl(c.price)}</td>
              <td>
                <Pill status={c.status}>{STATUS_LABEL[c.status] ?? c.status}</Pill>
              </td>
              <td className="muted">{dt(c.createdAt)}</td>
              <td>
                <div className="acts">
                  <Button variant="mini" onClick={() => navigate(`/contratos/${c.id}`)}>
                    <MessageSquare size={14} /> Sala
                  </Button>
                  {actionsFor(c.status).map((a) => (
                    <Button key={a.action} variant="mini" disabled={busy} onClick={() => void run(c.id, a.action)}>
                      {a.label}
                    </Button>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
