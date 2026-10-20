import { disputesRepository, type DisputeRow } from './disputes.repository';

/**
 * Fachada do módulo disputes para quem está fora dele (RNF-021): a contratação abre a disputa do
 * prazo vencido e o admin lista e resolve por aqui, e não pelo repository. Só repassa, com os mesmos
 * argumentos: a transação de cada operação (o congelamento do escrow na abertura, a divisão do
 * escrow na resolução, ADR 2) continua inteira dentro do repository, sem conexão de fora. Não importa
 * nada além do próprio repository: é folha no grafo e não cria ciclo.
 */
export const disputesFacade = {
  /** Abre a disputa (com a guarda de quem chama); null se a guarda ou o status não deixaram. */
  create(...args: Parameters<typeof disputesRepository.create>) {
    return disputesRepository.create(...args);
  },

  findById(id: number): Promise<DisputeRow | undefined> {
    return disputesRepository.findById(id);
  },

  listOpen(): Promise<DisputeRow[]> {
    return disputesRepository.listOpen();
  },

  /** Resolve aplicando a decisão de escrow em uma transação; false se a disputa já mudou. */
  resolve(...args: Parameters<typeof disputesRepository.resolve>) {
    return disputesRepository.resolve(...args);
  },
};
