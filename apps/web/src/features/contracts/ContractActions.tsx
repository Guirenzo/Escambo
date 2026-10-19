import { BusinessButton } from '../../components/BusinessActions';
import { Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Contract } from '@escambo/types';
import { useAuth } from '../../lib/auth';
import {
  useContractAction,
  useDeliverContract,
  useGrantContractRevision,
  useRequestRevision,
} from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { contractActions, type ContractAction, type ContractActionKey } from './actions';
import { useContractNow } from './useContractNow';
import { GRANT_REVISION_CONFIRMATION } from './contractRules';

const TONE: Record<ContractAction['tone'], 'primary' | 'secondary' | 'danger'> = {
  primary: 'primary',
  secondary: 'secondary',
  danger: 'danger',
};

/**
 * Botões de ação de uma contratação para o usuário logado (aceitar, entregar, aprovar,
 * pedir revisão, cancelar ou desistir, avaliar, abrir disputa). Mesma lógica na tabela do Início
 * e na Sala. Avaliar, abrir disputa e cancelar acontecem na Sala (o cancelamento mostra o valor
 * antes de confirmar, ADR 57): fora dela, os botões levam para lá.
 */
export function ContractActions({
  contract,
  size = 'normal',
  exclude = [],
  onDispute,
  onCancel,
  onCounter,
  onAcceptCounter,
}: {
  contract: Contract;
  size?: 'mini' | 'normal';
  exclude?: ContractActionKey[];
  onDispute?: () => void;
  onCancel?: () => void;
  onCounter?: () => void;
  onAcceptCounter?: () => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const act = useContractAction();
  const deliver = useDeliverContract();
  const revision = useRequestRevision();
  const grant = useGrantContractRevision();
  const busy = act.isPending || deliver.isPending || revision.isPending || grant.isPending;
  const now = useContractNow(contract);

  const actions = contractActions(contract, user?.id ?? -1, now).filter(
    (a) => !exclude.includes(a.key),
  );
  if (actions.length === 0) return null;

  async function run(a: ContractAction): Promise<void> {
    if (a.key === 'grant_revision' && !window.confirm(GRANT_REVISION_CONFIRMATION)) return;
    if (a.key === 'counter' || a.key === 'accept_counter') {
      const open = a.key === 'counter' ? onCounter : onAcceptCounter;
      if (open) open();
      else navigate(`/contratos/${contract.id}`);
      return;
    }
    if (a.key === 'review') {
      navigate(`/contratos/${contract.id}`);
      return;
    }
    if (a.key === 'dispute') {
      if (onDispute) onDispute();
      else navigate(`/contratos/${contract.id}`);
      return;
    }
    if (a.key === 'cancel') {
      if (onCancel) onCancel();
      else navigate(`/contratos/${contract.id}`);
      return;
    }
    if (
      a.key === 'reject' &&
      contract.negotiation &&
      contract.negotiation.seq > 1 &&
      !window.confirm(
        `Sair da negociação? A proposta se encerra${contract.paymentMode === 'credits' ? '.' : ' e a reserva volta ao cliente.'}`,
      )
    )
      return;
    let text = '';
    if (a.prompt) {
      text = (window.prompt(a.prompt) ?? '').trim();
      if (!text) return;
    }
    try {
      if (a.key === 'deliver') await deliver.mutateAsync({ id: contract.id, message: text });
      else if (a.key === 'revision') await revision.mutateAsync({ id: contract.id, note: text });
      else if (a.key === 'grant_revision') await grant.mutateAsync({ id: contract.id });
      else if (a.key === 'accept' || a.key === 'reject' || a.key === 'approve')
        await act.mutateAsync({
          id: contract.id,
          action: a.key,
          ...(contract.status === 'pending' && contract.negotiation
            ? { seq: contract.negotiation.seq }
            : {}),
        });
      toast.success(
        a.key === 'approve'
          ? 'Entrega aprovada. Valor liberado para o freelancer.'
          : a.key === 'grant_revision'
            ? 'Mais uma revisão sem custo liberada. O prazo de aprovação automática continua o mesmo.'
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
        <BusinessButton
          key={a.key}
          variant={size === 'mini' ? 'mini' : TONE[a.tone]}
          className={size === 'mini' && a.tone === 'danger' ? 'danger' : undefined}
          disabled={busy}
          onClick={() => void run(a)}
        >
          {a.key === 'review' && <Star size={14} />} {a.label}
        </BusinessButton>
      ))}
    </>
  );
}
