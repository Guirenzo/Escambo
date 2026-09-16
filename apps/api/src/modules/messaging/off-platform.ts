import type { OffPlatformSignal } from '@escambo/types';

/**
 * Detecção de negociação por fora no chat (ADR 45). São heurísticas, não julgamento: a mensagem não
 * é barrada, as duas partes veem um aviso e ela entra sozinha na fila de denúncias, onde uma pessoa
 * decide. Falso positivo custa uma dispensa na fila; falso negativo custa uma contratação fora do
 * escrow, então as regras erram para o lado de avisar.
 *
 * Espelho em apps/web/src/lib/offPlatform.ts, que mostra o aviso enquanto a pessoa digita: mudou
 * aqui, muda lá (os testes dos dois lados cobrem os mesmos exemplos).
 */

export const OFF_PLATFORM_LABEL: Record<OffPlatformSignal, string> = {
  pix: 'Pix',
  phone: 'telefone',
  email: 'e-mail',
  whatsapp: 'WhatsApp',
  off_platform: 'negociar por fora',
};

/** Sem acento e em minúsculas: "Transferência" e "transferencia" caem na mesma regra. */
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
/** DDD + número, com ou sem +55, parênteses, espaço, ponto ou traço. */
const PHONE = /(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/g;

/**
 * Telefone: um número com separadores é telefone; uma sequência crua só conta com os 11 dígitos
 * do celular (DDD + 9 + 8), para número de pedido e valor sem pontuação não virarem aviso.
 */
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

/** "Pix, telefone e WhatsApp": como os sinais aparecem no aviso e na fila. */
export function describeSignals(signals: OffPlatformSignal[]): string {
  const labels = signals.map((s) => OFF_PLATFORM_LABEL[s]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
}

/** Coluna messages.off_platform ("pix,phone") → lista tipada; o que não for sinal conhecido sai. */
export function parseSignals(value: string | null | undefined): OffPlatformSignal[] {
  if (!value) return [];
  return value
    .split(',')
    .filter((s): s is OffPlatformSignal => Object.hasOwn(OFF_PLATFORM_LABEL, s));
}

export const serializeSignals = (signals: OffPlatformSignal[]): string | null =>
  signals.length > 0 ? signals.join(',') : null;
