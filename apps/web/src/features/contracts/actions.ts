import type { Contract } from '@escambo/types';

/**
 * Ações que o usuário logado pode executar numa contratação, dado o status e o seu papel
 * (cliente ou freelancer) — a mesma lista alimenta a tabela do Início e a Sala do contrato.
 * Espelha as regras da API (quem pode aceitar, entregar, aprovar…), para não oferecer botão
 * que o servidor vai recusar.
 */

export type ContractActionKey =
  'accept' | 'reject' | 'deliver' | 'approve' | 'revision' | 'cancel' | 'review';

export interface ContractAction {
  key: ContractActionKey;
  label: string;
  /** Aparência do botão. */
  tone: 'primary' | 'secondary' | 'danger';
  /** Pede um texto ao usuário antes de executar (mensagem da entrega / motivo da revisão). */
  prompt?: string;
}

export type Party = 'client' | 'freelancer' | 'none';

export function partyOf(c: Pick<Contract, 'clientId' | 'freelancerId'>, userId: number): Party {
  if (c.clientId === userId) return 'client';
  if (c.freelancerId === userId) return 'freelancer';
  return 'none';
}

export function contractActions(
  c: Pick<Contract, 'clientId' | 'freelancerId' | 'status' | 'hasReview'>,
  userId: number,
): ContractAction[] {
  const party = partyOf(c, userId);
  if (party === 'none') return [];

  switch (c.status) {
    case 'pending':
      return party === 'freelancer'
        ? [
            { key: 'accept', label: 'Aceitar', tone: 'primary' },
            { key: 'reject', label: 'Recusar', tone: 'danger' },
          ]
        : [{ key: 'cancel', label: 'Cancelar proposta', tone: 'danger' }];

    case 'accepted':
    case 'in_progress':
    case 'revision_requested':
      return party === 'freelancer'
        ? [
            {
              key: 'deliver',
              label: c.status === 'revision_requested' ? 'Entregar revisão' : 'Registrar entrega',
              tone: 'primary',
              prompt: 'Mensagem da entrega (o que foi feito, onde está):',
            },
          ]
        : [{ key: 'cancel', label: 'Cancelar', tone: 'danger' }];

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
          ]
        : [];

    case 'completed':
      return party === 'client' && !c.hasReview
        ? [{ key: 'review', label: 'Avaliar', tone: 'secondary' }]
        : [];

    default:
      return [];
  }
}
