import { lgpdRepository } from './lgpd.repository';

/**
 * Fachada do módulo lgpd para quem está fora dele (RNF-021): o cadastro grava o aceite dos termos
 * por aqui, e não pelo repository. Só repassa, com os mesmos argumentos, e não importa nada além do
 * próprio repository (o lgpdService importa notificações e o chat, e o cadastro não precisa disso).
 */
export const lgpdFacade = {
  recordConsent(...args: Parameters<typeof lgpdRepository.recordConsent>): Promise<void> {
    return lgpdRepository.recordConsent(...args);
  },
};
