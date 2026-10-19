import type { ContractWithHistory } from '@escambo/types';
import { useAuth } from '../../lib/auth';
import { momentText } from '../../lib/deadline';
import { DISPUTABLE_STATUSES, partyOf } from './actions';
import { disputeWaiting, revisionCount, revisionsExhausted } from './contractRules';
import { offerValue } from './negotiation';
import { useContractNow } from './useContractNow';

export function DisputeWindowNotice({
  contract: c,
  myId,
}: {
  contract: ContractWithHistory;
  myId: number;
}) {
  const { user } = useAuth();
  const now = useContractNow(c);
  const party = partyOf(c, myId);
  if (party === 'none' || !DISPUTABLE_STATUSES.includes(c.status) || !disputeWaiting(c, now))
    return null;
  const when = momentText(c.disputeOpensAt!, user?.timezone);
  const delivered =
    c.status === 'delivered' ||
    c.status === 'revision_requested' ||
    Boolean(c.deadline?.firstDeliveredAt) ||
    c.milestones.some((m) => m.deliveredAt);
  const refund =
    party === 'client' && c.cancellation?.allowed && c.cancellation.unit !== 'none'
      ? ` Cancelar agora devolve ${offerValue(c.paymentMode, c.cancellation.refundClient)}.`
      : '';
  return (
    <p className="notice" data-testid="dispute-opens-at">
      {delivered
        ? `Tentem resolver pelo chat primeiro: a disputa abre a partir de ${when}.`
        : `A disputa abre a partir de ${when}, 48 horas depois do aceite. Até lá, conversem pelo chat.${refund}`}
    </p>
  );
}

export function RevisionSummary({
  contract: c,
  myId,
}: {
  contract: ContractWithHistory;
  myId: number;
}) {
  const { user } = useAuth();
  const now = useContractNow(c);
  const party = partyOf(c, myId);
  const state = c.revisions;
  if (!state || c.hasMilestones || party === 'none') return null;
  const exhausted = c.status === 'delivered' && revisionsExhausted(state);
  const count = state.limit === null ? revisionCount(state) : `${revisionCount(state)} usadas`;
  return (
    <p className={exhausted ? 'notice' : 'muted tiny'} data-testid="revisions-summary">
      Revisões sem custo: {count}.
      {exhausted &&
        (party === 'client'
          ? ` As ${state.limit} revisões sem custo foram usadas: aprove ou combine pelo chat; o freelancer pode liberar mais uma.${disputeWaiting(c, now) ? ` A disputa abre a partir de ${momentText(c.disputeOpensAt!, user?.timezone)}.` : ' Você também pode abrir uma disputa pela Sala.'}`
          : ` As ${state.limit} revisões sem custo foram usadas. Se combinarem pelo chat, libere mais uma: o cliente pede sem custo. A aprovação automática só para quando ele pedir a revisão.`)}
    </p>
  );
}
