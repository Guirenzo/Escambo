import type { CancelStage, QuietPassCategory } from '@escambo/types';

/**
 * Os avisos do prazo, palavra por palavra (ADR 56 e 57). Puros: quem emite decide o estado e o
 * fuso e passa os instantes já formatados no fuso de quem lê; aqui fica o que cada aviso diz. O que
 * importa (até quando, e o que fazer) vem primeiro, porque o aviso no aparelho corta o corpo em 120
 * caracteres; o prazo original fica no fim. Só a cópia do aviso de atraso a quem entrega pode sair
 * durante o "não perturbe" (categoria 'deadline'): depois da recusa ou da expiração de um pedido
 * sobram sempre pelo menos 6 h de dia, e a revisão não tem mais carência.
 */

export interface NoticeParams {
  type: string;
  title: string;
  body: string | null;
  data: { contractId: number; milestoneId?: number; disputeId?: number };
}

export interface DeadlineNotice {
  params: NoticeParams;
  /** Pode sair durante o silêncio de quem marcou (ADR 56); ausente = espera o fim da janela. */
  passCategory?: QuietPassCategory;
}

/** "R$ 1.234,50", com espaço comum (o Intl põe um espaço inseparável depois do R$). */
export const brl = (v: number): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(v)
    .replace(/\u00a0/g, ' ');

/** "o marco «A»", "os marcos «A» e «B»", "os marcos «A», «B» e «C»", ou "4 marcos". */
export function milestoneList(titles: string[]): string {
  const q = titles.map((t) => `«${t}»`);
  if (q.length === 1) return `o marco ${q[0]}`;
  if (q.length > 3) return `${q.length} marcos`;
  return `os marcos ${q.slice(0, -1).join(', ')} e ${q.at(-1)}`;
}

/** O que falta a quem entrega, com ou sem a extensão ainda possível. */
export interface WorkFacts {
  byMilestones: boolean;
  /** Títulos dos marcos financiados nunca entregues. */
  missing: string[];
  /** Pedidos de extensão que ainda cabem. */
  requestsLeft: number;
}

function action(w: WorkFacts): string {
  const ask = w.requestsLeft > 0 ? ' ou peça a extensão' : '';
  if (w.byMilestones) return `entregue ${milestoneList(w.missing)}${ask}`;
  return w.requestsLeft > 0 ? 'entregue ou peça a extensão' : 'registre a entrega';
}

function requestsNote(left: number): string {
  if (left === 1) return ' Você ainda pode fazer mais um pedido.';
  if (left === 0) return ' Não há mais pedido de extensão.';
  return '';
}

// ---------- Prazo vencido (RN-029, fase 1) ----------

export interface OverdueFacts extends WorkFacts {
  contractId: number;
  title: string;
  /** Prazo original, no fuso de quem lê ("25/09/2026"). */
  deadline: string;
  /** Fim da carência, no fuso de quem lê ("sáb, 26/09 às 09:00"). */
  limit: string;
  /** A extensão já foi aceita uma vez. */
  extensionAccepted: boolean;
  /** O cliente já pode cancelar com reembolso integral (nenhum marco entregue em aberto). */
  cancelOpen: boolean;
  /** Marcos já entregues e marcos no total (por marcos). */
  delivered: number;
  total: number;
}

/** Cópia de quem entrega: sai sempre no silêncio de quem marcou (ADR 56). */
export function overdueFreelancerNotice(f: OverdueFacts): DeadlineNotice {
  const partial = f.byMilestones && f.delivered > 0;
  const cancel = f.cancelOpen
    ? ` O cliente já pode cancelar ${partial ? 'o que falta ' : ''}com reembolso integral.`
    : '';
  const note = f.extensionAccepted
    ? ' A extensão já foi usada.'
    : f.requestsLeft === 0
      ? ' Não há mais pedido de extensão.'
      : '';
  return {
    params: {
      type: 'contract_overdue',
      title: `Prazo estourado: ${f.title}`,
      body: `Até ${f.limit}: ${action(f)}, senão a disputa abre sozinha.${cancel}${note} O prazo era ${f.deadline}.`,
      data: { contractId: f.contractId },
    },
    passCategory: 'deadline',
  };
}

/** Cópia do cliente: nunca sai no silêncio. Nunca diz "não houve entrega" se houve marco entregue. */
export function overdueClientNotice(f: OverdueFacts): DeadlineNotice {
  let situation = ' e não houve entrega';
  let option = f.cancelOpen ? 'Se preferir, cancele com reembolso integral. ' : '';
  if (f.byMilestones) {
    if (f.delivered === 0) {
      situation = ' e nenhum marco foi entregue';
    } else {
      const verb = f.missing.length > 1 ? 'faltam' : 'falta';
      situation = `: ${f.delivered} de ${f.total} marcos entregues; ${verb} ${milestoneList(f.missing)}`;
      option = f.cancelOpen ? 'Se preferir, cancele o que falta com reembolso integral. ' : '';
    }
  }
  const missing = f.byMilestones ? 'as entregas que faltam' : 'entrega';
  return {
    params: {
      type: 'contract_overdue',
      title: `Prazo estourado: ${f.title}`,
      body: `Sem ${missing} nem extensão aceita até ${f.limit}, a disputa abre sozinha. ${option}O prazo era ${f.deadline}${situation}.`,
      data: { contractId: f.contractId },
    },
  };
}

// ---------- Extensão de prazo (RN-028) ----------

export function extensionRequestedNotice(f: {
  contractId: number;
  title: string;
  /** Até quando o cliente responde, no fuso dele. */
  respondBy: string;
  /** Data pedida, no fuso dele. */
  proposed: string;
  reason: string;
}): DeadlineNotice {
  return {
    params: {
      type: 'deadline_extension_requested',
      title: `Pedido de extensão: ${f.title}`,
      body: `Responda até ${f.respondBy}: novo prazo proposto ${f.proposed}. Sem resposta, o pedido expira e vale o prazo atual. Motivo: ${f.reason}`,
      data: { contractId: f.contractId },
    },
  };
}

export function extensionAcceptedNotice(f: {
  contractId: number;
  title: string;
  deadline: string;
}): DeadlineNotice {
  return {
    params: {
      type: 'deadline_extension_accepted',
      title: `Extensão aceita: novo prazo ${f.deadline}`,
      body: `${f.title}: o prazo foi estendido; não há outra extensão nesta contratação.`,
      data: { contractId: f.contractId },
    },
  };
}

/**
 * Onde o prazo está quando o pedido é decidido: 'future' ainda não venceu; 'due' venceu e o aviso
 * de atraso ainda não saiu; 'grace' o aviso saiu e a carência volta a correr até `limit`.
 */
export interface DecisionFacts extends WorkFacts {
  contractId: number;
  title: string;
  deadline: string;
  phase: 'future' | 'due' | 'grace';
  /** grace: fim da carência. */
  limit: string | null;
  /** due: quando o aviso sai e quando a disputa abriria. */
  noticeAt: string | null;
  mediationAt: string | null;
}

function afterDecision(f: DecisionFacts, lead: string, tail = ''): string {
  const left = requestsNote(f.requestsLeft);
  if (f.phase === 'grace') {
    return `${lead}Até ${f.limit}: ${action(f)}, senão a disputa abre sozinha. O prazo era ${f.deadline}.${tail}${left}`;
  }
  if (f.phase === 'due') {
    const missing = f.byMilestones ? 'Sem as entregas que faltam' : 'Sem entrega';
    return `${lead}${missing} nem extensão aceita, a disputa abre a partir de ${f.mediationAt}; o aviso de atraso sai a partir de ${f.noticeAt}. O prazo era ${f.deadline}.${tail}${left}`;
  }
  return `${lead}Vale o prazo atual, ${f.deadline}.${tail}${left}`;
}

/** Recusa: sem categoria (sobram pelo menos 6 h de dia para agir). */
export function extensionDeclinedNotice(f: DecisionFacts): DeadlineNotice {
  return {
    params: {
      type: 'deadline_extension_declined',
      title: f.phase === 'future' ? 'Extensão de prazo recusada' : `Extensão recusada: ${f.title}`,
      body:
        f.phase === 'future'
          ? `${f.title}: vale o prazo atual, ${f.deadline}.${requestsNote(f.requestsLeft)}`
          : afterDecision(f, f.phase === 'grace' ? 'Prazo vencido. ' : ''),
      data: { contractId: f.contractId },
    },
  };
}

/** Pedido sem resposta até a hora dita: vale como recusa. Cópia de quem entrega. */
export function extensionExpiredFreelancerNotice(
  f: DecisionFacts & { respondBy: string },
): DeadlineNotice {
  return {
    params: {
      type: 'deadline_extension_expired',
      title: `Pedido de extensão sem resposta: ${f.title}`,
      body: afterDecision(f, '', ` O cliente não respondeu até ${f.respondBy}.`),
      data: { contractId: f.contractId },
    },
  };
}

/** Cópia do cliente: o pedido que ele não respondeu expirou. */
export function extensionExpiredClientNotice(f: {
  contractId: number;
  title: string;
  respondBy: string;
  proposed: string;
  deadline: string;
}): DeadlineNotice {
  return {
    params: {
      type: 'deadline_extension_expired',
      title: `Pedido de extensão expirou: ${f.title}`,
      body: `Sem a sua resposta até ${f.respondBy}, o pedido de novo prazo (${f.proposed}) expirou e vale o prazo atual, ${f.deadline}.`,
      data: { contractId: f.contractId },
    },
  };
}

// ---------- Disputa automática (RN-029, fase 2) ----------

export function autoDisputeNotice(f: {
  contractId: number;
  disputeId: number;
  title: string;
  limit: string;
  /** Por marcos, algum marco foi entregue. */
  partial?: boolean;
}): DeadlineNotice {
  const missing = f.partial ? 'sem os marcos que faltavam' : 'sem entrega';
  return {
    params: {
      type: 'dispute_opened',
      title: 'Disputa aberta automaticamente: prazo estourado',
      body: `${f.title}: ${missing} nem extensão aceita até ${f.limit}, a disputa abriu e a mediação do Escambo decide sobre o valor.`,
      data: { contractId: f.contractId, disputeId: f.disputeId },
    },
  };
}

/** O que a mediação lê, em horário de Brasília. Começa sempre por "Aberta automaticamente". */
export function autoDisputeDescription(f: {
  deadline: string;
  noticeAt: string;
  limit: string;
  delivered: string[] | null;
  missing: string[] | null;
}): string {
  const milestones =
    f.delivered && f.missing
      ? ` Marcos entregues: ${f.delivered.length > 0 ? f.delivered.map((t) => `«${t}»`).join(', ') : 'nenhum'}; sem entrega: ${f.missing.map((t) => `«${t}»`).join(', ')}.`
      : '';
  const partial = !!f.delivered && f.delivered.length > 0;
  return partial
    ? `Aberta automaticamente pela plataforma (RN-029): o prazo de entrega (${f.deadline}) venceu com marcos nunca entregues, o aviso saiu em ${f.noticeAt} e, até ${f.limit}, eles não foram entregues nem houve extensão aceita. Horários de Brasília.${milestones}`
    : `Aberta automaticamente pela plataforma (RN-029): o prazo de entrega (${f.deadline}) venceu sem entrega, o aviso saiu em ${f.noticeAt} e, até ${f.limit}, não houve entrega nem extensão aceita. Horários de Brasília.${milestones}`;
}

// ---------- Marco atrasado (só marco nunca entregue) ----------

export function milestoneOverdueNotices(f: {
  contractId: number;
  milestoneId: number;
  title: string;
  contractTitle: string;
  /** Prazo do marco, no fuso de cada um. */
  dueFreelancer: string;
  dueClient: string;
}): { freelancer: DeadlineNotice; client: DeadlineNotice } {
  const data = { contractId: f.contractId, milestoneId: f.milestoneId };
  return {
    freelancer: {
      params: {
        type: 'milestone_overdue',
        title: `Marco atrasado: ${f.title}`,
        body: `${f.contractTitle}: o prazo deste marco era ${f.dueFreelancer}. Entregue o marco ou combine com o cliente pelo chat.`,
        data,
      },
    },
    client: {
      params: {
        type: 'milestone_overdue',
        title: `Marco atrasado: ${f.title}`,
        body: `${f.contractTitle}: o prazo deste marco era ${f.dueClient} e ele não foi entregue. É o prazo da contratação que abre a disputa automática.`,
        data,
      },
    },
  };
}

// ---------- Proposta, entrega e revisão ----------

export function proposalNotice(f: {
  contractId: number;
  title: string;
  /** Prazo de entrega, no fuso de quem entrega; null sem prazo. */
  deadline: string | null;
  /** Até quando responder. */
  respondBy: string | null;
}): DeadlineNotice {
  const deadline = f.deadline ? ` Prazo de entrega: ${f.deadline}.` : '';
  const respond = f.respondBy ? ` Responda até ${f.respondBy}.` : '';
  return {
    params: {
      type: 'contract_proposal',
      title: 'Nova proposta de contratação',
      body: `${f.title}.${deadline}${respond}`,
      data: { contractId: f.contractId },
    },
  };
}

export function proposalExpiredNotices(f: {
  contractId: number;
  title: string;
  cash: boolean;
  /** Até quando o freelancer tinha para responder, no fuso de cada um. */
  untilClient: string;
  untilFreelancer: string;
}): { client: DeadlineNotice; freelancer: DeadlineNotice } {
  const data = { contractId: f.contractId };
  return {
    client: {
      params: {
        type: 'contract_expired',
        title: 'Sua proposta expirou sem resposta',
        body: `${f.title}: o freelancer não respondeu até ${f.untilClient}.${f.cash ? ' O valor reservado voltou para a sua carteira.' : ''}`,
        data,
      },
    },
    freelancer: {
      params: {
        type: 'contract_expired',
        title: 'Uma proposta expirou',
        body: `${f.title}: sem resposta até ${f.untilFreelancer}, a proposta foi encerrada.`,
        data,
      },
    },
  };
}

export function deliveredNotice(f: {
  contractId: number;
  title: string;
  approvalDue: string;
}): DeadlineNotice {
  return {
    params: {
      type: 'contract_delivered',
      title: `Entrega registrada: ${f.title}`,
      body: `Aprove, peça revisão ou abra disputa até ${f.approvalDue}. Depois disso, a entrega é aprovada automaticamente.`,
      data: { contractId: f.contractId },
    },
  };
}

export function milestoneDeliveredNotice(f: {
  contractId: number;
  milestoneId: number;
  milestone: string;
  approvalDue: string;
  message: string;
}): DeadlineNotice {
  return {
    params: {
      type: 'milestone_delivered',
      title: `Marco entregue: ${f.milestone}`,
      body: `Aprove ou peça revisão até ${f.approvalDue}; depois disso, o marco é aprovado automaticamente. Mensagem: ${f.message}`,
      data: { contractId: f.contractId, milestoneId: f.milestoneId },
    },
  };
}

/** Revisão da entrega única: aviso simples, sem categoria (depois da entrega o prazo não cobra). */
export function revisionNotice(f: {
  contractId: number;
  title: string;
  note: string | null;
}): DeadlineNotice {
  return {
    params: {
      type: 'contract_revision',
      title: `Revisão pedida: ${f.title}`,
      body: f.note,
      data: { contractId: f.contractId },
    },
  };
}

// ---------- Cancelamento (RN-025, RN-026) ----------

/** O aviso à outra parte, conforme a etapa que foi liquidada. */
export function cancelledNotice(f: {
  contractId: number;
  title: string;
  by: 'client' | 'freelancer';
  stage: CancelStage;
  unit: 'BRL' | 'credits' | 'none';
  refundClient: number;
  releaseFreelancer: number;
  /** Por marcos, algum marco foi entregue. */
  partial?: boolean;
}): DeadlineNotice {
  const data = { contractId: f.contractId };
  const barter = 'A contratação fazia parte de uma troca; a troca segue o próprio fluxo.';
  if (f.by === 'freelancer') {
    const body =
      f.unit === 'none'
        ? barter
        : f.unit === 'credits'
          ? `Os ${f.refundClient} créditos voltaram para a sua carteira.`
          : `${brl(f.refundClient)} voltou para a sua carteira.`;
    return {
      params: {
        type: 'contract_cancelled',
        title: `O freelancer desistiu: ${f.title}`,
        body,
        data,
      },
    };
  }
  if (f.stage === 'proposal') {
    return {
      params: {
        type: 'contract_cancelled',
        title: `Proposta retirada: ${f.title}`,
        body: 'O cliente cancelou a proposta antes do aceite.',
        data,
      },
    };
  }
  const split = `${brl(f.releaseFreelancer)} foi liberado na sua carteira e ${brl(f.refundClient)} voltou ao cliente (reembolso de 50%).`;
  const bodies: Record<CancelStage, string> = {
    proposal: '',
    withdrawal: '',
    overdue: f.partial
      ? `O prazo tinha vencido com marcos nunca entregues: ${brl(f.refundClient)}, o que faltava, voltou ao cliente.`
      : `O prazo tinha vencido sem entrega: ${brl(f.refundClient)} voltou ao cliente.`,
    early: split,
    no_deadline: split,
    late: `${brl(f.releaseFreelancer)} foi liberado na sua carteira: mais da metade do tempo até o prazo já tinha passado.`,
    credits: `Os ${f.refundClient} créditos em garantia voltaram ao cliente.`,
    barter,
  };
  return {
    params: {
      type: 'contract_cancelled',
      title: `Contratação cancelada pelo cliente: ${f.title}`,
      body: bodies[f.stage],
      data,
    },
  };
}
