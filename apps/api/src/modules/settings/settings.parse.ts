import { SETTING_DEFS } from './settings.schema';

/**
 * Número gravado numa chave de `platform_settings`, ou `fallback` quando ela não tem valor:
 * ausente, em branco (Number('') seria 0: prazo zero em vez do padrão) ou que não é número. As duas
 * leituras de número (settingsRepository.getNumber, dos jobs, e o settingsService, da tela) passam
 * por aqui, para a mesma chave não ter dois valores.
 */
export function parseNumberSetting(
  raw: string | null | undefined,
  fallback: number,
  key?: string,
): number {
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  // As duas contagens da ADR 61 têm faixa fechada. Dado antigo ou escrito fora do painel
  // não pode reduzir direitos, inventar um prazo nem derrubar o reparo com RangeError.
  // As outras chaves conservam a leitura legada, inclusive zero e valores decimais.
  if (key === 'counter_offer_response_hours' || key === 'extension_response_hours') {
    const def = SETTING_DEFS[key];
    return Number.isInteger(n) && n >= def.min && n <= def.max ? n : (def.defaultValue as number);
  }
  return Number.isFinite(n) ? n : fallback;
}
