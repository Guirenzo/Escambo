import { contractsRepository, type ContractRow } from './contracts.repository';
import { milestonesRepository } from './milestones.repository';

/**
 * Fachada do módulo contracts para quem está fora dele (RNF-021): troca, disputa, chat, avaliação e
 * admin leem a contratação por aqui, e não pelo repository. Só repassa, com os mesmos argumentos, e
 * não importa nada além dos próprios repositories: é folha no grafo. O contractsService não serve
 * para isso porque importa troca, chat e avaliação, e a chamada de volta criaria ciclo. Quem precisa
 * ler dentro da própria transação (a disputa) continua no repository, como exceção listada em
 * apps/api/eslint.boundaries.mjs.
 */
export const contractsFacade = {
  /** A contratação, fora de transação (sem a conexão de quem chama). */
  findById(id: number): Promise<ContractRow | undefined> {
    return contractsRepository.findById(id);
  },

  /** O que ainda está retido nos marcos abertos (null quando a contratação não tem marcos). */
  escrowRemaining(contractId: number): Promise<{ price: number; net: number } | null> {
    return milestonesRepository.escrowRemaining(contractId);
  },
};
