import type { QuietPassCategory } from '@escambo/types';
import type { GraceState } from './deadline-grace';

/**
 * Os avisos de prazo estourado a quem entrega, palavra por palavra (ADR 56). Puros: quem emite
 * decide o estado e o fuso; aqui fica o que o aviso diz e se ele pode sair durante o "não
 * perturbe" (categoria 'deadline'). O que importa (até quando, e o que fazer) vem primeiro, porque
 * o aviso no aparelho corta o corpo em 120 caracteres; o prazo original fica no fim.
 */

export interface DeadlineFacts {
  contractId: number;
  /** Título da contratação. */
  title: string;
  /** Prazo original, no fuso de quem recebe ("25/09/2026"). */
  deadline: string;
  /** A única extensão (RN-028) ainda pode ser pedida. */
  extensionFree: boolean;
  /** Contratação por marcos: a entrega é marco a marco, então só a extensão segura a mediação. */
  byMilestones: boolean;
}

export interface DeadlineNotice {
  params: { type: string; title: string; body: string | null; data: { contractId: number } };
  /** Pode sair durante o silêncio de quem marcou (ADR 56); ausente = espera o fim da janela. */
  passCategory?: QuietPassCategory;
}

const data = (f: DeadlineFacts) => ({ contractId: f.contractId });
const MEDIATION = 'senão a mediação abre sozinha';

/**
 * RN-029, fase 1, cópia de quem entrega: a carência começa agora e `limit` é o fim dela no fuso
 * dele. Sai no silêncio de quem marcou sempre que houver o que fazer: registrar a entrega (fora
 * dos marcos) ou pedir a extensão (se ainda livre). Por marcos com a extensão usada não há ação que
 * segure a mediação — o aviso espera, e o texto diz isso.
 */
export function overdueFreelancerNotice(f: DeadlineFacts & { limit: string }): DeadlineNotice {
  const title = `Prazo estourado: ${f.title}`;
  const was = `O prazo era ${f.deadline}.`;
  if (f.byMilestones && !f.extensionFree) {
    return {
      params: {
        type: 'contract_overdue',
        title,
        body: `Sem extensão possível: a mediação abre sozinha a partir de ${f.limit}. Fale com o cliente pelo chat. ${was}`,
        data: data(f),
      },
    };
  }
  const action = f.byMilestones
    ? 'peça a extensão (uma vez)'
    : f.extensionFree
      ? 'entregue ou peça a extensão (uma vez)'
      : 'registre a entrega';
  const used = !f.byMilestones && !f.extensionFree ? ' A extensão já foi usada.' : '';
  return {
    params: {
      type: 'contract_overdue',
      title,
      body: `Até ${f.limit}: ${action}, ${MEDIATION}.${used} ${was}`,
      data: data(f),
    },
    passCategory: 'deadline',
  };
}

/** RN-029, fase 1, cópia do cliente: a disputa abre em nome dele; nada a fazer, nunca sai no silêncio. */
export function overdueClientNotice(f: DeadlineFacts & { limit: string }): DeadlineNotice {
  return {
    params: {
      type: 'contract_overdue',
      title: `Prazo estourado: ${f.title}`,
      body: `Sem entrega nem extensão até ${f.limit}, a mediação do Escambo abre sozinha. O prazo era ${f.deadline} e não houve entrega.`,
      data: data(f),
    },
  };
}

/**
 * Extensão recusada (RN-028). Com a carência correndo e tempo para agir, diz até quando e pode
 * sair no silêncio; acabando, avisa sem acordar; com o prazo no futuro ou sem aviso de atraso, é o
 * aviso de sempre. A recusa não gasta a extensão: dá para pedir de novo.
 */
export function extensionDeclinedNotice(
  f: DeadlineFacts & { grace: GraceState; limit: string | null },
): DeadlineNotice {
  if (f.grace.phase === 'idle' || (f.grace.phase === 'running' && f.limit === null)) {
    return {
      params: {
        type: 'deadline_extension_declined',
        title: 'Extensão de prazo recusada',
        body: `${f.title}: o prazo original continua valendo.`,
        data: data(f),
      },
    };
  }
  const title = `Extensão recusada: ${f.title}`;
  if (f.grace.phase === 'ending') {
    const without = f.byMilestones
      ? 'sem novo pedido de extensão'
      : 'sem entrega nem novo pedido de extensão';
    return {
      params: {
        type: 'deadline_extension_declined',
        title,
        body: `O prazo era ${f.deadline} e a carência acaba em minutos: ${without}, a mediação abre sozinha.`,
        data: data(f),
      },
    };
  }
  const action = f.byMilestones ? 'peça a extensão de novo' : 'entregue ou peça a extensão de novo';
  return {
    params: {
      type: 'deadline_extension_declined',
      title,
      body: `Prazo vencido. Até ${f.limit}: ${action}, ${MEDIATION}. O prazo era ${f.deadline}.`,
      data: data(f),
    },
    passCategory: 'deadline',
  };
}

/**
 * Revisão pedida (só na contratação de entrega única; marcos têm a própria). Com a carência
 * correndo, diz até quando registrar a nova entrega; o resto como na recusa.
 */
export function revisionNotice(
  f: DeadlineFacts & { grace: GraceState; limit: string | null },
): DeadlineNotice {
  if (f.grace.phase === 'idle' || (f.grace.phase === 'running' && f.limit === null)) {
    return {
      params: { type: 'contract_revision', title: 'Revisão solicitada', body: null, data: data(f) },
    };
  }
  const title = `Revisão pedida: ${f.title}`;
  if (f.grace.phase === 'ending') {
    const without = f.extensionFree
      ? 'sem nova entrega nem pedido de extensão'
      : 'sem nova entrega';
    return {
      params: {
        type: 'contract_revision',
        title,
        body: `O prazo era ${f.deadline} e a carência acaba em minutos: ${without}, a mediação abre sozinha.`,
        data: data(f),
      },
    };
  }
  const action = f.extensionFree
    ? 'registre a nova entrega ou peça a extensão'
    : 'registre a nova entrega';
  const used = f.extensionFree ? '' : ' A extensão já foi usada.';
  return {
    params: {
      type: 'contract_revision',
      title,
      body: `Prazo vencido. Até ${f.limit}: ${action}, ${MEDIATION}.${used} O prazo era ${f.deadline}.`,
      data: data(f),
    },
    passCategory: 'deadline',
  };
}
