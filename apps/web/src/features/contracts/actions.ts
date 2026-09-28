import type { Contract } from '@escambo/types';

/**
 * Ações que o usuário logado pode executar numa contratação, dado o status e o seu papel
 * (cliente ou freelancer) — a mesma lista alimenta a tabela do Início e a Sala do contrato.
 * Espelha as regras da API (quem pode aceitar, entregar, aprovar…), para não oferecer botão
 * que o servidor vai recusar.
 */

export type ContractActionKey =
  'accept' | 'reject' | 'deliver' | 'approve' | 'revision' | 'cancel' | 'review' | 'dispute';

export interface ContractAction {
  key: ContractActionKey;
  label: string;
  /** Aparência do botão. */
  tone: 'primary' | 'secondary' | 'danger';
  /** Pede um texto ao usuário antes de executar (mensagem da entrega / motivo da revisão). */
  prompt?: string;
}

export type Party = 'client' | 'freelancer' | 'none';

/** Estados em que qualquer das partes pode acionar a mediação da plataforma. */
export const DISPUTABLE_STATUSES = ['accepted', 'in_progress', 'delivered', 'revision_requested'];

const DISPUTE: ContractAction = { key: 'dispute', label: 'Abrir disputa', tone: 'danger' };
/** O cliente cancela; o freelancer desiste (ADR 57): tudo em garantia volta ao cliente. */
const CANCEL: ContractAction = { key: 'cancel', label: 'Cancelar', tone: 'danger' };
const WITHDRAW: ContractAction = { key: 'cancel', label: 'Desistir', tone: 'danger' };

export function partyOf(c: Pick<Contract, 'clientId' | 'freelancerId'>, userId: number): Party {
  if (c.clientId === userId) return 'client';
  if (c.freelancerId === userId) return 'freelancer';
  return 'none';
}

export function contractActions(
  c: Pick<
    Contract,
    'clientId' | 'freelancerId' | 'status' | 'hasReview' | 'hasMilestones' | 'deadlineAt'
  >,
  userId: number,
  now: number = Date.now(),
): ContractAction[] {
  const party = partyOf(c, userId);
  if (party === 'none') return [];

  // Por marcos (RN-069): entrega e aprovação acontecem marco a marco, na Sala.
  if (c.hasMilestones && (c.status === 'accepted' || c.status === 'in_progress')) {
    return party === 'freelancer' ? [WITHDRAW, DISPUTE] : [CANCEL, DISPUTE];
  }

  const deliver = (label: string): ContractAction => ({
    key: 'deliver',
    label,
    tone: 'primary',
    prompt: 'Mensagem da entrega (o que foi feito, onde está):',
  });

  switch (c.status) {
    case 'pending': {
      // Com o prazo de entrega já vencido, a proposta não se aceita (ADR 57): só recusar.
      const expired = c.deadlineAt !== null && new Date(c.deadlineAt).getTime() <= now;
      const reject: ContractAction = { key: 'reject', label: 'Recusar', tone: 'danger' };
      return party === 'freelancer'
        ? expired
          ? [reject]
          : [{ key: 'accept', label: 'Aceitar', tone: 'primary' }, reject]
        : [{ key: 'cancel', label: 'Cancelar proposta', tone: 'danger' }];
    }

    case 'accepted':
    case 'in_progress':
      return party === 'freelancer'
        ? [deliver('Registrar entrega'), WITHDRAW, DISPUTE]
        : [CANCEL, DISPUTE];

    // Depois da entrega não se cancela (ADR 57): o cliente aprova, pede revisão ou disputa.
    case 'revision_requested':
      return party === 'freelancer' ? [deliver('Entregar revisão'), DISPUTE] : [DISPUTE];

    case 'delivered':
      return party === 'client'
        ? [
            { key: 'approve', label: 'Aprovar entrega', tone: 'primary' },
            {
              key: 'revision',
              label: 'Pedir revisão',
              tone: 'secondary',
              prompt: 'O que precisa ser ajustado?',
            },
            DISPUTE,
          ]
        : [DISPUTE];

    case 'completed':
      return party === 'client' && !c.hasReview
        ? [{ key: 'review', label: 'Avaliar', tone: 'secondary' }]
        : [];

    default:
      return [];
  }
}
