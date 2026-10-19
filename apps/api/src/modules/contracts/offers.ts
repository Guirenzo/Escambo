import type {
  BrazilTimezone,
  CounterOfferRequest,
  NegotiationTurn,
  OfferMilestone,
} from '@escambo/types';
import { floorSecond, humanize, lastHumanAtOrBefore } from '../../utils/human-hours';
import { BRAZIL_TIMEZONES } from '../../utils/timezone';
import type { WalletEffect } from '../wallet/wallet.ledger';
import { money } from './cancel-policy';

export const MAX_OFFERS = 5;
const MAX_AMOUNT = 99_999_999.99;
const H = 3_600_000;

export type { CounterOfferRequest, NegotiationTurn } from '@escambo/types';

/** A conta pura aceita marcos sem título; o mapper completa o OfferMilestone público. */
export type OfferMilestoneInput = NonNullable<CounterOfferRequest['milestones']>[number] &
  Partial<Pick<OfferMilestone, 'title'>>;
export type OfferMilestoneTerms = Omit<OfferMilestone, 'title'> &
  Partial<Pick<OfferMilestone, 'title'>>;
export interface OfferTerms {
  price: number;
  fee: number;
  net: number;
  milestones: OfferMilestoneTerms[] | null;
}
export interface OfferLike {
  price: number;
  deadlineAt: Date | string | null;
  milestones?:
    | readonly {
        id: number;
        amount: number;
        dueAt: Date | string | null;
      }[]
    | null;
}
/** Subconjunto do efeito de carteira emitido pelo ajuste da reserva. */
export type OfferWalletEffect = WalletEffect & {
  reason: 'hold' | 'hold_release';
};

function assertSeq(seq: number): void {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_OFFERS) {
    throw new RangeError('O número da oferta deve ser um inteiro de 1 a 5');
  }
}

function cents(value: number, label: string, minimum = 0): number {
  const n = Math.round(value * 100);
  // A tolerância cobre a representação binária de valores grandes com dois decimais,
  // sem aceitar uma terceira casa nem arredondar silenciosamente a entrada financeira.
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    value > MAX_AMOUNT ||
    !Number.isSafeInteger(n) ||
    Math.abs(value * 100 - n) > 1e-5
  ) {
    throw new RangeError(`${label}: valor inválido ou com fração de centavo`);
  }
  return n;
}

function decimal(value: string | number, label: string): number {
  if (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new RangeError(`${label}: decimal inválido`);
  }
  const result = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(result)) throw new RangeError(`${label}: decimal inválido`);
  return result;
}

function assertPercentage(pct: number): void {
  if (
    !Number.isFinite(pct) ||
    pct < 0 ||
    pct > 50 ||
    Math.abs(pct * 100 - Math.round(pct * 100)) > 1e-8
  ) {
    throw new RangeError('O percentual deve estar entre 0 e 50, com até duas casas decimais');
  }
}

function instant(value: Date | string, label: string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) throw new RangeError(`${label}: data inválida`);
  return time;
}

const nullableInstant = (value: Date | string | null): number | null =>
  value === null ? null : instant(value, 'Prazo');

/** Vez de quem responde: ímpar (oferta do cliente) → freelancer. */
export function turnOf(seq: number): NegotiationTurn {
  assertSeq(seq);
  return seq % 2 === 1 ? 'freelancer' : 'client';
}

export function madeByOf(seq: number): NegotiationTurn {
  return turnOf(seq) === 'freelancer' ? 'client' : 'freelancer';
}

export function roundOf(seq: number): 1 | 2 | 3 {
  assertSeq(seq);
  return Math.ceil(seq / 2) as 1 | 2 | 3;
}

export function canCounter(seq: number): boolean {
  assertSeq(seq);
  return seq < MAX_OFFERS;
}

export function countersLeft(seq: number): number {
  assertSeq(seq);
  return Math.ceil((MAX_OFFERS - seq) / 2);
}

/**
 * Recupera a taxa vigente na proposta. No legado ela era inteira: inferir o inteiro e
 * reproduzir a taxa em centavos evita trocar 15% por 14,985% numa oferta de R$ 10,01.
 * Dados incoerentes falham; nunca se consulta nem se substitui pela taxa atual do painel.
 */
export function feePctOf(row: {
  fee_percentage: string | number | null;
  platform_fee: string | number;
  price: string | number;
}): number {
  const price = decimal(row.price, 'Preço histórico');
  const priceCents = cents(price, 'Preço histórico', 10);
  const feeCents = cents(decimal(row.platform_fee, 'Taxa histórica'), 'Taxa histórica');
  const pct =
    row.fee_percentage === null
      ? Math.round((feeCents * 100) / priceCents)
      : decimal(row.fee_percentage, 'Percentual gravado');
  assertPercentage(pct);
  if (cents(money((price * pct) / 100), 'Taxa calculada') !== feeCents) {
    throw new RangeError('Taxa histórica incompatível com o percentual da proposta');
  }
  return pct;
}

/**
 * Rateio em dinheiro, sem depender dos ids dos marcos (também serve à criação).
 * Mantém o arredondamento individual e a sobra no último marco quando isso é viável.
 * Limita cada líquido ao restante e à capacidade dos marcos seguintes: parcelas de
 * um centavo não podem produzir líquido negativo nem acima do valor de um marco.
 */
export function milestoneNets(amounts: readonly number[], net: number, pct: number): number[] {
  assertPercentage(pct);
  const values = amounts.map((amount) => cents(amount, 'Valor do marco', 0.01));
  const total = values.reduce((sum, value) => sum + value, 0);
  let remainingNet = cents(net, 'Líquido');
  if (!Number.isSafeInteger(total) || remainingNet > total) {
    throw new RangeError('O líquido deve estar entre zero e a soma dos marcos');
  }
  let remainingAmount = total;
  return values.map((amount, i) => {
    remainingAmount -= amount;
    const wanted =
      i === values.length - 1
        ? remainingNet
        : cents(money(amounts[i]! * (1 - pct / 100)), 'Líquido do marco');
    const minimum = Math.max(0, remainingNet - remainingAmount);
    const maximum = Math.min(amount, remainingNet);
    const assigned = Math.max(minimum, Math.min(maximum, wanted));
    remainingNet -= assigned;
    return assigned / 100;
  });
}

/** Termos da oferta; o rateio em dinheiro usa a mesma conta pura da criação. */
export function offerTerms(params: {
  price: number;
  pct: number;
  mode: 'cash' | 'credits';
  milestones?: readonly OfferMilestoneInput[];
}): OfferTerms {
  const priceCents = cents(params.price, 'Preço', 10);
  assertPercentage(params.pct);
  if (params.mode !== 'cash' && params.mode !== 'credits')
    throw new RangeError('Modo de pagamento inválido');
  const credits = params.mode === 'credits';
  if (credits && (!Number.isInteger(params.price) || params.pct !== 0)) {
    throw new RangeError('Créditos são inteiros e não cobram taxa');
  }
  const feeCents = credits ? 0 : cents(money((params.price * params.pct) / 100), 'Taxa');
  const netCents = priceCents - feeCents;
  let milestones: OfferMilestoneTerms[] | null = null;
  if (params.milestones !== undefined) {
    if (params.milestones.length < 2 || params.milestones.length > 10) {
      throw new RangeError('A oferta por marcos precisa ter de 2 a 10 marcos');
    }
    const ids = new Set<number>();
    let total = 0;
    const amounts = params.milestones.map((m) => {
      if (!Number.isSafeInteger(m.id) || m.id <= 0 || ids.has(m.id)) {
        throw new RangeError('Os marcos precisam ter identificadores únicos e positivos');
      }
      ids.add(m.id);
      if (m.dueAt !== null) instant(m.dueAt, 'Prazo do marco');
      const amount = cents(m.amount, 'Valor do marco', 0.01);
      if (credits && !Number.isInteger(m.amount))
        throw new RangeError('O marco precisa ter créditos inteiros');
      total += amount;
      return amount;
    });
    if (total !== priceCents) throw new RangeError('A soma dos marcos precisa ser igual ao preço');
    const nets = credits
      ? amounts.map((amount) => amount / 100)
      : milestoneNets(
          params.milestones.map((m) => m.amount),
          netCents / 100,
          params.pct,
        );
    milestones = params.milestones.map((m, i) => {
      return { ...m, amount: amounts[i]! / 100, freelancerNet: nets[i]! };
    });
  }
  return { price: priceCents / 100, fee: feeCents / 100, net: netCents / 100, milestones };
}

/** Hora gravada de dia, limitada pelo prazo; menos de uma hora para responder não vale. */
export function offerRespondBy(params: {
  now: Date;
  hours: number;
  zone: BrazilTimezone;
  deadline: Date | null;
}): Date | null {
  const now = instant(params.now, 'Agora');
  if (!Number.isInteger(params.hours) || params.hours < 1 || params.hours > 720) {
    throw new RangeError('Horas de resposta devem ser um inteiro de 1 a 720');
  }
  if (!BRAZIL_TIMEZONES.includes(params.zone)) throw new RangeError('Fuso brasileiro inválido');
  let due = humanize(new Date(now + params.hours * H), params.zone);
  if (params.deadline !== null) {
    instant(params.deadline, 'Prazo');
    const cap = lastHumanAtOrBefore(params.deadline, params.zone);
    if (cap.getTime() < due.getTime()) due = cap;
  }
  const result = floorSecond(due);
  return result.getTime() - now < H ? null : result;
}

/** Diferença calculada em centavos; o disponível e a reserva sempre se compensam. */
export function holdAdjust(clientId: number, held: number, next: number): OfferWalletEffect[] {
  if (!Number.isSafeInteger(clientId) || clientId <= 0) throw new RangeError('Cliente inválido');
  const delta = cents(next, 'Nova reserva') - cents(held, 'Reserva atual');
  if (delta === 0) return [];
  return [
    {
      userId: clientId,
      balanceDelta: -delta / 100,
      pendingDelta: delta / 100,
      reason: delta > 0 ? 'hold' : 'hold_release',
    },
  ];
}

/** Só valor, prazo e os termos dos mesmos marcos fazem parte da contraproposta. */
export function sameTerms(a: OfferLike, b: OfferLike): boolean {
  if (
    cents(a.price, 'Preço') !== cents(b.price, 'Preço') ||
    nullableInstant(a.deadlineAt) !== nullableInstant(b.deadlineAt)
  )
    return false;
  const left = a.milestones ?? [];
  const right = b.milestones ?? [];
  return (
    left.length === right.length &&
    left.every((m, i) => {
      const other = right[i]!;
      return (
        m.id === other.id &&
        cents(m.amount, 'Marco') === cents(other.amount, 'Marco') &&
        nullableInstant(m.dueAt) === nullableInstant(other.dueAt)
      );
    })
  );
}

/** Preserva prazo × sem prazo e os ids/ordem dos marcos; não recria a entrega. */
export function sameShape(
  row: { deadline_at: Date | null },
  ids: readonly number[] | null,
  body: CounterOfferRequest,
): boolean {
  if ((row.deadline_at === null) !== (body.deadlineAt === null)) return false;
  const existing = ids ?? [];
  const next = body.milestones;
  if (existing.length === 0) return next === undefined;
  if (next === undefined || existing.length !== next.length) return false;
  return existing.every((id, i) => id === next[i]!.id);
}
