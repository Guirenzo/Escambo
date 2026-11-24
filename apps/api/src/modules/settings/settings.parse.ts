/**
 * Conversão do valor de um parâmetro numérico (função pura do módulo settings, sem banco).
 * No banco o valor é texto; aqui ele vira número, com o padrão quando falta ou é inválido.
 * Fica num arquivo próprio porque as duas leituras usam a mesma regra: o settingsRepository
 * (getNumber, lido pelos jobs pela fachada) e o settingsService (com cache, lido pela tela).
 * Dentro: a lista das chaves de faixa fechada e o parseNumberSetting.
 */
import { SETTING_DEFS, type SettingKey } from './settings.schema';

/**
 * Chaves de faixa fechada: as duas contagens da ADR 61 e os prazos de saque (RN-035). Prazo em dias
 * úteis fora de 1..10, quebrado ou negativo travaria o pedido de saque (RangeError) ou prometeria
 * um prazo que ninguém configurou. A previsão de volta da manutenção (RNF-010) também: negativa
 * daria uma hora no passado.
 */
const CLOSED_RANGE_KEYS: readonly SettingKey[] = [
  'counter_offer_response_hours',
  'extension_response_hours',
  'withdrawal_pix_business_days',
  'withdrawal_bank_business_days',
  'maintenance_return_minutes',
];
// Diz se a chave está na lista acima. O `key is SettingKey` avisa ao TypeScript que, quando a
// resposta é verdadeira, a chave é uma SettingKey e pode indexar o SETTING_DEFS.
const isClosedRangeKey = (key: string | undefined): key is SettingKey =>
  key !== undefined && (CLOSED_RANGE_KEYS as readonly string[]).includes(key);

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
  // Ausente ou em branco vira NaN (não é número), para cair no padrão logo abaixo.
  const n = raw == null || raw.trim() === '' ? Number.NaN : Number(raw);
  // As duas contagens da ADR 61 têm faixa fechada. Dado antigo ou escrito fora do painel
  // não pode reduzir direitos, inventar um prazo nem derrubar o reparo com RangeError.
  // Os prazos de saque (RN-035) também. As outras chaves conservam a leitura legada,
  // inclusive zero e valores decimais.
  if (isClosedRangeKey(key)) {
    const def = SETTING_DEFS[key];
    return Number.isInteger(n) && n >= def.min && n <= def.max ? n : (def.defaultValue as number);
  }
  // Demais chaves: qualquer número finito vale; NaN ou infinito vira o padrão de quem perguntou.
  return Number.isFinite(n) ? n : fallback;
}
