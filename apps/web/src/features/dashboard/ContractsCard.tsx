import { MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Contract } from '@escambo/types';
import { Button, Pill } from '../../components/ui';
import { STATUS_LABEL, brl, dt } from '../../lib/format';
import { ContractActions } from '../contracts/ContractActions';

const MODE_LABEL: Record<string, string> = {
  cash: 'Dinheiro',
  credits: 'Créditos',
  barter: 'Troca',
};

/** Tabela de contratações com ações inline e acesso à sala (timeline + chat). */
export function ContractsCard({ contracts }: { contracts: Contract[] }) {
  const navigate = useNavigate();

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Contratação</th>
            <th>Modalidade</th>
            <th className="right">Valor</th>
            <th>Status</th>
            <th className="right">Ações</th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((c) => (
            <tr key={c.id}>
              <td className="cell-title">
                <strong>{c.title}</strong>
                <span className="muted tiny">criada em {dt(c.createdAt)}</span>
              </td>
              <td>
                {c.paymentMode === 'cash' ? (
                  <span className="muted">{MODE_LABEL.cash}</span>
                ) : (
                  <span className="tag">{MODE_LABEL[c.paymentMode] ?? c.paymentMode}</span>
                )}
              </td>
              <td className="num">
                {c.paymentMode === 'credits' ? `${Math.round(c.price)} cr` : brl(c.price)}
              </td>
              <td>
                <Pill status={c.status}>{STATUS_LABEL[c.status] ?? c.status}</Pill>
              </td>
              <td>
                <div className="acts">
                  <Button variant="mini" onClick={() => navigate(`/contratos/${c.id}`)}>
                    <MessageSquare size={14} /> Sala
                  </Button>
                  <ContractActions contract={c} size="mini" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
