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

const plain = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const VERBS = '(?:paga|pagar|pague|pagando|manda|mandar|mande|envia|enviar|faz|fazer|transfere|transferir)';
const PIX =
  new RegExp(
    [
      String.raw`\bchave\s*(?:do\s*|de\s*)?pix\b`,
      String.raw`\bpix\b[^.\n!?]{0,25}\b(?:chave|direto|por fora|pra mim|para mim|no meu|na minha|do meu|da minha)\b`,
      String.raw`\b${VERBS}\b[^.\n!?]{0,25}\bpix\b`,
      String.raw`\bcpf\b`,
      String.raw`(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)`,
      String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`,
    ].join('|'),
  );
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
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
  ['email', (t) => EMAIL.test(t)],
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
