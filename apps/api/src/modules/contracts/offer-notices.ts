import { brl, proposalExpiredNotices, type DeadlineNotice } from './deadline-notices';
import { roundOf } from './offers';

export { proposalNotice } from './deadline-notices';

interface BaseFacts {
  contractId: number;
  title: string;
}
interface TermsFacts extends BaseFacts {
  seq: number;
  mode: 'cash' | 'credits';
  price: number;
  net: number;
  /** Dia/prazo já formatado no fuso de quem lê. */
  deadline: string | null;
}
export interface CounterOfferNoticeFacts extends TermsFacts {
  heldPrice: number;
  respondBy: string;
  milestoneCount?: number;
  message: string;
}
export type OfferAcceptedNoticeFacts = TermsFacts;
export interface OfferRejectedNoticeFacts extends BaseFacts {
  seq: number;
  mode: 'cash' | 'credits';
  heldPrice: number;
}
export interface OfferExpiredNoticeFacts extends BaseFacts {
  seq: number;
  cash: boolean;
  untilClient: string;
  untilFreelancer: string;
}
interface OfferHistoryTermsFacts {
  seq: number;
  /** Autor da oferta, e não a pessoa que a aceita. */
  by: 'client' | 'freelancer';
  mode: 'cash' | 'credits';
  price: number;
  /** Prazo já formatado pelo service, com o fuso explícito quando necessário. */
  deadline: string | null;
}
export interface CounterOfferHistoryFacts extends OfferHistoryTermsFacts {
  milestones?: { title: string; amount: number; due: string | null }[];
  message: string;
}
export type OfferAcceptedHistoryFacts = OfferHistoryTermsFacts;

const value = (price: number, mode: 'cash' | 'credits'): string =>
  mode === 'cash' ? brl(price) : `${price} créditos`;
const deadline = (at: string | null): string => (at ? `, entrega ${at}` : '');
const notice = (
  f: BaseFacts,
  type: string,
  title: string,
  body: string | null,
): DeadlineNotice => ({
  params: { type, title, body, data: { contractId: f.contractId } },
});

/** RN-022: a linha do tempo conserva os termos que foram propostos naquela rodada. */
export function counterOfferHistoryNote(f: CounterOfferHistoryFacts): string {
  const author = f.by === 'client' ? 'cliente' : 'freelancer';
  const milestones = f.milestones?.length
    ? `; marcos: ${f.milestones
        .map((m) => `«${m.title}» ${value(m.amount, f.mode)}${m.due ? ` até ${m.due}` : ''}`)
        .join('; ')}`
    : '';
  return `Contraproposta do ${author} (rodada ${roundOf(f.seq)} de 3): ${value(f.price, f.mode)}${deadline(f.deadline)}${milestones}. Mensagem: ${f.message}`;
}

/** A oferta 1 mantém a nota vazia; as seguintes registram os termos aceitos (ADR 61 D.3). */
export function offerAcceptedHistoryNote(f: OfferAcceptedHistoryFacts): string | null {
  if (f.seq === 1) return null;
  const action = f.by === 'freelancer' ? 'do freelancer aceita pelo cliente' : 'do cliente aceita';
  return `Contraproposta ${f.seq} ${action}: ${value(f.price, f.mode)}${deadline(f.deadline)}`;
}

/** RN-030: quem recebe depende da paridade; o service envia ao destinatário da vez. */
export function counterOfferNotice(f: CounterOfferNoticeFacts): DeadlineNotice {
  const cash = f.mode === 'cash';
  const amount = value(f.price, f.mode);
  if (f.seq % 2 === 0) {
    const milestones = f.milestoneCount
      ? ` (${f.milestoneCount} ${f.milestoneCount === 1 ? 'marco' : 'marcos'})`
      : '';
    return notice(
      f,
      'contract_counter_offer',
      `Contraproposta: ${f.title}`,
      `Responda até ${f.respondBy}: o freelancer propõe ${amount}${deadline(f.deadline)}${milestones}. A sua proposta era ${value(f.heldPrice, f.mode)}. Sem resposta, a negociação se encerra${cash ? ' e a reserva volta para você' : ''}. Mensagem: ${f.message}`,
    );
  }
  const action =
    f.seq === 5
      ? 'É a última rodada: aceite ou recuse.'
      : 'Aceite, recuse ou faça uma contraproposta.';
  return notice(
    f,
    'contract_counter_offer',
    `Contraproposta do cliente: ${f.title}`,
    `Responda até ${f.respondBy}: ${amount}${cash ? ` (você recebe ${brl(f.net)})` : ''}${deadline(f.deadline)}. ${action} Mensagem: ${f.message}`,
  );
}

/** O aceite da primeira proposta mantém o aviso anterior, sem inventar novos termos no corpo. */
export function offerAcceptedNotice(f: OfferAcceptedNoticeFacts): DeadlineNotice {
  if (f.seq === 1) return notice(f, 'contract_accepted', 'Sua proposta foi aceita', null);
  const amount = `${value(f.price, f.mode)}${deadline(f.deadline)}.`;
  if (f.seq % 2 === 0) {
    return notice(
      f,
      'contract_accepted',
      `Sua contraproposta foi aceita: ${f.title}`,
      `${amount} ${f.mode === 'cash' ? `O valor está em garantia: ${brl(f.net)} para você na aprovação da entrega.` : 'Os créditos ficam em garantia e são liberados na aprovação da entrega.'}`,
    );
  }
  return notice(
    f,
    'contract_accepted',
    `Sua contraproposta foi aceita: ${f.title}`,
    `${amount} ${f.mode === 'cash' ? 'O valor reservado passou a ser a garantia da contratação.' : 'Os créditos ficam em garantia até a aprovação da entrega.'}`,
  );
}

/** A reserva devolvida é sempre a última proposta do cliente, inclusive nas ofertas pares. */
export function offerRejectedNotice(f: OfferRejectedNoticeFacts): DeadlineNotice {
  const refund = f.mode === 'cash' ? `${brl(f.heldPrice)} voltou para a sua carteira.` : '';
  if (f.seq === 1)
    return notice(
      f,
      'contract_rejected',
      'Sua proposta foi recusada',
      `${f.title}.${refund ? ` ${refund}` : ''}`,
    );
  const title =
    f.seq % 2 === 1
      ? `Sua contraproposta foi recusada: ${f.title}`
      : `O freelancer encerrou a negociação: ${f.title}`;
  return notice(
    f,
    'contract_rejected',
    title,
    `${refund ? `${refund} ` : ''}Se quiser, envie uma nova proposta.`,
  );
}

export function negotiationCancelledNotice(f: BaseFacts): DeadlineNotice {
  return notice(
    f,
    'contract_cancelled',
    `Negociação encerrada pelo cliente: ${f.title}`,
    'O cliente encerrou a negociação antes do aceite.',
  );
}

/** As duas partes recebem a mesma decisão, com a hora no próprio fuso. */
export function offerExpiredNotices(f: OfferExpiredNoticeFacts): {
  client: DeadlineNotice;
  freelancer: DeadlineNotice;
} {
  if (f.seq === 1) return proposalExpiredNotices(f);
  const clientTurn = f.seq % 2 === 0;
  return {
    client: notice(
      f,
      'contract_expired',
      clientTurn
        ? 'A contraproposta expirou sem resposta'
        : 'Sua contraproposta expirou sem resposta',
      `${f.title}: ${clientTurn ? 'você' : 'o freelancer'} não respondeu até ${f.untilClient}.${f.cash ? ' O valor reservado voltou para a sua carteira.' : ''} Se quiser, envie uma nova proposta.`,
    ),
    freelancer: notice(
      f,
      'contract_expired',
      clientTurn ? 'Sua contraproposta expirou' : 'Uma contraproposta expirou',
      `${f.title}: ${clientTurn ? 'sem resposta do cliente' : 'sem a sua resposta'} até ${f.untilFreelancer}, a negociação foi encerrada.`,
    ),
  };
}
