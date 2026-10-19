import { BusinessModal } from '../../components/BusinessActions';
import { useState } from 'react';
import type { ContractWithHistory } from '@escambo/types';
import { Button } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useAcceptCounterOffer, useWallet } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { DepositModal } from '../wallet/DepositModal';
import { OfferTerms, ReserveNotice } from './NegotiationSection';
import { offerValue, reserveDelta } from './negotiation';
import { useContractNow } from './useContractNow';

export function AcceptCounterModal({
  contract,
  onClose,
}: {
  contract: ContractWithHistory;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const accept = useAcceptCounterOffer();
  const wallet = useWallet();
  const now = useContractNow(contract);
  const [offer] = useState(() => contract.negotiation?.current);
  const [depositing, setDepositing] = useState(false);
  if (!offer || contract.paymentMode === 'barter') return null;
  const credits = contract.paymentMode === 'credits';
  const delta = reserveDelta(contract.price, offer.price);
  const missing = credits
    ? Math.max(0, offer.price - (wallet.data?.credits ?? 0))
    : Math.max(0, reserveDelta(wallet.data?.balance ?? 0, Math.max(0, delta)));
  const n = contract.negotiation;
  const active =
    user?.id === contract.clientId &&
    contract.status === 'pending' &&
    n?.seq === offer.seq &&
    n.turn === 'client' &&
    offer.seq % 2 === 0 &&
    (!n.respondBy || Date.parse(n.respondBy) > now) &&
    (!offer.deadlineAt || Date.parse(offer.deadlineAt) > now);
  async function confirm(): Promise<void> {
    if (!active || !wallet.data || missing > 0 || accept.isPending || !offer) return;
    try {
      await accept.mutateAsync({ id: contract.id, seq: offer.seq });
      toast.success('Contraproposta aceita. A contratação começou e o valor fica em garantia.');
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível aceitar a contraproposta',
      );
    }
  }
  if (depositing)
    return (
      <DepositModal
        suggestedAmount={missing}
        onClose={() => setDepositing(false)}
        onPaid={() => setDepositing(false)}
      />
    );
  return (
    <BusinessModal title="Aceitar contraproposta" onClose={onClose}>
      <div className="stack">
        <OfferTerms offer={offer} mode={contract.paymentMode} />
        {offer.message && <blockquote>{offer.message}</blockquote>}
        {credits ? (
          <p>
            {offer.price} créditos serão debitados da sua carteira e ficarão em garantia até a
            aprovação da entrega.
          </p>
        ) : (
          <>
            <ReserveNotice reserved={contract.price} price={offer.price} />
            <p>Ao contratar, o valor fica em garantia até a aprovação da entrega.</p>
          </>
        )}
        {!active && (
          <p role="alert">
            A oferta mudou ou o prazo terminou. Feche e confira a negociação atual.
          </p>
        )}
        {wallet.isPending ? (
          <p className="muted">Consultando sua carteira…</p>
        ) : wallet.error ? (
          <p role="alert">
            Não foi possível consultar a carteira.{' '}
            <Button type="button" variant="mini" onClick={() => void wallet.refetch()}>
              Tentar de novo
            </Button>
          </p>
        ) : (
          missing > 0 && (
            <p role="status">
              Faltam {offerValue(contract.paymentMode, missing)} para contratar.{' '}
              {!credits && (
                <Button type="button" variant="secondary" onClick={() => setDepositing(true)}>
                  Depositar
                </Button>
              )}
            </p>
          )
        )}
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            disabled={!active || accept.isPending || !wallet.data || missing > 0}
            onClick={() => void confirm()}
          >
            {accept.isPending ? 'Aceitando…' : 'Aceitar e contratar'}
          </Button>
        </div>
      </div>
    </BusinessModal>
  );
}
