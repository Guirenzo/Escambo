import type { ContractWithHistory } from '@escambo/types';
import { Button, Modal } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { brl } from '../../lib/format';
import { useCancelContract } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { cancelCopy } from './cancelCopy';

/**
 * Cancelar (cliente) ou desistir (freelancer), RN-025 e RN-026 (ADR 57): o modal mostra o que
 * acontece com o dinheiro, calculado pela API com a mesma conta da liquidação, e manda o valor
 * visto; se ele mudou no meio (o prazo venceu, um marco foi entregue), a API recusa e a Sala
 * recarrega com o valor novo. O botão secundário é sempre Voltar.
 */
export function CancelModal({
  contract,
  onClose,
}: {
  contract: ContractWithHistory;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const cancel = useCancelContract();
  const terms = contract.cancellation;
  if (!terms) return null;
  const copy = cancelCopy(terms, user?.timezone);
  const showSplit =
    terms.allowed && terms.unit === 'BRL' && terms.stage !== 'proposal' && terms.stage !== 'barter';
  const client = terms.by === 'client';

  async function confirm(): Promise<void> {
    if (!terms) return;
    try {
      const r = await cancel.mutateAsync({ id: contract.id, expectedRefund: terms.refundClient });
      toast.success(
        r.by === 'freelancer'
          ? r.unit === 'none'
            ? 'Você desistiu. A troca segue o próprio fluxo.'
            : 'Você desistiu. O valor em garantia voltou para o cliente.'
          : `${r.stage === 'proposal' ? 'Proposta cancelada.' : 'Contratação cancelada.'}${
              r.refundClient > 0
                ? ` ${r.unit === 'credits' ? `${Math.round(r.refundClient)} créditos` : brl(r.refundClient)} voltou para a sua carteira.`
                : ''
            }`,
      );
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível cancelar');
    }
  }

  return (
    <Modal title={copy.title} onClose={onClose}>
      <div className="stack" data-testid="cancel-modal">
        <p data-testid="cancel-body">{copy.body}</p>
        {showSplit && (
          <dl className="cancel-quote" data-testid="cancel-quote">
            <dt>{client ? 'Você recebe de volta' : 'Volta para o cliente'}</dt>
            <dd>{brl(terms.refundClient)}</dd>
            <dt>{client ? 'O freelancer fica com' : 'Você fica com'}</dt>
            <dd>{brl(terms.releaseFreelancer)}</dd>
          </dl>
        )}
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          {copy.confirm && (
            <Button
              type="button"
              variant="danger"
              disabled={cancel.isPending}
              onClick={() => void confirm()}
            >
              {cancel.isPending ? 'Cancelando…' : copy.confirm}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
