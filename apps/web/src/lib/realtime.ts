import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { Notification } from '@escambo/types';
import { qk } from './hooks';
import { getSocket } from './socket';
import { useToast } from './toast';

/**
 * Mantém o app vivo em qualquer tela: notificações chegam pelo socket (sala `user:<id>`),
 * atualizam o badge do menu, avisam com um toast e invalidam o que mudou (contratações,
 * carteira, trocas, avaliações) — sem esperar o polling.
 */
export function useRealtimeNotifications(): void {
  const qc = useQueryClient();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    const socket = getSocket();
    const onNotification = (n: Notification): void => {
      void qc.invalidateQueries({ queryKey: qk.notifications });
      if (n.type.startsWith('contract_') || n.type.startsWith('milestone_')) {
        void qc.invalidateQueries({ queryKey: qk.contracts });
        void qc.invalidateQueries({ queryKey: ['contract'] });
        void qc.invalidateQueries({ queryKey: qk.wallet });
        void qc.invalidateQueries({ queryKey: qk.gamification });
      }
      if (n.type.startsWith('barter_')) {
        void qc.invalidateQueries({ queryKey: qk.barters });
        void qc.invalidateQueries({ queryKey: qk.contracts });
      }
      if (n.type.startsWith('deposit_') || n.type.startsWith('withdrawal_')) {
        void qc.invalidateQueries({ queryKey: qk.wallet });
        void qc.invalidateQueries({ queryKey: qk.walletTransactions });
        void qc.invalidateQueries({ queryKey: qk.deposits });
        void qc.invalidateQueries({ queryKey: qk.withdrawals });
        void qc.invalidateQueries({ queryKey: ['deposit'] });
      }
      if (n.type === 'export_ready' || n.type.startsWith('deletion_')) {
        void qc.invalidateQueries({ queryKey: qk.exportRequests });
        void qc.invalidateQueries({ queryKey: qk.deletionRequests });
      }
      if (n.type === 'review_received') {
        void qc.invalidateQueries({ queryKey: qk.profiles });
        void qc.invalidateQueries({ queryKey: ['reviews'] });
      }
      // Mensagem de chat com a sala aberta já aparece no próprio chat; o resto avisa.
      const inRoom =
        n.type === 'chat_message' && window.location.pathname.startsWith('/contratos/');
      if (!inRoom) toastRef.current.info(n.title);
    };
    socket.on('notification:new', onNotification);
    return () => {
      socket.off('notification:new', onNotification);
    };
  }, [qc]);
}
