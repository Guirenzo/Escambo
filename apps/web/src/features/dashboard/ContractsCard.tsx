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

/**
 * Tabela de contratações com acesso à sala (timeline + chat) e só as ações que avançam o
 * contrato (aceitar, entregar, aprovar, avaliar). Recusar, cancelar, pedir revisão e abrir
 * disputa ficam na Sala, onde há linha do tempo, chat e o pedido de justificativa. A modalidade
 * vai na linha de apoio do título: com quatro colunas a tabela cabe na coluna do Início sem rolar.
 */
export function ContractsCard({ contracts }: { contracts: Contract[] }) {
  const navigate = useNavigate();

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Contratação</th>
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
                <span className="muted tiny">
                  criada em {dt(c.createdAt)} · {MODE_LABEL[c.paymentMode] ?? c.paymentMode}
                </span>
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
                  <ContractActions
                    contract={c}
                    size="mini"
                    exclude={['reject', 'cancel', 'revision', 'dispute']}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
