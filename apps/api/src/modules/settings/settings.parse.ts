/**
 * Número gravado numa chave de `platform_settings`, ou `fallback` quando ela não tem valor:
 * ausente, em branco (Number('') seria 0: prazo zero em vez do padrão) ou que não é número. As duas
 * leituras de número (settingsRepository.getNumber, dos jobs, e o settingsService, da tela) passam
 * por aqui, para a mesma chave não ter dois valores.
 */
export function parseNumberSetting(raw: string | null | undefined, fallback: number): number {
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
