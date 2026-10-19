import type { SupportCategory, SupportPriority, SupportStatus } from '@escambo/types';

export const SUPPORT_CATEGORY: Record<SupportCategory, string> = {
  payment: 'Pagamento',
  dispute: 'Atendimento sobre uma contratação',
  account: 'Conta',
  fraud: 'Suspeita de fraude',
  other: 'Outro assunto',
};
export const SUPPORT_STATUS: Record<SupportStatus, string> = {
  open: 'Aberto',
  in_progress: 'Em atendimento',
  waiting_user: 'Aguardando você',
  resolved: 'Resolvido',
  closed: 'Encerrado',
};
export const SUPPORT_PRIORITY: Record<SupportPriority, string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
  critical: 'Crítica',
};

export function supportError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'Não foi possível concluir. Tente novamente.';
  const errors: Record<string, string> = {
    ticket_duplicate:
      'Já existe um chamado não encerrado com este assunto, categoria e contratação. Continue a conversa nele.',
    ticket_limit: 'Você já tem 3 chamados não encerrados. Encerre um deles antes de abrir outro.',
    ticket_closed: 'Este chamado já foi encerrado. Abra outro se precisar continuar o atendimento.',
    ticket_not_found: 'Chamado não encontrado ou indisponível para esta conta.',
  };
  return errors[message] ?? message;
}
