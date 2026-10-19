import type { ContractOffer, ContractWithHistory, OfferOutcome, PaymentMode } from '@escambo/types';
import { useAuth } from '../../lib/auth';
import { deadlineText, deadlineZoneNote, momentText, untilLabel } from '../../lib/deadline';
import { negotiationPartyLabel, offerAuthor, offerValue, reserveDelta } from './negotiation';
import { partyOf } from './actions';
import { useContractNow } from './useContractNow';

const OUTCOME: Record<OfferOutcome, string> = {
  open: 'Aguardando resposta',
  countered: 'Contraposta',
  accepted: 'Aceita',
  declined: 'Recusada',
  withdrawn: 'Retirada',
  expired: 'Expirada',
  closed: 'Encerrada',
};

export function NegotiationDueNotice({
  contract: c,
  myId,
  zone,
}: {
  contract: ContractWithHistory;
  myId: number;
  zone: string | null | undefined;
}) {
  const now = useContractNow(c);
  const n = c.negotiation;
  const party = partyOf(c, myId);
  if (
    !n ||
    c.status !== 'pending' ||
    c.paymentMode === 'barter' ||
    party === 'none' ||
    !n.respondBy
  )
    return null;
  const left = Date.parse(n.respondBy) - now;
  const when = momentText(n.respondBy, zone);
  const current = n.current;
  const deliveryLeft = current?.deadlineAt ? Date.parse(current.deadlineAt) - now : null;
  let text: string;
  if (left <= 0)
    text =
      'O prazo de resposta terminou. Aguarde a atualização da proposta ou confira a Sala novamente.';
  else if (party === n.turn) {
    text =
      party === 'client'
        ? `Responda até ${when}: aceite a contraproposta, ${n.canCounter && n.seq < 5 ? 'contraponha ou ' : ''}encerre a negociação.${n.seq === 4 ? ' Esta é a sua última chance de contrapropor.' : ''}`
        : `Responda até ${when}: aceite, recuse${n.canCounter && n.seq < 5 ? ` ou contraponha (${n.countersLeft} de 2 contrapropostas disponíveis)` : ''}.${n.seq === 5 ? ' Esta é a oferta final; sem acordo, será necessária uma nova proposta.' : ''}`;
    if (party === 'freelancer' && deliveryLeft !== null && deliveryLeft > 0)
      text += ` Se aceitar agora, você terá ${untilLabel(deliveryLeft)} até o prazo.`;
  } else if (party === 'client') {
    text = `O freelancer tem até ${when} para responder.${c.paymentMode === 'cash' ? ` Sua oferta mantém ${offerValue('cash', c.price)} reservado; sem resposta, a proposta se encerra e a reserva volta para sua carteira.` : ' Sem resposta, a proposta se encerra.'}`;
  } else {
    text = `O cliente tem até ${when} para responder à sua contraproposta${current ? ` de ${offerValue(c.paymentMode, current.price)}` : ''}. Sem resposta, a proposta se encerra.`;
  }
  return (
    <p
      className={`notice${party === n.turn && left < 24 * 3_600_000 ? ' danger' : ''}`}
      data-testid="proposal-due"
    >
      {text}
    </p>
  );
}

export function OfferTerms({ offer, mode }: { offer: ContractOffer; mode: PaymentMode }) {
  const { user } = useAuth();
  return (
    <>
      <p>
        <strong>{offerValue(mode, offer.price)}</strong> ·{' '}
        {offer.deadlineAt
          ? `${deadlineText(offer.deadlineAt, offer.deadlineZone)}${deadlineZoneNote(offer.deadlineAt, offer.deadlineZone, user?.timezone)}`
          : 'sem prazo definido'}
      </p>
      {offer.milestones && (
        <ol className="timeline">
          {offer.milestones.map((m) => (
            <li key={m.id}>
              <span className="dot" aria-hidden="true" />
              <div>
                <strong>{m.title}</strong> · {offerValue(mode, m.amount)}
                {m.dueAt && (
                  <div className="muted tiny">
                    {deadlineText(m.dueAt, offer.deadlineZone)}
                    {deadlineZoneNote(m.dueAt, offer.deadlineZone, user?.timezone)}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export function ReserveNotice({ reserved, price }: { reserved: number; price: number }) {
  const delta = reserveDelta(reserved, price);
  return (
    <p data-testid="reserve-preview">
      Reserva atual: {offerValue('cash', reserved)}. Reserva com esta oferta:{' '}
      {offerValue('cash', price)}.{' '}
      {delta > 0
        ? `Se confirmado, mais ${offerValue('cash', delta)} será reservado da sua carteira.`
        : delta < 0
          ? `Se confirmado, ${offerValue('cash', -delta)} volta para o seu saldo disponível.`
          : 'A reserva permanece com o mesmo valor.'}
    </p>
  );
}

/** Ofertas continuam no histórico mesmo depois que a negociação encerra. */
export function NegotiationSection({
  contract,
  myId,
}: {
  contract: ContractWithHistory;
  myId: number;
}) {
  const { user } = useAuth();
  const n = contract.paymentMode === 'barter' ? null : contract.negotiation;
  const offers = contract.paymentMode === 'barter' ? [] : (contract.offers ?? []);
  if (!n && !offers.length) return null;
  const current = n?.current;
  const previous = current
    ? [...offers].filter((o) => o.seq < current.seq).sort((a, b) => b.seq - a.seq)[0]
    : undefined;
  const party = partyOf(contract, myId);
  return (
    <section className="card stack" data-testid="negotiation">
      {n && (
        <>
          <div className="card-head">
            <h3>Negociação · rodada {n.round} de 3</h3>
            <span className="pill">
              {party === n.turn ? 'sua vez' : `vez do ${negotiationPartyLabel(n.turn)}`}
            </span>
          </div>
          {current && (
            <div>
              <strong>{offerAuthor(current)}</strong>
              <div className="muted tiny">{momentText(current.createdAt, user?.timezone)}</div>
              <OfferTerms offer={current} mode={contract.paymentMode} />
              {previous && (
                <p className="muted tiny">
                  Oferta anterior: {offerValue(contract.paymentMode, previous.price)} ·{' '}
                  {previous.deadlineAt
                    ? `${deadlineText(previous.deadlineAt, previous.deadlineZone)}${deadlineZoneNote(previous.deadlineAt, previous.deadlineZone, user?.timezone)}`
                    : 'sem prazo definido'}
                </p>
              )}
              {party === 'freelancer' && (
                <p>
                  Líquido para você:{' '}
                  <strong>{offerValue(contract.paymentMode, current.freelancerNet)}</strong>
                  {contract.paymentMode === 'cash' &&
                    ` · taxa ${offerValue('cash', current.platformFee)}${n.feePercentage === undefined ? '' : ` (${n.feePercentage}%)`}`}
                  .
                </p>
              )}
              {current.message && <blockquote>{current.message}</blockquote>}
              {party === 'client' && n.turn === 'client' && contract.paymentMode === 'cash' && (
                <ReserveNotice reserved={contract.price} price={current.price} />
              )}
            </div>
          )}
        </>
      )}
      {offers.length > 0 && (
        <details>
          <summary>Como a proposta foi negociada ({offers.length} ofertas)</summary>
          <ol className="timeline">
            {[...offers]
              .sort((a, b) => a.seq - b.seq)
              .map((offer) => (
                <li key={offer.seq}>
                  <span className="dot" aria-hidden="true" />
                  <div>
                    <strong>{offerAuthor(offer)}</strong>{' '}
                    <span className="pill">{OUTCOME[offer.outcome]}</span>
                    <div className="muted tiny">
                      Oferta {offer.seq} · {momentText(offer.createdAt, user?.timezone)}
                    </div>
                    <OfferTerms offer={offer} mode={contract.paymentMode} />
                    {offer.message && <blockquote>{offer.message}</blockquote>}
                  </div>
                </li>
              ))}
          </ol>
        </details>
      )}
    </section>
  );
}
