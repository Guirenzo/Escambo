import { adminRepository } from './admin.repository';

/**
 * Fachada do módulo admin para quem está fora dele (RNF-021): o saque, a moderação e os
 * controllers registram a ação do admin por aqui, e não pelo repository. Só repassa, com os mesmos
 * argumentos, e não importa nada além do próprio repository: é folha no grafo e não cria ciclo. A
 * regra que obriga está em apps/api/eslint.boundaries.mjs.
 */
export const adminFacade = {
  /** Trilha das ações do admin (tabela admin_actions). */
  recordAction(
    adminId: number,
    action: string,
    targetType: string | null,
    targetId: number | null,
    description: string | null,
  ): Promise<void> {
    return adminRepository.recordAction(adminId, action, targetType, targetId, description);
  },
};
