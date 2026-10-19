import { BusinessForm, BusinessModal } from '../../components/BusinessActions';
import { useState, type FormEvent } from 'react';
import type { ContractWithHistory } from '@escambo/types';
import { Button, Field, Input } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { addDaysToDay, momentText, todayIn } from '../../lib/deadline';
import { useCounterOffer, useWallet } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { timezoneLabel } from '../../lib/timezones';
import { DepositModal } from '../wallet/DepositModal';
import { ReserveNotice } from './NegotiationSection';
import {
  offerDraft,
  offerValue,
  prepareCounter,
  reserveDelta,
  splitOfferAmounts,
} from './negotiation';
import { partyOf } from './actions';
import { useContractNow } from './useContractNow';

export function CounterOfferModal({
  contract,
  onClose,
}: {
  contract: ContractWithHistory;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const send = useCounterOffer();
  const wallet = useWallet();
  const now = useContractNow(contract);
  const [offer] = useState(() => contract.negotiation?.current);
  const [draft, setDraft] = useState(() => (offer ? offerDraft(offer) : null));
  const [depositing, setDepositing] = useState(false);
  if (!offer || !draft || contract.paymentMode === 'barter') return null;
  const n = contract.negotiation;
  const party = partyOf(contract, user?.id ?? -1);
  const client = party === 'client';
  const credits = contract.paymentMode === 'credits';
  const editorZone = n?.deadlineZone ?? offer.deadlineZone;
  const minDay = addDaysToDay(todayIn(editorZone), 1);
  const prepared = prepareCounter(offer, contract.paymentMode, draft, minDay, editorZone);
  const price = Number(draft.price);
  const previewPrice = Number.isFinite(price) && price >= 10 ? price : offer.price;
  const delta = reserveDelta(contract.price, previewPrice);
  const missing =
    client && !credits
      ? Math.max(0, reserveDelta(wallet.data?.balance ?? 0, Math.max(0, delta)))
      : 0;
  const creditShortage =
    client && credits && wallet.data !== undefined && wallet.data.credits < previewPrice;
  const active =
    contract.status === 'pending' &&
    n?.seq === offer.seq &&
    n.turn === party &&
    n.canCounter &&
    n.seq < 5 &&
    (!n.respondBy || Date.parse(n.respondBy) > now);
  const pct = n?.feePercentage ?? Math.round((offer.platformFee * 100) / offer.price);
  const estimatedNet = (Math.round(previewPrice * 100) - Math.round(previewPrice * pct)) / 100;
  const busy = send.isPending;

  const changeMilestone = (index: number, patch: Partial<(typeof draft.milestones)[number]>) =>
    setDraft({
      ...draft,
      milestones: draft.milestones.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    });

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!prepared.body || !active || busy || (client && !credits && (!wallet.data || missing > 0)))
      return;
    try {
      const result = await send.mutateAsync({ id: contract.id, ...prepared.body });
      const respondBy = result.negotiation?.respondBy;
      toast.success(
        `Contraproposta enviada.${respondBy ? ` Resposta até ${momentText(respondBy, user?.timezone)}.` : ''}`,
      );
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível enviar a contraproposta',
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
    <BusinessModal
      title={`Contraproposta · rodada ${Math.ceil((offer.seq + 1) / 2)} de 3`}
      onClose={onClose}
    >
      <BusinessForm className="stack" onSubmit={(e) => void submit(e)}>
        {!active && (
          <p role="alert">
            A oferta mudou ou o prazo de resposta terminou. Feche e confira a negociação atual.
          </p>
        )}
        <Field label={credits ? 'Valor em créditos' : 'Valor (R$)'}>
          <Input
            type="number"
            min={10}
            max={99_999_999.99}
            step={credits ? 1 : '0.01'}
            value={draft.price}
            required
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
          />
        </Field>
        {offer.deadlineAt && (
          <Field label="Prazo de entrega">
            <Input
              type="date"
              min={minDay}
              value={draft.deadline}
              required
              onChange={(e) => setDraft({ ...draft, deadline: e.target.value })}
            />
          </Field>
        )}
        <p className="muted tiny">
          {offer.deadlineAt
            ? `Os novos prazos valem até 23:59 no horário de ${timezoneLabel(editorZone)}, de quem entrega.${editorZone !== offer.deadlineZone ? ` Os dias preenchidos vêm da oferta anterior, no horário de ${timezoneLabel(offer.deadlineZone)}.` : ''}`
            : 'A proposta continua sem prazo definido.'}{' '}
          A forma de pagamento e os marcos são preservados.
        </p>
        {draft.milestones.length > 0 && (
          <div className="ms-editor">
            {draft.milestones.map((m, i) => (
              <div className="ms-row" key={m.id}>
                <strong>
                  {i + 1}. {m.title}
                </strong>
                <Input
                  type="number"
                  min={credits ? 1 : 0.01}
                  step={credits ? 1 : '0.01'}
                  value={m.amount}
                  aria-label={`Valor do marco ${i + 1}`}
                  required
                  onChange={(e) => changeMilestone(i, { amount: e.target.value })}
                />
                <Input
                  type="date"
                  min={minDay}
                  max={draft.deadline || undefined}
                  value={m.due}
                  aria-label={`Prazo do marco ${i + 1}`}
                  onChange={(e) => changeMilestone(i, { due: e.target.value })}
                />
              </div>
            ))}
            <Button
              type="button"
              variant="mini"
              onClick={() => {
                const values = splitOfferAmounts(draft.price, draft.milestones.length, credits);
                if (values)
                  setDraft({
                    ...draft,
                    milestones: draft.milestones.map((m, i) => ({ ...m, amount: values[i]! })),
                  });
              }}
            >
              Dividir igualmente
            </Button>
          </div>
        )}
        <Field
          label={`O que muda e por quê (o ${client ? 'freelancer' : 'cliente'} lê antes de decidir)`}
        >
          <textarea
            value={draft.message}
            minLength={5}
            maxLength={500}
            required
            rows={3}
            onChange={(e) => setDraft({ ...draft, message: e.target.value })}
          />
        </Field>
        {!client && (
          <p>
            Líquido estimado para você:{' '}
            <strong>
              {offerValue(contract.paymentMode, credits ? previewPrice : estimatedNet)}
            </strong>
            {!credits && ` · taxa ${pct}% da proposta original`}. O valor confirmado aparece na
            oferta enviada.
          </p>
        )}
        {client && !credits && (
          <>
            <ReserveNotice reserved={contract.price} price={previewPrice} />
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
              <p>Saldo disponível: {offerValue('cash', wallet.data?.balance ?? 0)}.</p>
            )}
            {wallet.data && missing > 0 && (
              <div role="status">
                Faltam {offerValue('cash', missing)} para ajustar a reserva.{' '}
                <Button type="button" variant="secondary" onClick={() => setDepositing(true)}>
                  Depositar
                </Button>
              </div>
            )}
          </>
        )}
        {client && credits && (
          <p>
            Não há reserva durante a negociação. Os {previewPrice} créditos serão debitados só na
            contratação.
            {creditShortage
              ? ' Você ainda precisa obter créditos antes de aceitar uma oferta.'
              : ''}
          </p>
        )}
        {offer.seq === 4 && (
          <p className="muted tiny">
            Esta é a última contraproposta. O freelancer poderá aceitar ou recusar.
          </p>
        )}
        {offer.seq === 3 && (
          <p className="muted tiny">O cliente ainda poderá enviar uma última contraproposta.</p>
        )}
        {prepared.error && (
          <p className="muted tiny" role="status">
            {prepared.error}
          </p>
        )}
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            type="submit"
            disabled={
              busy ||
              !active ||
              !prepared.body ||
              (client && !credits && (!wallet.data || missing > 0))
            }
          >
            {busy ? 'Enviando…' : 'Enviar contraproposta'}
          </Button>
        </div>
      </BusinessForm>
    </BusinessModal>
  );
}
