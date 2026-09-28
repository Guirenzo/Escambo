import type { BrazilTimezone, CancelStage, CancelTerms } from '@escambo/types';
import { formatDue } from '../../utils/timezone';
import { overdueNoticeAt } from './deadline-grace';

/**
 * O cancelamento como conta pura (RN-025, ADR 57): a Sala mostra, o POST confere o valor visto e
 * liquida o MESMO resultado. Regras, na ordem:
 *  - antes do aceite: o cliente retira a proposta e a reserva volta inteira; o freelancer recusa;
 *  - depois da entrega não se cancela (aprovação, revisão ou disputa);
 *  - marco entregue em aberto trava o cancelamento;
 *  - troca não move dinheiro aqui; créditos voltam inteiros;
 *  - o freelancer que desiste devolve ao cliente tudo o que está em garantia;
 *  - o cliente: sem prazo, 50%; prazo vencido sem nenhuma entrega, 100% a partir do aviso das 9h
 *    (a carência protege contra a disputa automática, não contra o cancelamento); antes disso,
 *    espera o aviso; antes do prazo, 50% se passou menos da metade do tempo entre o aceite e o
 *    prazo, 0% se passou mais.
 */

/** Arredonda em centavos, meio centavo para cima, sem cair no 28333.4999… do ponto flutuante. */
export const money = (v: number): number =>
  Math.sign(v) * (Math.round(Math.abs(v) * 100 + 1e-6) / 100);

/**
 * Liquidação do escrow em R$ quando a contratação NÃO chega ao fim combinado (cancelamento
 * após o aceite, disputa): cada parcela (preço, líquido, taxa) é dividida na mesma proporção.
 * O cliente recebe `refundPct`% do PREÇO (inclui a parte proporcional da taxa) e o freelancer
 * fica com o restante do LÍQUIDO; a plataforma retém só a parte proporcional da taxa.
 */
export function cashSettlement(
  price: number,
  net: number,
  refundPct: number,
): { refundClient: number; releaseFreelancer: number } {
  const pct = Math.min(100, Math.max(0, refundPct));
  const refundClient = money((price * pct) / 100);
  // Cada parcela arredonda meio centavo para cima; sem taxa em jogo (preço = líquido, centavo
  // ímpar), as duas somariam 1 centavo a mais do que o escrow. O freelancer fica com a sobra.
  const releaseFreelancer = Math.min(money((net * (100 - pct)) / 100), money(price - refundClient));
  return { refundClient, releaseFreelancer: Math.max(0, releaseFreelancer) };
}

export interface CancelInput {
  by: 'client' | 'freelancer';
  status: string;
  paymentMode: string;
  /** Ainda há trabalho nunca entregue (owesDelivery). */
  owes: boolean;
  deadlineAt: Date | null;
  acceptedAt: Date | null;
  createdAt: Date;
  /** Quando o aviso de atraso saiu (overdue_notified_at). */
  noticeAt: Date | null;
  extensionPending: boolean;
  /** Marcos entregues esperando o cliente. */
  deliveredAwaiting: number;
  /** Marcos entregues que voltaram para revisão. */
  inRevision: number;
  /** Fuso atual de quem entrega: o aviso de atraso sai a partir das 9h nele. */
  freelancerZone: BrazilTimezone;
  /** Fuso de quem lê a mensagem. */
  viewerZone: BrazilTimezone;
  now: Date;
  /** Escrow em jogo em R$ (por marcos, só o que não foi liberado). */
  price: number;
  net: number;
  /** Créditos em garantia (por marcos, só os não liberados). */
  credits: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function blocked(
  i: CancelInput,
  code: string,
  message: string,
  availableAt: Date | null = null,
): CancelTerms {
  return {
    allowed: false,
    by: i.by,
    stage: null,
    refundPercentage: 0,
    refundClient: 0,
    releaseFreelancer: 0,
    unit: i.paymentMode === 'credits' ? 'credits' : i.paymentMode === 'barter' ? 'none' : 'BRL',
    code,
    message,
    availableAt: iso(availableAt),
    noticeAt: null,
  };
}

function afterStatusMessage(i: CancelInput): string {
  if (i.status === 'delivered' || i.status === 'revision_requested') {
    return i.by === 'client'
      ? 'Depois da entrega não se cancela: aprove, peça revisão ou abra uma disputa.'
      : 'Depois da entrega não se desiste: entregue a revisão, aguarde o cliente ou abra uma disputa.';
  }
  if (i.status === 'disputed') {
    return 'Esta contratação está em disputa: quem decide o valor é a mediação do Escambo.';
  }
  return 'Esta contratação já foi encerrada.';
}

function milestoneOpenMessage(i: CancelInput): string {
  if (i.by === 'client') {
    return i.deliveredAwaiting > 0
      ? 'Há marco entregue esperando a sua resposta: aprove, peça revisão ou abra uma disputa antes de cancelar.'
      : 'Há marco em revisão esperando a nova entrega: aguarde ou abra uma disputa antes de cancelar.';
  }
  return i.deliveredAwaiting > 0
    ? 'Há marco entregue esperando o cliente: aguarde a resposta ou abra uma disputa antes de desistir.'
    : 'Há marco em revisão esperando você: entregue de novo ou abra uma disputa antes de desistir.';
}

export function cancelTerms(i: CancelInput): CancelTerms {
  const ok = (
    stage: CancelStage,
    pct: number,
    extra: Partial<Pick<CancelTerms, 'noticeAt'>> = {},
  ): CancelTerms => {
    let refundClient = 0;
    let releaseFreelancer = 0;
    let unit: CancelTerms['unit'] = 'BRL';
    if (stage === 'barter') {
      unit = 'none';
    } else if (i.paymentMode === 'credits') {
      unit = 'credits';
      refundClient = stage === 'proposal' ? 0 : i.credits;
    } else if (stage === 'proposal') {
      refundClient = money(i.price);
    } else {
      ({ refundClient, releaseFreelancer } = cashSettlement(i.price, i.net, pct));
    }
    return {
      allowed: true,
      by: i.by,
      stage,
      refundPercentage: pct,
      refundClient,
      releaseFreelancer,
      unit,
      code: null,
      message: null,
      availableAt: null,
      noticeAt: extra.noticeAt ?? null,
    };
  };

  if (i.status === 'pending') {
    return i.by === 'freelancer'
      ? blocked(i, 'use_reject', 'Para não aceitar a proposta, use Recusar.')
      : ok('proposal', 100);
  }
  if (i.status !== 'accepted' && i.status !== 'in_progress') {
    return blocked(i, 'invalid_transition', afterStatusMessage(i));
  }
  if (i.deliveredAwaiting > 0 || i.inRevision > 0) {
    return blocked(i, 'milestone_open', milestoneOpenMessage(i));
  }
  if (i.paymentMode === 'barter') return ok('barter', 0);
  if (i.paymentMode === 'credits') return ok(i.by === 'freelancer' ? 'withdrawal' : 'credits', 100);
  if (i.by === 'freelancer') return ok('withdrawal', 100);
  if (!i.deadlineAt) return ok('no_deadline', 50);

  const now = i.now.getTime();
  const deadline = i.deadlineAt.getTime();
  const noticeAt = i.noticeAt ?? overdueNoticeAt(i.deadlineAt, i.freelancerZone);
  if (deadline <= now) {
    if (i.extensionPending) {
      return blocked(
        i,
        'extension_pending_answer',
        'Há um pedido de extensão esperando a sua resposta: responda antes de cancelar.',
      );
    }
    if (i.owes) {
      if (now >= noticeAt.getTime()) return ok('overdue', 100);
      return blocked(
        i,
        'wait_notice',
        `O prazo venceu há pouco. ${formatDue(noticeAt, i.viewerZone)} o Escambo avisa o freelancer; a partir daí, cancelar devolve tudo a você.`,
        noticeAt,
      );
    }
  }
  const from = (i.acceptedAt ?? i.createdAt).getTime();
  const fraction = deadline > from ? (now - from) / (deadline - from) : 1;
  return fraction < 0.5
    ? ok('early', 50)
    : ok('late', 0, { noticeAt: i.owes ? iso(noticeAt) : null });
}
