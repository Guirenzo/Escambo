import { normalizeTag } from './service-tags';

/**
 * Busca de texto dos serviços (RNF-004/RNF-022) sobre o FULLTEXT ft_svc_search (título e
 * descrição), em BOOLEAN MODE: cada palavra do texto é obrigatória (+) e vale como prefixo (*), então
 * "design" acha "designer" e "logo vetor" só traz o que tem as duas. O InnoDB não guarda no índice as
 * palavras com menos de 3 caracteres (innodb_ft_min_token_size) nem as da lista de palavras vazias;
 * pedir uma delas com + zera a busca. Por isso o texto é lido palavra a palavra:
 *
 * - palavra com parte que o índice guarda: entra no MATCH;
 * - palavra que o índice não guarda ("ux", "3d", "c++"): vira um LIKE "contém", aplicado só nas
 *   linhas que o MATCH já achou (ou em todas, quando nenhuma palavra cabe no índice: o fallback);
 * - palavra com símbolo no meio ou no fim ("node.js", "100%", "snake_case"): as partes entram no
 *   MATCH e a palavra inteira também vira "contém", para o símbolo valer como texto;
 * - palavra vazia ("de", "para", "the"): ignorada, a menos que o texto seja só isso.
 *
 * Pontuação de frase nas pontas da palavra (vírgula, ponto final, aspas, parênteses) e os operadores
 * que alguém digite no começo (+, -, ~) saem antes: "logo," é "logo" e "-design" é "design".
 *
 * As tags (RF-024) entram por fora do FULLTEXT: o texto inteiro, normalizado como tag, é prefixo do
 * nome da tag (o UNIQUE de service_tags.name atende o LIKE 'prefixo%').
 */

/** innodb_ft_min_token_size e innodb_ft_max_token_size (padrão do MySQL 8, os do docker-compose). */
export const FT_MIN_TOKEN = 3;
export const FT_MAX_TOKEN = 84;

/**
 * Palavras que não filtram nada: a lista padrão do InnoDB (INNODB_FT_DEFAULT_STOPWORD, fora do
 * índice) e os artigos, preposições e conjunções mais comuns do português.
 */
const STOPWORDS = new Set(
  [
    'a about an are as at be by com de en for from how i in is it la of on or that the this to und',
    'was what when where who will with www',
    'o e os um uma uns umas da do das dos em na no nas nos ao aos à às por para pra pelo pela pelos',
    'pelas que se ou',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Partes de uma palavra como o InnoDB as separa: letras e números (o "_" faz parte da palavra; ponto,
 * hífen, barra e apóstrofo separam). Fora delas não sobra nenhum operador do BOOLEAN MODE
 * (+ - < > ( ) ~ * " @), então o texto da pessoa nunca vira operador.
 */
const TOKEN = /[\p{L}\p{M}\p{N}_]+/gu;

/** Pontuação de frase e operadores nas pontas; "+" e "#" do fim ficam ("c++", "c#"), "%" também. */
const EDGES = /^[,;:!?.…"'“”‘’()[\]{}<>+\-~*@]+|[,;:!?.…"'“”‘’()[\]{}<>~*@-]+$/gu;
/** Tem algo além de letra e número: o símbolo precisa valer como texto. */
const SYMBOL = /[^\p{L}\p{M}\p{N}]/u;

const charLength = (text: string): number => [...text].length;
const isStopword = (word: string): boolean => STOPWORDS.has(word);
const indexable = (token: string): boolean =>
  charLength(token) >= FT_MIN_TOKEN && charLength(token) <= FT_MAX_TOKEN && !isStopword(token);

export interface TextSearch {
  /** A expressão do MATCH ... AGAINST (... IN BOOLEAN MODE); null quando nada cabe no índice. */
  fulltext: string | null;
  /** Palavras que o índice não guarda: cada uma é um "contém" no título ou na descrição. */
  contains: string[];
  /** O texto inteiro normalizado como tag: prefixo do nome da tag. */
  tagPrefix: string;
}

/** Lê o texto da busca (já sem espaço nas pontas) nas três partes da consulta. */
export function parseTextSearch(q: string): TextSearch {
  const raw = q.normalize('NFC').toLocaleLowerCase('pt-BR').split(/\s+/).filter(Boolean);
  // Só pontuação ("+-()") não sobra palavra: fica como veio, para ser procurada como texto.
  const trimmed = raw.map((word) => word.replace(EDGES, '')).filter(Boolean);
  const words = trimmed.length > 0 ? trimmed : raw;
  const terms = new Set<string>();
  const contains = new Set<string>();
  for (const word of words) {
    if (isStopword(word)) continue;
    const parts = (word.match(TOKEN) ?? []).filter(indexable);
    for (const part of parts) terms.add(part);
    if (parts.length === 0 || SYMBOL.test(word)) contains.add(word);
  }
  // Só palavras vazias: são elas que a pessoa quer achar, como "contém".
  if (terms.size === 0 && contains.size === 0) for (const word of words) contains.add(word);
  return {
    fulltext: terms.size > 0 ? [...terms].map((t) => `+${t}*`).join(' ') : null,
    contains: [...contains],
    tagPrefix: normalizeTag(q),
  };
}
