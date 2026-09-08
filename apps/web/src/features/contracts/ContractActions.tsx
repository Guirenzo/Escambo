import { Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Contract } from '@escambo/types';
import { Button } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useContractAction, useDeliverContract, useRequestRevision } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { contractActions, type ContractAction, type ContractActionKey } from './actions';

const TONE: Record<ContractAction['tone'], 'primary' | 'secondary' | 'danger'> = {
  primary: 'primary',
  secondary: 'secondary',
  danger: 'danger',
};

/**
 * Botões de ação de uma contratação para o usuário logado (aceitar, entregar, aprovar,
 * pedir revisão, cancelar, avaliar). Mesma lógica na tabela do Início e na Sala.
 */
export function ContractActions({
  contract,
  size = 'normal',
  exclude = [],
}: {
  contract: Contract;
  size?: 'mini' | 'normal';
  exclude?: ContractActionKey[];
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const act = useContractAction();
  const deliver = useDeliverContract();
  const revision = useRequestRevision();
  const busy = act.isPending || deliver.isPending || revision.isPending;

  const actions = contractActions(contract, user?.id ?? -1).filter((a) => !exclude.includes(a.key));
  if (actions.length === 0) return null;

  async function run(a: ContractAction): Promise<void> {
    if (a.key === 'review') {
      navigate(`/contratos/${contract.id}`);
      return;
    }
    let text = '';
    if (a.prompt) {
      text = (window.prompt(a.prompt) ?? '').trim();
      if (!text) return;
    }
    try {
      if (a.key === 'deliver') await deliver.mutateAsync({ id: contract.id, message: text });
      else if (a.key === 'revision') await revision.mutateAsync({ id: contract.id, note: text });
      else await act.mutateAsync({ id: contract.id, action: a.key });
      toast.success(
        a.key === 'approve'
          ? 'Entrega aprovada. Valor liberado para o freelancer.'
          : a.key === 'revision'
            ? 'Revisão solicitada. O freelancer foi avisado.'
            : 'Contratação atualizada',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erro na ação');
    }
  }

  return (
    <>
      {actions.map((a) => (
        <Button
          key={a.key}
          variant={size === 'mini' ? 'mini' : TONE[a.tone]}
          className={size === 'mini' && a.tone === 'danger' ? 'danger' : undefined}
          disabled={busy}
          onClick={() => void run(a)}
        >
          {a.key === 'review' && <Star size={14} />} {a.label}
        </Button>
      ))}
    </>
  );
}
