/**
 * Tags do serviço (RF-024, RN-018), com as mesmas regras da API (service-tags.ts): no máximo 10,
 * de 2 a 30 caracteres depois do trim, só letras, números, espaço e + # . / _ -, sem repetir.
 * A tela confere antes de mandar; a API confere de novo.
 */
export const MAX_TAGS = 10;
export const TAG_MIN_LENGTH = 2;
export const TAG_MAX_LENGTH = 30;

const TAG_CHARS = /^[\p{L}\p{M}\p{N} +#./_-]+$/u;

/** Como a API grava: sem espaço nas pontas, espaços internos reduzidos, em minúsculas. */
export function normalizeTag(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

/** Chave de comparação, sem caixa e sem acento (como o banco compara). */
export function tagKey(tag: string): string {
  return normalizeTag(tag).normalize('NFD').replace(/\p{M}/gu, '');
}

/** Por que a tag não entra na lista atual; null = entra. */
export function tagProblem(tag: string, current: string[]): string | null {
  const size = [...tag].length;
  if (size < TAG_MIN_LENGTH || size > TAG_MAX_LENGTH) {
    return `Cada tag tem de ${TAG_MIN_LENGTH} a ${TAG_MAX_LENGTH} caracteres.`;
  }
  if (!TAG_CHARS.test(tag)) return 'Use só letras, números, espaço e + # . / _ -';
  if (current.some((t) => tagKey(t) === tagKey(tag))) return `A tag "${tag}" já está na lista.`;
  if (current.length >= MAX_TAGS) return `No máximo ${MAX_TAGS} tags por serviço.`;
  return null;
}

/** Link da busca por uma tag (a busca de texto também acha pelas tags). */
export const tagSearchPath = (tag: string): string => `/servicos?q=${encodeURIComponent(tag)}`;
