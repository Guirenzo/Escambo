import {
  profilesRepository,
  type CompanyData,
  type FreelancerRow,
  type PayoutStateRow,
} from './profiles.repository';

/**
 * Fachada do módulo profiles para quem está fora dele (RNF-021): a contratação confere o perfil de
 * freelancer, o chat atualiza o tempo de resposta, o saque confere o CPF (RF-020) e o cadastro de
 * empresa grava o perfil da empresa (RF-018) por aqui. Só repassa, com os mesmos argumentos, e
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

  /** Para o saque (RF-020): a conta entrega trabalho (ADR 56) e o CPF está validado. */
  payoutState(userId: number): Promise<PayoutStateRow | undefined> {
    return profilesRepository.payoutState(userId);
  },

  /** O CNPJ já é de alguma conta? (o cadastro de empresa confere antes de criar a conta) */
  cnpjTaken(cnpj: string): Promise<boolean> {
    return profilesRepository.cnpjTaken(cnpj);
  },

  /** O perfil da empresa no cadastro (RF-018); CNPJ repetido estoura a chave única. */
  createCompany(userId: number, data: CompanyData): Promise<void> {
    return profilesRepository.createCompany(userId, data);
  },
};
