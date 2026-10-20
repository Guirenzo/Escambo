import { reviewsRepository, type ReviewListRow } from './reviews.repository';

/**
 * Fachada do módulo reviews para quem está fora dele (RNF-021): a contratação mostra a avaliação
 * dela por aqui. Só repassa, com os mesmos argumentos. Tirar a avaliação do ar dentro da transação
 * da moderação continua no repository (mesma conexão), como exceção listada em
 * apps/api/eslint.boundaries.mjs. Folha no grafo, não cria ciclo.
 */
export const reviewsFacade = {
  findByContractIdWithResponse(contractId: number): Promise<ReviewListRow | undefined> {
    return reviewsRepository.findByContractIdWithResponse(contractId);
  },
};
