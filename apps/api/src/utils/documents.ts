/**
 * CPF e CNPJ (RF-018, RF-020): normalização, dígitos verificadores e máscara. É conferência de
 * FORMATO (o número poderia existir), não consulta à Receita: um CPF válido aqui pode não ser de
 * quem o digitou.
 */

/** Só os dígitos do CPF, como digitado com ou sem máscara; null se não sobrar 11 dígitos. */
export function normalizeCpf(input: string): string | null {
  // Aceita a máscara (pontos, hífen e espaços); letra ou outro caractere invalida.
  if (!/^[\d.\-\s]+$/.test(input)) return null;
  const digits = input.replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

/** Dígito verificador do CPF para os `n` primeiros dígitos (pesos de n+1 a 2, módulo 11). */
function cpfDigit(digits: string, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Number(digits[i]) * (n + 1 - i);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

/** CPF de 11 dígitos com os dois verificadores certos; todos iguais (111.111.111-11) não vale. */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  return cpfDigit(digits, 9) === Number(digits[9]) && cpfDigit(digits, 10) === Number(digits[10]);
}

/** Mascarado para qualquer tela (RN-075): só os 6 do meio aparecem, como em ***.456.789-**. */
export function maskCpf(digits: string): string {
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

/**
 * CNPJ normalizado: sem máscara e em maiúsculas. Aceita o numérico e o alfanumérico da IN RFB
 * 2.229/2024 (vigente desde julho de 2026): as 12 primeiras posições com A–Z ou dígitos, as duas
 * últimas (os verificadores) só dígitos. null se o formato não fecha.
 */
export function normalizeCnpj(input: string): string | null {
  if (!/^[0-9A-Za-z.\-/\s]+$/.test(input)) return null;
  const value = input.replace(/[.\-/\s]/g, '').toUpperCase();
  return /^[0-9A-Z]{12}\d{2}$/.test(value) ? value : null;
}

/**
 * Dígito verificador do CNPJ: cada caractere vale o código ASCII menos 48 (os dígitos valem eles
 * mesmos; A vale 17, Z vale 42), pesos de 2 a 9 da direita para a esquerda, módulo 11.
 */
function cnpjDigit(base: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    sum += (base.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** CNPJ normalizado com os dois verificadores certos; base com tudo igual não vale. */
export function isValidCnpj(value: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value)) return false;
  if (/^(.)\1{11}$/.test(value.slice(0, 12))) return false;
  const first = cnpjDigit(value.slice(0, 12));
  const second = cnpjDigit(value.slice(0, 12) + String(first));
  return value.slice(12) === `${first}${second}`;
}

/** Com a máscara de sempre: 12.ABC.345/01DE-35. O CNPJ é dado público e aparece inteiro. */
export function formatCnpj(value: string): string {
  return `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`;
}

/**
 * Data "AAAA-MM-DD" que existe no calendário (29/02 só em ano bissexto). Devolve as partes, ou null.
 */
export function parseIsoDay(day: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * Idade completa em `today` (os dois em "AAAA-MM-DD", o hoje no fuso da conta): o aniversário
 * conta no próprio dia. Quem nasceu em 29/02 faz anos em 01/03 nos anos comuns.
 */
export function ageOn(birth: string, today: string): number | null {
  const b = parseIsoDay(birth);
  const t = parseIsoDay(today);
  if (!b || !t) return null;
  let age = t.y - b.y;
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) age--;
  return age;
}
