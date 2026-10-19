import type {
  BrazilTimezone,
  ContractOffer,
  CounterOfferRequest,
  NegotiationTurn,
  PaymentMode,
} from '@escambo/types';
import { dayIn, endOfDayIn } from '../../lib/deadline';
import { brl } from '../../lib/format';

export interface OfferDraft {
  price: string;
  deadline: string;
  milestones: { id: number; title: string; amount: string; due: string }[];
  message: string;
}

export const offerValue = (mode: PaymentMode, amount: number): string =>
  mode === 'credits' ? `${amount} créditos` : brl(amount);

export const negotiationPartyLabel = (party: NegotiationTurn): string =>
  party === 'client' ? 'cliente' : 'freelancer';

export const offerAuthor = (offer: ContractOffer): string =>
  offer.seq === 1
    ? 'Proposta do cliente'
    : `Contraproposta do ${negotiationPartyLabel(offer.madeBy)}`;

export const offerDraft = (offer: ContractOffer): OfferDraft => ({
  price: String(offer.price),
  deadline: offer.deadlineAt ? dayIn(offer.deadlineZone, offer.deadlineAt) : '',
  milestones: (offer.milestones ?? []).map((m) => ({
    id: m.id,
    title: m.title,
    amount: String(m.amount),
    due: m.dueAt ? dayIn(offer.deadlineZone, m.dueAt) : '',
  })),
  message: '',
});

/** Valida unidades inteiras, sem arredondar uma terceira casa de dinheiro silenciosamente. */
function units(input: string, credits: boolean): number | null {
  if (!(credits ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/).test(input)) return null;
  const value = Number(input);
  if (!Number.isFinite(value) || value > 99_999_999.99) return null;
  return Math.round(value * (credits ? 1 : 100));
}

const validDay = (day: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
};

/** Preserva a forma da oferta e os ids; só os valores e os prazos podem mudar. */
export function prepareCounter(
  current: ContractOffer,
  mode: PaymentMode,
  draft: OfferDraft,
  minimumDay: string,
  editorZone: BrazilTimezone = current.deadlineZone,
): { body: CounterOfferRequest | null; error: string | null } {
  const fail = (error: string) => ({ body: null, error });
  const credits = mode === 'credits';
  const factor = credits ? 1 : 100;
  const total = units(draft.price, credits);
  if (total === null || total < 10 * factor)
    return fail(
      credits
        ? 'Use pelo menos 10 créditos inteiros.'
        : 'Use pelo menos R$ 10,00, com até duas casas decimais.',
    );
  if (Boolean(current.deadlineAt) !== Boolean(draft.deadline))
    return fail('Preserve a existência do prazo da proposta.');
  if (draft.deadline && (!validDay(draft.deadline) || draft.deadline < minimumDay))
    return fail('O prazo de entrega deve ser a partir de amanhã, no fuso de quem entrega.');
  const originals = current.milestones ?? [];
  if (
    draft.milestones.length !== originals.length ||
    draft.milestones.some((m, i) => m.id !== originals[i]?.id || m.title !== originals[i]?.title)
  )
    return fail('Preserve os mesmos marcos, na mesma ordem.');
  const amounts = draft.milestones.map((m) => units(m.amount, credits));
  if (amounts.some((amount) => amount === null || amount <= 0))
    return fail('Cada marco deve ter um valor positivo na unidade do pagamento.');
  if (originals.length && amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) !== total)
    return fail('A soma dos marcos deve ser igual ao valor da proposta.');
  let previous = '';
  for (const m of draft.milestones) {
    if (!m.due) continue;
    if (
      !validDay(m.due) ||
      m.due < minimumDay ||
      (draft.deadline && m.due > draft.deadline) ||
      m.due < previous
    )
      return fail(
        'Os prazos dos marcos devem estar em ordem, a partir de amanhã e até o prazo da entrega.',
      );
    previous = m.due;
  }
  const body: CounterOfferRequest = {
    seq: current.seq,
    price: total / factor,
    deadlineAt: draft.deadline ? endOfDayIn(editorZone, draft.deadline) : null,
    ...(originals.length
      ? {
          milestones: draft.milestones.map((m, i) => ({
            id: m.id,
            amount: amounts[i]! / factor,
            dueAt: m.due ? endOfDayIn(editorZone, m.due) : null,
          })),
        }
      : {}),
    message: draft.message.trim(),
  };
  // Abrir uma oferta de outro fuso conserva os DIAS que as partes viram. A mudança do fuso
  // de quem entrega não cria, sozinha, uma contraproposta; datas novas usam o fuso atual.
  const originalDraft = offerDraft(current);
  if (
    body.price === current.price &&
    draft.deadline === originalDraft.deadline &&
    draft.milestones.every(
      (m, i) =>
        Number(m.amount) === originals[i]!.amount && m.due === originalDraft.milestones[i]!.due,
    )
  )
    return fail(
      'Mude o valor, o prazo ou os valores/prazos dos marcos. Só a mensagem não cria uma contraproposta.',
    );
  if (body.message.length < 5 || body.message.length > 500)
    return fail('Explique a mudança em 5 a 500 caracteres.');
  return { body, error: null };
}

export function splitOfferAmounts(price: string, count: number, credits: boolean): string[] | null {
  const total = units(price, credits);
  if (total === null || count < 1 || total < count) return null;
  const each = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) =>
    String((i === count - 1 ? total - each * (count - 1) : each) / (credits ? 1 : 100)),
  );
}

/** A reserva existe só em dinheiro; créditos saem apenas quando a contratação é aceita. */
export function reserveDelta(reserved: number, proposed: number): number {
  return (Math.round(proposed * 100) - Math.round(reserved * 100)) / 100;
}
