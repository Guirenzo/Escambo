/**
 * Varreduras de texto em tempo linear, no lugar de regex com retrocesso (Sonar S8786). Parte do
 * texto vem de quem usa o sistema (caminho da URL, mensagem de chat, termo de busca), e uma regex
 * sem âncora que começa com repetição, como /\/+$/ ou /[\w.+-]+@…/, pode levar tempo quadrático
 * numa entrada longa montada para isso. Cada função aqui lê o texto uma vez e dá o mesmo resultado
 * da regex que substituiu (os testes comparam as duas).
 */

/** Tira as repetições de `char` do fim do texto: o mesmo que `.replace(/x+$/, '')`. */
export function trimEndChar(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** `[\w-]`: letra ou número ASCII, "_" ou "-". */
function isDomainChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 45 // -
  );
}

/** `[\w.+-]`: o que pode vir antes do "@". */
function isLocalChar(code: number): boolean {
  return isDomainChar(code) || code === 46 || code === 43; // . +
}

/** Fim do rótulo `[\w-]*` que começa em `i`. */
function labelEnd(text: string, i: number): number {
  let pos = i;
  while (isDomainChar(text.charCodeAt(pos))) pos++;
  return pos;
}

/** Fim do domínio que começa em `i` (`[\w-]+(?:\.[\w-]+)+`), ou -1 quando não há um. */
function domainEnd(text: string, i: number): number {
  let pos = labelEnd(text, i);
  if (pos === i) return -1;
  let end = -1;
  while (text.charCodeAt(pos) === 46) {
    const next = labelEnd(text, pos + 1);
    if (next === pos + 1) break;
    pos = next;
    end = pos;
  }
  return end;
}

/**
 * Onde estão os e-mails do texto, como [início, fim): a mesma leitura de
 * `/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g` (o mais à esquerda primeiro, sem sobreposição).
 */
export function findEmails(text: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  let from = 0; // fim do último e-mail achado: o próximo só começa daí em diante
  let at = text.indexOf('@');
  while (at !== -1) {
    let start = at;
    while (start > from && isLocalChar(text.charCodeAt(start - 1))) start--;
    const end = start < at ? domainEnd(text, at + 1) : -1;
    if (end !== -1) {
      found.push([start, end]);
      from = end;
    }
    at = text.indexOf('@', Math.max(at + 1, from));
  }
  return found;
}

/** O texto tem um e-mail? */
export function containsEmail(text: string): boolean {
  return findEmails(text).length > 0;
}

/** Troca cada e-mail do texto por `replacement`. */
export function replaceEmails(text: string, replacement: string): string {
  const found = findEmails(text);
  if (found.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const [start, end] of found) {
    out += text.slice(pos, start) + replacement;
    pos = end;
  }
  return out + text.slice(pos);
}
