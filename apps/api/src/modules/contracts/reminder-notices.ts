import { brl, milestoneList, type DeadlineNotice } from './deadline-notices';

/**
 * Os lembretes antes de cada vencimento e o aviso de revisão parada (ADR 58), palavra por palavra.
 * O título é o vencimento: a ação e a hora (ou o dia) vêm ANTES do nome da contratação, porque o
 * título é cortado em 150 caracteres e o resumo do "não perturbe" só mostra títulos. A consequência
 * vem no começo do corpo (o aviso no aparelho corta em 120) e o prazo inteiro fica no fim. Nenhum
 * lembrete fura o silêncio. Puros: quem emite passa as horas já formatadas no fuso de quem lê.
 */

const hours = (n: number): string => (n === 1 ? '1 hora' : `${n} horas`);

/** Ao freelancer: responder à proposta antes de ela se encerrar (RN-021). */
export function proposalReminder(f: {
  contractId: number;
  title: string;
  /** Até quando responder, no fuso do freelancer. */
  respondBy: string;
  /** Proposta em dinheiro: a reserva volta ao cliente se ela se encerrar. */
  cash: boolean;
  /** O prazo de entrega como dia, se houver. */
  deadline: string | null;
}): DeadlineNotice {
  return {
    params: {
      type: 'contract_proposal_reminder',
      title: `Responda à proposta até ${f.respondBy}: ${f.title}`,
      body: `Aceite ou recuse até lá. Sem resposta, a proposta se encerra${f.cash ? ' e o valor reservado volta ao cliente' : ''}.${f.deadline ? ` Se aceitar, o prazo de entrega é ${f.deadline}.` : ''}`,
      data: { contractId: f.contractId },
    },
  };
}

/** A quem entrega: o prazo de entrega (RN-029), com o que acontece se ele passar. */
export function deliveryReminder(f: {
  contractId: number;
  title: string;
  /** Só o dia do prazo, para o título ("sex, 02/10"). */
  day: string;
  /** O prazo inteiro como dia, no fuso de quem entrega. */
  deadline: string;
  byMilestones: boolean;
  /** Títulos dos marcos nunca entregues. */
  missing: string[];
  /** Ainda cabe pedir extensão. */
  canRequest: boolean;
  /** O cliente poderá cancelar com reembolso integral a partir do aviso (nenhum marco entregue em aberto). */
  cancelOpen: boolean;
  /** Por marcos, algum já foi entregue: o cancelamento é do que falta. */
  partial: boolean;
  /** Quando sai o aviso de atraso (a mesma conta da Sala), no fuso de quem entrega. */
  noticeAt: string;
  /** A carência de hoje, em horas (painel). */
  graceHours: number;
}): DeadlineNotice {
  const ask = f.byMilestones
    ? f.canRequest
      ? `Entregue ${milestoneList(f.missing)} até lá ou peça a extensão antes.`
      : `Entregue ${milestoneList(f.missing)} até lá: não há mais pedido de extensão.`
    : f.canRequest
      ? 'Registre a entrega até lá ou peça a extensão antes.'
      : 'Registre a entrega até lá: não há mais pedido de extensão.';
  const without = f.byMilestones ? 'Sem as entregas' : 'Sem entrega';
  const cancel = f.cancelOpen
    ? `, o cliente pode cancelar ${f.byMilestones && f.partial ? 'o que falta ' : ''}com reembolso integral`
    : '';
  return {
    params: {
      type: 'contract_deadline_reminder',
      title: `Entregue até ${f.day}: ${f.title}`,
      body: `${ask} ${without}, a partir de ${f.noticeAt} o Escambo avisa vocês dois${cancel} e começa a carência até a disputa automática (hoje, ${hours(f.graceHours)}). O prazo é ${f.deadline}.`,
      data: { contractId: f.contractId },
    },
  };
}

/** Ao cliente: aprovar ou pedir revisão antes da aprovação automática da entrega (RN-024). */
export function approvalReminder(f: {
  contractId: number;
  title: string;
  /** A hora gravada da aprovação automática, no fuso do cliente. */
  until: string;
  mode: 'cash' | 'credits' | 'barter';
  price: number;
  credits: number;
}): DeadlineNotice {
  const body =
    f.mode === 'barter'
      ? 'Depois disso, a entrega é aprovada sozinha, conta para fechar a troca e não cabe mais revisão nem disputa.'
      : f.mode === 'credits'
        ? `Depois disso, a entrega é aprovada sozinha, os créditos são liberados ao freelancer e não cabe mais revisão nem disputa. Créditos da contratação: ${f.credits}.`
        : `Depois disso, a entrega é aprovada sozinha, o pagamento é liberado ao freelancer e não cabe mais revisão nem disputa. Valor da contratação: ${brl(f.price)}.`;
  return {
    params: {
      type: 'contract_approval_reminder',
      title: `Aprove ou peça revisão até ${f.until}: ${f.title}`,
      body,
      data: { contractId: f.contractId },
    },
  };
}

export interface MilestoneDue {
  id: number;
  title: string;
  amount: number;
  /** A hora da aprovação automática do marco, no fuso do cliente. */
  until: string;
  dueAt: Date;
}

/** Ao cliente: os marcos que serão aprovados sozinhos, um aviso por contratação (RN-069). */
export function milestoneApprovalReminder(f: {
  contractId: number;
  title: string;
  mode: 'cash' | 'credits';
  milestones: MilestoneDue[];
}): DeadlineNotice {
  const ms = [...f.milestones].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const value = (v: number): string =>
    f.mode === 'credits' ? (v === 1 ? '1 crédito' : `${v} créditos`) : brl(v);
  const credits = f.mode === 'credits';
  const first = ms[0]!;
  if (ms.length === 1) {
    return {
      params: {
        type: 'contract_approval_reminder',
        title: `Até ${first.until}: aprove ou peça revisão do marco «${first.title}»`,
        body: `Depois disso, o marco é aprovado sozinho, ${credits ? 'os créditos dele são liberados' : 'o pagamento dele é liberado'} ao freelancer e não cabe mais pedir revisão. Valor do marco: ${value(first.amount)}. Contratação: ${f.title}.`,
        data: { contractId: f.contractId, milestoneId: first.id },
      },
    };
  }
  const sum = value(ms.reduce((s, m) => s + m.amount, 0));
  const list = milestoneList(ms.map((m) => m.title));
  const sameDue = ms.every((m) => m.dueAt.getTime() === first.dueAt.getTime());
  return {
    params: sameDue
      ? {
          type: 'contract_approval_reminder',
          title: `Aprove ou peça revisão de ${ms.length} marcos até ${first.until}: ${f.title}`,
          body: `Depois disso, ${list} são aprovados sozinhos, ${credits ? 'os créditos deles são liberados' : 'o pagamento deles é liberado'} ao freelancer e não cabe mais pedir revisão. Valor dos marcos: ${sum}.`,
          data: { contractId: f.contractId },
        }
      : {
          type: 'contract_approval_reminder',
          title: `${ms.length} marcos esperam a sua resposta, o primeiro até ${first.until}: ${f.title}`,
          body: `Cada um é aprovado sozinho na hora dele (a de cada marco está na Sala): ${list}. ${credits ? 'Os créditos são liberados' : 'O pagamento é liberado'} ao freelancer e não cabe mais pedir revisão. Valor dos marcos: ${sum}.`,
          data: { contractId: f.contractId },
        },
  };
}

/** Ao cliente: responder ao pedido de extensão antes de ele expirar (RN-028). */
export function extensionReminder(f: {
  contractId: number;
  title: string;
  /** Até quando responder, no fuso do cliente. */
  until: string;
  /** O novo prazo pedido, como dia. */
  proposed: string;
  /** O prazo atual, como dia. */
  deadline: string;
  /** O prazo atual já venceu: enquanto o cliente decide, a disputa automática espera. */
  overdue: boolean;
}): DeadlineNotice {
  return {
    params: {
      type: 'contract_extension_reminder',
      title: `Responda ao pedido de extensão até ${f.until}: ${f.title}`,
      body: f.overdue
        ? `Aceite o novo prazo, ${f.proposed}, ou recuse. Sem resposta, o pedido expira e vale o prazo atual, que já venceu. Enquanto você decide, a disputa automática espera.`
        : `Aceite o novo prazo, ${f.proposed}, ou recuse. Sem resposta, o pedido expira e vale o prazo atual, ${f.deadline}.`,
      data: { contractId: f.contractId },
    },
  };
}

/**
 * Revisão sem nova entrega há 7 dias ou mais (RN-081): um aviso a cada parte, sem sanção. Com
 * `milestone`, é a revisão de um marco.
 */
export function revisionStalledNotices(f: {
  contractId: number;
  title: string;
  /** Quando a revisão foi pedida, no fuso de cada leitor. */
  requestedClient: string;
  requestedFreelancer: string;
  /** Dias inteiros desde o pedido. */
  days: number;
  milestone: { id: number; title: string } | null;
  /** Troca: não há valor em garantia, a mediação decide o desfecho. */
  barter: boolean;
}): { client: DeadlineNotice; freelancer: DeadlineNotice } {
  const m = f.milestone;
  const data = m ? { contractId: f.contractId, milestoneId: m.id } : { contractId: f.contractId };
  return m
    ? {
        client: {
          params: {
            type: 'contract_revision_stalled',
            title: `Revisão sem nova entrega há ${f.days} dias, marco «${m.title}»`,
            body: `${f.title}: você pediu revisão em ${f.requestedClient} e o marco ainda não foi entregue de novo. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.`,
            data,
          },
        },
        freelancer: {
          params: {
            type: 'contract_revision_stalled',
            title: `Revisão esperando você há ${f.days} dias, marco «${m.title}»`,
            body: `${f.title}: o cliente pediu revisão em ${f.requestedFreelancer}. Entregue o marco de novo ou combine pelo chat; qualquer um de vocês pode abrir uma disputa pela Sala.`,
            data,
          },
        },
      }
    : {
        client: {
          params: {
            type: 'contract_revision_stalled',
            title: `Revisão sem nova entrega há ${f.days} dias: ${f.title}`,
            body: `Você pediu revisão em ${f.requestedClient} e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala${f.barter ? '' : ', e a mediação do Escambo decide sobre o valor'}.`,
            data,
          },
        },
        freelancer: {
          params: {
            type: 'contract_revision_stalled',
            title: `Revisão esperando você há ${f.days} dias: ${f.title}`,
            body: `O cliente pediu revisão em ${f.requestedFreelancer}. Registre a nova entrega ou combine pelo chat. Nada muda sozinho, mas qualquer um de vocês pode abrir uma disputa pela Sala.`,
            data,
          },
        },
      };
}
