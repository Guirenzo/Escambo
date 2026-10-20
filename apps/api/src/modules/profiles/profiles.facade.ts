import { profilesRepository, type FreelancerRow } from './profiles.repository';

/**
 * Fachada do módulo profiles para quem está fora dele (RNF-021): a contratação confere o perfil de
 * freelancer e o chat atualiza o tempo de resposta por aqui. Só repassa, com os mesmos argumentos, e
 * não importa nada além do próprio repository: é folha no grafo e não cria ciclo.
 */
export const profilesFacade = {
  findFreelancerByUserId(userId: number): Promise<FreelancerRow | undefined> {
    return profilesRepository.findFreelancerByUserId(userId);
  },

  /** Mistura a nova medida de resposta (em horas) na média do perfil. */
  blendResponseTime(userId: number, hours: number): Promise<void> {
    return profilesRepository.blendResponseTime(userId, hours);
  },
};
