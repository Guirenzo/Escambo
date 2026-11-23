import type { OffPlatformSignal } from '@escambo/types';

/**
 * Detecção de negociação por fora no chat (ADR 45), espelho de
 * apps/api/src/modules/messaging/off-platform.ts: aqui ela só mostra o aviso enquanto a pessoa
 * digita; quem decide o que fica gravado e vai para a moderação é a API. Mudou lá, muda aqui (os
 * testes dos dois lados cobrem os mesmos exemplos).
 */

export const OFF_PLATFORM_LABEL: Record<OffPlatformSignal, string> = {
  pix: 'Pix',
  phone: 'telefone',
  email: 'e-mail',
  whatsapp: 'WhatsApp',
  off_platform: 'negociar por fora',
};

const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const VERBS =
  '(?:paga|pagar|pague|pagando|manda|mandar|mande|envia|enviar|faz|fazer|transfere|transferir)';
const PIX = new RegExp(
  [
    String.raw`\bchave\s*(?:do\s*|de\s*)?pix\b`,
    String.raw`\bpix\b[^.\n!?]{0,25}\b(?:chave|direto|por fora|pra mim|para mim|no meu|na minha|do meu|da minha)\b`,
    String.raw`\b${VERBS}\b[^.\n!?]{0,25}\bpix\b`,
    String.raw`\bcpf\b`,
    String.raw`(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)`,
    String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`,
  ].join('|'),
);
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

/** Há um domínio `[\w-]+(?:\.[\w-]+)+` começando em `i`? */
function hasDomainAt(text: string, i: number): boolean {
  let pos = i;
  while (isDomainChar(text.charCodeAt(pos))) pos++;
  if (pos === i || text.charCodeAt(pos) !== 46) return false;
  // Um ponto seguido de um rótulo não vazio fecha o domínio; "b..c" não tem.
  return isDomainChar(text.charCodeAt(pos + 1));
}

/**
 * O mesmo que `/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(text)`, lendo o texto uma vez (Sonar S8786: a
 * regex sem âncora que começa com repetição leva tempo quadrático numa mensagem longa sem "@").
 * Basta um caractere de nome logo antes de um "@" e um domínio com ponto logo depois. Espelho de
 * `containsEmail` em apps/api/src/utils/text-scan.ts.
 */
function containsEmail(text: string): boolean {
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at > 0 && isLocalChar(text.charCodeAt(at - 1)) && hasDomainAt(text, at + 1)) return true;
  }
  return false;
}

const WHATSAPP = /\bwhats\s?app\b|\bwhats\b|\bwpp\b|\bzap\b|\bzapzap\b|wa\.me\//;
const OFF_PLATFORM =
  /\bpor fora\b|\bfora d[ao] (?:plataforma|escambo|app|aplicativo|site|sistema)\b|\bfora daqui\b|\bsem (?:a )?taxa\b|\bdireto comigo\b|\bsem (?:o )?escambo\b|\bcombinar direto\b/;
const PHONE = /(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/g;

function hasPhone(text: string): boolean {
  for (const m of text.matchAll(PHONE)) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, '');
    if (/\D/.test(raw.replace(/^\+?55/, '').trim())) return true;
    if (digits.length === 11 && digits[2] === '9') return true;
    if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') return true;
  }
  return false;
}

const RULES: [OffPlatformSignal, (text: string) => boolean][] = [
  ['pix', (t) => PIX.test(t)],
  ['phone', hasPhone],
  ['email', containsEmail],
  ['whatsapp', (t) => WHATSAPP.test(t)],
  ['off_platform', (t) => OFF_PLATFORM.test(t)],
];

/** Sinais achados no texto, na ordem das regras; vazio quando a mensagem está limpa. */
export function offPlatformSignals(text: string | null | undefined): OffPlatformSignal[] {
  if (!text) return [];
  const t = plain(text);
  return RULES.filter(([, test]) => test(t)).map(([signal]) => signal);
}

/** "Pix, telefone e WhatsApp". */
export function describeSignals(signals: OffPlatformSignal[]): string {
  const labels = signals.map((s) => OFF_PLATFORM_LABEL[s]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
}
