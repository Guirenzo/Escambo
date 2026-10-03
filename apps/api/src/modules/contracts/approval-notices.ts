import { brl, milestoneList, type DeadlineNotice } from './deadline-notices';

/**
 * Os avisos da aprovação automática (ADR 58), palavra por palavra. A tácita move dinheiro sozinha,
 * então avisa as duas partes: o cliente fica sabendo que a entrega foi aprovada e até quando pode
 * avaliar; o freelancer, quanto entrou na carteira. O valor dito ao cliente é o da contratação ou
 * do marco (o freelancer recebe o líquido da taxa, RN-031); ao freelancer, o líquido. Puros: quem
 * emite passa as horas já formatadas no fuso de quem lê.
 */

export type ApprovalMode = 'cash' | 'credits' | 'barter';

/** "R$ 1.234,50", "5 créditos" ou "1 crédito". */
const amountText = (mode: ApprovalMode, v: number): string =>
  mode === 'credits' ? (v === 1 ? '1 crédito' : `${v} créditos`) : brl(v);

/** "R$ 10,00 foi liberado na sua carteira" ou "5 créditos foram liberados na sua carteira". */
const released = (mode: ApprovalMode, v: number): string =>
  mode === 'credits'
    ? v === 1
      ? '1 crédito foi liberado na sua carteira'
      : `${v} créditos foram liberados na sua carteira`
    : `${brl(v)} foi liberado na sua carteira`;

/** Entrega única aprovada automaticamente: uma cópia a cada parte. */
export function tacitApprovedNotices(f: {
  contractId: number;
  title: string;
  mode: ApprovalMode;
  /** Valor da contratação (dinheiro) ou créditos dela. */
  price: number;
  /** Líquido do freelancer (dinheiro) ou créditos liberados. */
  net: number;
  /** A hora gravada da aprovação, no fuso do cliente e no do freelancer. */
  dueClient: string;
  dueFreelancer: string;
  /** Até quando o cliente pode avaliar (RN-043), no fuso dele. */
  reviewUntil: string;
}): { client: DeadlineNotice; freelancer: DeadlineNotice } {
  const data = { contractId: f.contractId };
  const clientBody =
    f.mode === 'barter'
      ? `Sem resposta até ${f.dueClient}, a entrega foi aprovada e conta para fechar a troca.`
      : f.mode === 'credits'
        ? `Sem resposta até ${f.dueClient}, a entrega foi aprovada e ${f.net === 1 ? 'o 1 crédito foi liberado' : `os ${f.net} créditos foram liberados`} ao freelancer.`
        : `Sem resposta até ${f.dueClient}, a entrega foi aprovada e o pagamento foi liberado ao freelancer (contratação de ${brl(f.price)}).`;
  const freelancerBody =
    f.mode === 'barter'
      ? `Sem resposta do cliente até ${f.dueFreelancer}, a entrega foi aprovada automaticamente e conta para fechar a troca.`
      : `Sem resposta do cliente até ${f.dueFreelancer}, a entrega foi aprovada automaticamente e ${released(f.mode, f.net)}.`;
  return {
    client: {
      params: {
        type: 'contract_auto_approved',
        title: `Aprovada automaticamente: ${f.title}`,
        body: `${clientBody} Você pode avaliar até ${f.reviewUntil}.`,
        data,
      },
    },
    freelancer: {
      params: {
        type: 'contract_completed',
        title: `Contratação concluída: ${f.title}`,
        body: freelancerBody,
        data,
      },
    },
  };
}

export interface ApprovedMilestone {
  id: number;
  title: string;
  /** Valor do marco (o que o cliente pagou por ele). */
  amount: number;
  /** O que o freelancer recebeu por ele. */
  net: number;
}

/**
 * Marcos da mesma contratação aprovados automaticamente na mesma rodada: um aviso a cada parte.
 * `due` é a hora em comum, já formatada para cada leitor, ou null quando cada marco tinha a sua.
 * Com `completed`, eram os que faltavam e a contratação foi concluída.
 */
export function milestonesTacitNotices(f: {
  contractId: number;
  title: string;
  mode: 'cash' | 'credits';
  milestones: ApprovedMilestone[];
  dueClient: string | null;
  dueFreelancer: string | null;
  completed: boolean;
  /** Até quando o cliente pode avaliar, se concluiu. */
  reviewUntil: string | null;
}): { client: DeadlineNotice; freelancer: DeadlineNotice } {
  const ms = f.milestones;
  const one = ms.length === 1 ? ms[0]! : null;
  const sumAmount = ms.reduce((s, m) => s + m.amount, 0);
  const sumNet = ms.reduce((s, m) => s + m.net, 0);
  const list = milestoneList(ms.map((m) => m.title));
  const until = (due: string | null): string => (due ? `até ${due}` : 'na hora de cada um');
  const end =
    f.completed && f.reviewUntil
      ? ` Era o que faltava: a contratação foi concluída, e você pode avaliar até ${f.reviewUntil}.`
      : '';
  const data = one
    ? { contractId: f.contractId, milestoneId: one.id }
    : { contractId: f.contractId };

  const client: DeadlineNotice = {
    params: one
      ? {
          type: 'contract_auto_approved',
          title: `Marco aprovado automaticamente: ${one.title}`,
          body: `${f.title}: sem resposta ${until(f.dueClient)}, o marco foi aprovado e ${f.mode === 'credits' ? 'os créditos dele foram liberados' : 'o pagamento dele foi liberado'} ao freelancer (marco de ${amountText(f.mode, one.amount)}).${end}`,
          data,
        }
      : {
          type: 'contract_auto_approved',
          title: `${ms.length} marcos aprovados automaticamente: ${f.title}`,
          body: `Sem resposta ${until(f.dueClient)}, ${list} foram aprovados e ${f.mode === 'credits' ? 'os créditos deles foram liberados' : 'o pagamento deles foi liberado'} ao freelancer (${amountText(f.mode, sumAmount)} ao todo).${end}`,
          data,
        },
  };

  const freelancerUntil = until(f.dueFreelancer);
  const freelancer: DeadlineNotice = {
    params: f.completed
      ? {
          type: 'contract_completed',
          title: `Contratação concluída: ${f.title}`,
          body: one
            ? `Sem resposta do cliente ${freelancerUntil}, o último marco («${one.title}») foi aprovado automaticamente e ${released(f.mode, one.net)}.`
            : `Sem resposta do cliente ${freelancerUntil}, ${list} foram aprovados automaticamente e ${released(f.mode, sumNet)}. Eram os que faltavam.`,
          data,
        }
      : one
        ? {
            type: 'milestone_approved',
            title: `Marco aprovado automaticamente: ${one.title}`,
            body: `${f.title}: sem resposta do cliente ${freelancerUntil}, ${released(f.mode, one.net)}.`,
            data,
          }
        : {
            type: 'milestone_approved',
            title: `${ms.length} marcos aprovados automaticamente: ${f.title}`,
            body: `Sem resposta do cliente ${freelancerUntil}, ${list} foram aprovados e ${released(f.mode, sumNet)}.`,
            data,
          },
  };
  return { client, freelancer };
}
