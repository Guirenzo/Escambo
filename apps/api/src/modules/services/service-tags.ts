import { z } from 'zod';

/** RN-018: no máximo 10 tags por serviço, cada uma com 2 a 30 caracteres (depois do trim). */
export const MAX_TAGS = 10;
export const TAG_MIN_LENGTH = 2;
export const TAG_MAX_LENGTH = 30;

/**
 * Letras (com acento), números, espaço e os símbolos dos nomes técnicos: c++, c#, node.js, ui/ux,
 * e-commerce, snake_case. Aspas, vírgula e os operadores da busca ficam de fora.
 */
const TAG_CHARS = /^[\p{L}\p{M}\p{N} +#./_-]+$/u;

/** Tamanho em caracteres (pontos de código), como o VARCHAR do MySQL conta: "ç" vale 1. */
const length = (text: string): number => [...text].length;

/**
 * A forma gravada e exibida: Unicode composto (NFC), sem espaço nas pontas, espaços internos
 * reduzidos a um e tudo em minúsculas. Os acentos ficam ("programação" continua com til).
 */
export function normalizeTag(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

/**
 * Chave de comparação: a tag normalizada sem acentos. É como o banco compara (collation
 * utf8mb4_unicode_ci, sem caixa e sem acento), então "Programação" e "programacao" são a mesma tag
 * tanto aqui quanto no UNIQUE de service_tags.name.
 */
export function tagKey(tag: string): string {
  return normalizeTag(tag).normalize('NFD').replace(/\p{M}/gu, '');
}

/** O slug (service_tags.slug): a chave com hífen no lugar do espaço. */
export const tagSlug = (tag: string): string => tagKey(tag).replace(/ /g, '-');

/**
 * As tags de um serviço como a API aceita no cadastro e na edição: normalizadas, de 2 a 30
 * caracteres, só com os caracteres permitidos, no máximo 10 e sem repetir (a repetição é comparada
 * pela chave, sem caixa e sem acento). Lista vazia tira todas as tags.
 */
export const tagsSchema = z
  .array(
    z
      .string({ invalid_type_error: 'Cada tag é um texto' })
      .max(200, `Cada tag tem de ${TAG_MIN_LENGTH} a ${TAG_MAX_LENGTH} caracteres (RN-018)`),
    { invalid_type_error: 'Envie as tags como lista de textos' },
  )
  .max(MAX_TAGS, `No máximo ${MAX_TAGS} tags por serviço (RN-018)`)
  .transform((tags) => tags.map(normalizeTag))
  .superRefine((tags, ctx) => {
    const seen = new Set<string>();
    tags.forEach((tag, i) => {
      if (length(tag) < TAG_MIN_LENGTH || length(tag) > TAG_MAX_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: `Cada tag tem de ${TAG_MIN_LENGTH} a ${TAG_MAX_LENGTH} caracteres (RN-018)`,
        });
        return;
      }
      if (!TAG_CHARS.test(tag)) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: 'Tag só com letras, números, espaço e + # . / _ -',
        });
        return;
      }
      const key = tagKey(tag);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: [i], message: `Tag repetida: "${tag}"` });
      }
      seen.add(key);
    });
  });
