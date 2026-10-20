import { dropoutsRepository, type FullDropoutRow } from './dropouts.repository';

/**
 * Fachada do módulo dropouts para quem está fora dele (RNF-021): a contratação lê as desistências
 * por aqui para mostrar a prévia do cancelamento e o prazo de acordo. Só repassa, sem conexão de
 * fora: a contagem que decide dentro da transação do cancelamento continua no repository, como
 * exceção listada em apps/api/eslint.boundaries.mjs. Folha no grafo, não cria ciclo.
 */
export const dropoutsFacade = {
  findByContractId(contractId: number): Promise<FullDropoutRow | undefined> {
    return dropoutsRepository.findByContractId(contractId);
  },

  /** As desistências que contam na janela de 60 dias do freelancer, até `now`. */
  listCounting(uid: number, now: Date): Promise<FullDropoutRow[]> {
    return dropoutsRepository.listCounting(uid, now);
  },
};
