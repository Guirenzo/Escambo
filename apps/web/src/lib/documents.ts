import type { MyProfiles } from '@escambo/types';
import { displayName } from './format';

/**
 * CPF e CNPJ na tela (RF-018, RF-020): a mesma conferência de formato da API (apps/api/src/utils/
 * documents.ts), para avisar no campo antes de enviar. Quem decide é a API; aqui é só para a
 * pessoa não esperar a volta do servidor para saber que errou um dígito.
 */

const cpfDigit = (digits: string, n: number): number => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Number(digits[i]) * (n + 1 - i);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
};

/** CPF com ou sem máscara: 11 dígitos, verificadores certos, não todos iguais. */
export function isValidCpf(input: string): boolean {
  if (!/^[\d.\-\s]+$/.test(input)) return false;
  const d = input.replace(/\D/g, '');
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  return cpfDigit(d, 9) === Number(d[9]) && cpfDigit(d, 10) === Number(d[10]);
}

/** A máscara do CPF enquanto se digita: 529.982.247-25 (só os dígitos contam). */
export function formatCpfTyping(input: string): string {
  const d = input.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** CNPJ sem máscara e em maiúsculas (aceita o alfanumérico da IN RFB 2.229/2024); null se não fecha. */
export function normalizeCnpj(input: string): string | null {
  if (!/^[0-9A-Za-z.\-/\s]+$/.test(input)) return null;
  const value = input.replace(/[.\-/\s]/g, '').toUpperCase();
  return /^[0-9A-Z]{12}\d{2}$/.test(value) ? value : null;
}

/** Cada caractere vale o código ASCII menos 48; pesos de 2 a 9 da direita para a esquerda. */
const cnpjDigit = (base: string): number => {
  let sum = 0;
  let weight = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    sum += (base.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
};

/** CNPJ com ou sem máscara, numérico ou alfanumérico, com os dois verificadores certos. */
export function isValidCnpj(input: string): boolean {
  const value = normalizeCnpj(input);
  if (!value || /^(.)\1{11}$/.test(value.slice(0, 12))) return false;
  const first = cnpjDigit(value.slice(0, 12));
  return value.slice(12) === `${first}${cnpjDigit(value.slice(0, 12) + String(first))}`;
}

/** O CNPJ com a máscara de sempre (12.ABC.345/01DE-35); o que não tem 14 caracteres sai como veio. */
export function formatCnpj(value: string): string {
  if (!/^[0-9A-Z]{14}$/.test(value)) return value;
  return `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`;
}

/**
 * Nome e foto de quem está logado: a empresa (o nome fantasia e o logo) na conta de empresa; nas
 * outras, o perfil de freelancer, senão o de cliente.
 */
export function profileIdentity(p: MyProfiles | undefined): {
  name: string | undefined;
  avatarUrl: string | null;
} {
  if (p?.company) return { name: p.company.tradeName, avatarUrl: p.company.logoUrl };
  const base = p?.freelancer ?? p?.client;
  return { name: base?.fullName, avatarUrl: base?.avatarUrl ?? null };
}

/**
 * O nome curto de quem está logado (o cumprimento, a lateral, o cartão da carteira): o primeiro nome
 * da pessoa, mas o nome fantasia inteiro da empresa ("Pão Bom", e não "Pão").
 */
export function identityName(p: MyProfiles | undefined, email: string | undefined): string {
  if (p?.company) return p.company.tradeName;
  return displayName(profileIdentity(p).name, email);
}
