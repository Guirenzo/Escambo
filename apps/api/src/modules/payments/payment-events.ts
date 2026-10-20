import type { ResultSetHeader } from 'mysql2';
import type { Connection } from 'mysql2/promise';
import type { PixCharge } from './gateway';

/**
 * Histórico do gateway por cobrança (RF-050): a resposta da criação e o corpo de cada webhook
 * recebido, numa linha cada, sem nunca sobrescrever. O efeito continua idempotente (a cobrança só
 * sai de "pending" uma vez); a repetição só ganha a sua linha, com o desfecho "ignored".
 *
 * O que se guarda é o corpo SEM dado pessoal: um gateway de verdade manda nome, documento, e-mail
 * e conta de quem pagou, e nada disso é preciso para auditar a cobrança (quem pagou já está no
 * depósito). Os campos com esses nomes saem como "[omitido]", em qualquer profundidade. O
 * cabeçalho do segredo nunca entra.
 */

export type PaymentEventSource = 'charge' | 'webhook' | 'simulation';
export type PaymentEventOutcome = 'created' | 'applied' | 'ignored' | 'not_found' | 'invalid';

export interface PaymentEventInput {
  paymentId: number | null;
  gateway: string;
  gatewayPaymentId: string | null;
  source: PaymentEventSource;
  /** Nome do evento que o gateway mandou ("payment.updated"), quando mandou. */
  event: string | null;
  /** Status informado pelo gateway (paid/failed); na criação, "pending". */
  status: string | null;
  outcome: PaymentEventOutcome;
  /** O corpo já higienizado (ver `sanitizeGatewayPayload`). */
  payload: unknown;
}

/** Chaves cujo valor é dado pessoal ou segredo: saem como "[omitido]" (o objeto inteiro, se for). */
const SENSITIVE_KEY =
  /cpf|cnpj|document|identification|tax_?id|e-?mail|phone|telefone|celular|name|nome|address|endere|birth|nascimento|payer|customer|cliente|pagador|devedor|debtor|holder|titular|billing|card|cart[aã]o|cvv|account|conta|agenc|bank|banco|pix_?key|chave|secret|segredo|token|password|senha|authorization|ip_?addr/i;

export const OMITTED = '[omitido]';
const MAX_DEPTH = 6;
const MAX_STRING = 500;
const MAX_ITEMS = 50;
const MAX_KEYS = 100;

/**
 * Cópia do corpo para auditoria: tira dado pessoal e segredos pelo nome do campo e põe teto em
 * profundidade, tamanho de texto, itens de lista e chaves por objeto (um corpo enorme não enche o
 * banco). Só tipos de JSON saem; o que não for (undefined, função) vira null.
 */
export function sanitizeGatewayPayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (depth >= MAX_DEPTH) return '[truncado]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => sanitizeGatewayPayload(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      out[key] = SENSITIVE_KEY.test(key) ? OMITTED : sanitizeGatewayPayload(item, depth + 1);
    }
    return out;
  }
  return null;
}

/** Texto curto de um campo do corpo (evento, status, id), ou null se não for texto. */
export const shortText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value !== '' ? value.slice(0, max) : null;

/**
 * A resposta da criação da cobrança como fica guardada (em `payments.gateway_response` e no
 * histórico): identificador, código PIX, validade e, se o provedor devolveu, o corpo original
 * higienizado. O `pixCode` fica no topo, que é onde o depósito o lê.
 */
export function chargeResponse(charge: PixCharge): Record<string, unknown> {
  return {
    externalId: charge.externalId,
    pixCode: charge.pixCode,
    expiresAt: charge.expiresAt.toISOString(),
    ...(charge.raw ? { raw: sanitizeGatewayPayload(charge.raw) } : {}),
  };
}

/** Grava uma linha do histórico, na transação de quem chama ou em autocommit (pool). */
export async function insertPaymentEvent(
  db: Pick<Connection, 'query'>,
  e: PaymentEventInput,
): Promise<void> {
  await db.query<ResultSetHeader>(
    `INSERT INTO payment_events
       (payment_id, gateway, gateway_payment_id, source, event, status, outcome, payload)
     VALUES
       (:paymentId, :gateway, :gatewayPaymentId, :source, :event, :status, :outcome, :payload)`,
    {
      paymentId: e.paymentId,
      gateway: e.gateway,
      gatewayPaymentId: e.gatewayPaymentId,
      source: e.source,
      event: e.event,
      status: e.status,
      outcome: e.outcome,
      payload: e.payload === undefined ? null : JSON.stringify(e.payload),
    },
  );
}
