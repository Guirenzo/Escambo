import { servicesRepository, type ServiceRow } from './services.repository';

/**
 * Fachada do módulo services para quem está fora dele (RNF-021): o impulsionamento e a contratação
 * conferem o serviço por aqui, e não pelo repository. Só repassa, com os mesmos argumentos, e não
 * importa nada além do próprio repository: é folha no grafo e não cria ciclo.
 */
export const servicesFacade = {
  /** O serviço não excluído. */
  findById(id: number): Promise<ServiceRow | undefined> {
    return servicesRepository.findById(id);
  },
};
