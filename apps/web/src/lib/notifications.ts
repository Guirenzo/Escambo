import type { Notification } from '@escambo/types';

/**
 * Para onde uma notificação leva no app — espelha o link do e-mail no servidor
 * (mail.service notificationLink). null = não há tela específica.
 */
export function notificationPath(data: Notification['data']): string | null {
  const d = data ?? {};
  if (typeof d.contractId === 'number') return `/contratos/${d.contractId}`;
  if (typeof d.savedSearchId === 'number') return `/servicos?busca=${d.savedSearchId}`;
  if (d.barterId != null) return '/trocas';
  if (d.withdrawalId != null || d.paymentId != null || d.depositId != null) return '/carteira';
  if (d.exportRequestId != null || d.deletionRequestId != null) return '/perfil';
  // Conteúdo removido pela moderação (ADR 39 e 44) e decisão da contestação (ADR 41): o perfil é
  // onde a pessoa acompanha. imageRemovalId é a chave das notificações antigas de imagem.
  if (d.contentRemoved != null || d.removalId != null || d.imageRemovalId != null) {
    return '/perfil';
  }
  return null;
}
