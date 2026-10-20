import { messagingRepository } from './messaging.repository';

/**
 * Fachada do módulo messaging para quem está fora dele (RNF-021): a entrega com arquivo acha a
 * conversa da contratação por aqui. Só repassa, com os mesmos argumentos. Gravar os anexos dentro da
 * transação da entrega continua no repository (precisa da mesma conexão), como exceção listada em
 * apps/api/eslint.boundaries.mjs. Folha no grafo, não cria ciclo.
 */
export const messagingFacade = {
  /** A conversa entre as duas pessoas (criada na primeira vez), ligada à contratação. */
  getOrCreate(uidA: number, uidB: number, contractId: number): Promise<number> {
    return messagingRepository.getOrCreate(uidA, uidB, contractId);
  },
};
