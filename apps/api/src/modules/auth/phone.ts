/**
 * Telefone da conta (RF-017): só números do Brasil, com DDD, guardados em E.164 (+55 DDD número).
 * Aceita o que as pessoas costumam digitar: "(47) 99999-1234", "47 3333-1234", "+55 47 99999 1234",
 * "5547999991234" e o zero de operadora na frente do DDD ("047 99999-1234").
 */

/** DDDs em uso no Brasil (Anatel). Fora da lista, o número não existe. */
export const BRAZIL_AREA_CODES: ReadonlySet<string> = new Set([
  ...['11', '12', '13', '14', '15', '16', '17', '18', '19'], // SP
  ...['21', '22', '24', '27', '28'], // RJ, ES
  ...['31', '32', '33', '34', '35', '37', '38'], // MG
  ...['41', '42', '43', '44', '45', '46', '47', '48', '49'], // PR, SC
  ...['51', '53', '54', '55'], // RS
  ...['61', '62', '63', '64', '65', '66', '67', '68', '69'], // DF, GO, TO, MT, MS, AC, RO
  ...['71', '73', '74', '75', '77', '79'], // BA, SE
  ...['81', '82', '83', '84', '85', '86', '87', '88', '89'], // PE, AL, PB, RN, CE, PI
  ...['91', '92', '93', '94', '95', '96', '97', '98', '99'], // PA, AM, RR, AP, MA
]);

/** O que pode aparecer num número digitado além dos dígitos: espaço, parênteses, hífen e ponto. */
const DECORATION = /[\s().-]/g;

/**
 * Número brasileiro em E.164, ou null se não for um telefone válido do Brasil. Celular tem 11
 * dígitos com o DDD e começa com 9; fixo tem 10 e começa com 2 a 5.
 */
export function normalizeBrazilPhone(input: string): string | null {
  const raw = input.trim().replace(DECORATION, '');
  if (!/^\+?\d+$/.test(raw)) return null;
  let digits = raw.replace(/^\+/, '');
  if (raw.startsWith('+')) {
    // Com o "+", o código do país é obrigatório e só vale o do Brasil.
    if (!digits.startsWith('55')) return null;
    digits = digits.slice(2);
  } else if (digits.length >= 12 && digits.startsWith('55')) {
    digits = digits.slice(2);
  } else if (digits.length >= 11 && digits.startsWith('0')) {
    digits = digits.slice(1); // zero de operadora antes do DDD
  }
  if (digits.length !== 10 && digits.length !== 11) return null;
  if (!BRAZIL_AREA_CODES.has(digits.slice(0, 2))) return null;
  const subscriber = digits.slice(2);
  const ok = subscriber.length === 9 ? subscriber.startsWith('9') : /^[2-5]/.test(subscriber);
  return ok ? `+55${digits}` : null;
}
