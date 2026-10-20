import { settingsRepository } from './settings.repository';

/**
 * Fachada do módulo settings para quem está fora dele (RNF-021): leitura na hora, sem o cache curto
 * do settingsService, e o estado que os jobs guardam numa chave. Só repassa ao repository, com os
 * mesmos argumentos, então quem lia por lá continua lendo o mesmo valor, com o próprio padrão. Não
 * importa nada além do próprio repository: é folha no grafo e não cria ciclo.
 */
export const settingsFacade = {
  /** Número da chave lido agora; o padrão de quem pergunta quando falta ou está em branco. */
  getNumber(key: string, fallback: number): Promise<number> {
    return settingsRepository.getNumber(key, fallback);
  },

  /** Valor cru da chave (null se não existe): o estado que um job guardou. */
  get(key: string): Promise<string | null> {
    return settingsRepository.get(key);
  },

  /** Grava (ou cria) a chave com um JSON: o estado de job que sobrevive a reinícios. */
  setJson(key: string, value: string): Promise<void> {
    return settingsRepository.set(key, value, 'json');
  },
};
