import { pushRepository } from './push.repository';

/**
 * Fachada do módulo notifications para quem está fora dele (RNF-021): a troca de senha e o "sair de
 * todos os aparelhos" tiram as assinaturas de push por aqui. Só repassa, com os mesmos argumentos, e
 * não importa nada além do próprio repository: o pushService lê a conta pelo auth, e o auth chamando
 * o pushService criaria ciclo.
 */
export const notificationsFacade = {
  /** Remove todas as assinaturas de push da pessoa. Devolve quantas removeu. */
  removeAllPushSubscriptions(userId: number): Promise<number> {
    return pushRepository.removeAllForUser(userId);
  },
};
