import { reportsRepository } from './reports.repository';

/**
 * Fachada do módulo reports para quem está fora dele (RNF-021): o chat abre a denúncia automática
 * (conversa indo para fora do Escambo) por aqui. Só repassa, com os mesmos argumentos. Abrir a
 * revisão de conta dentro da transação das desistências continua no repository (mesma conexão),
 * como exceção listada em apps/api/eslint.boundaries.mjs. Folha no grafo, não cria ciclo.
 */
export const reportsFacade = {
  create(...args: Parameters<typeof reportsRepository.create>): Promise<number> {
    return reportsRepository.create(...args);
  },
};
