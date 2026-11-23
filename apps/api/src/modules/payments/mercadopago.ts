import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { trimEndChar } from '../../utils/text-scan';

/**
 * Cliente do Mercado Pago (RF-041), sem SDK: o Checkout Pro para o depósito na carteira e a consulta
 * do pagamento que o webhook anuncia.
 *
 * - **Checkout Pro:** a API cria uma preferência com o valor e a referência do depósito, e a pessoa
 *   paga na página do Mercado Pago (Pix, cartão ou boleto). Nenhum dado de cartão passa pelo Escambo.
 * - **Webhook:** o aviso do Mercado Pago só diz "o pagamento N mudou". A assinatura (`x-signature`)
 *   é conferida, e o que vale é a consulta do pagamento na API com o nosso token: valor, referência e
 *   status vêm de lá, nunca do corpo da notificação.
 *
 * Com credenciais de teste, tudo roda no sandbox (sem dinheiro de verdade). Nada daqui chama a rede
 * nos testes: o `fetch` é trocável (setMercadoPagoFetchForTests).
 */

const TIMEOUT_MS = 10_000;

/** Por que o Mercado Pago não respondeu o que precisávamos (vai para o log, sem dado pessoal). */
export class MercadoPagoError extends Error {
  constructor(
    public readonly reason: 'unreachable' | 'rejected' | 'invalid_response',
    public readonly status?: number,
  ) {
    super(`Mercado Pago: ${reason}${status ? ` (${status})` : ''}`);
    this.name = 'MercadoPagoError';
  }
}

const realFetch: typeof fetch = (input, init) => fetch(input, init);
let fetchImpl: typeof fetch = realFetch;

/** Só para testes: o `fetch` das chamadas ao Mercado Pago (null volta ao de verdade). */
export function setMercadoPagoFetchForTests(impl: typeof fetch | null): void {
  fetchImpl = impl ?? realFetch;
}

const baseUrl = (): string => trimEndChar(env.MERCADOPAGO_API_URL, '/');

/** O endereço que o Mercado Pago chama quando um pagamento muda (o mesmo domínio do app). */
export function mercadoPagoNotificationUrl(): string {
  return `${trimEndChar(env.APP_URL, '/')}/api/payments/webhook/mercadopago`;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string } };
    logger.warn(
      { error: e.name ?? 'Error', cause: e.cause?.code, path },
      'Mercado Pago não respondeu',
    );
    throw new MercadoPagoError('unreachable');
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    logger.warn(
      { status: res.status, error: typeof json?.error === 'string' ? json.error : undefined, path },
      'Mercado Pago recusou a chamada',
    );
    throw new MercadoPagoError('rejected', res.status);
  }
  if (!json || typeof json !== 'object') throw new MercadoPagoError('invalid_response');
  return json;
}

export interface CheckoutPreference {
  /** Id da preferência no Mercado Pago. */
  id: string;
  /** Página de pagamento (a do sandbox, com credenciais de teste). */
  checkoutUrl: string;
  /** Corpo da resposta, para o histórico (RF-050); higienizado por quem guarda. */
  raw: Record<string, unknown>;
}

/**
 * Cria a preferência do Checkout Pro de um depósito. A referência do depósito vai em
 * `external_reference` e na chave de idempotência: o mesmo depósito nunca vira duas preferências.
 */
export async function createCheckoutPreference(input: {
  amount: number;
  reference: string;
  expiresAt: Date;
}): Promise<CheckoutPreference> {
  const appUrl = trimEndChar(env.APP_URL, '/');
  const back = `${appUrl}/carteira`;
  const body = await call(
    'POST',
    '/checkout/preferences',
    {
      items: [
        {
          id: input.reference,
          title: 'Depósito na carteira Escambo',
          quantity: 1,
          unit_price: input.amount,
          currency_id: 'BRL',
        },
      ],
      external_reference: input.reference,
      notification_url: `${mercadoPagoNotificationUrl()}?source_news=webhooks`,
      back_urls: { success: back, pending: back, failure: back },
      auto_return: 'approved',
      expires: true,
      expiration_date_from: new Date().toISOString(),
      expiration_date_to: input.expiresAt.toISOString(),
      date_of_expiration: input.expiresAt.toISOString(),
      payment_methods: { installments: 1 },
      statement_descriptor: 'ESCAMBO',
    },
    input.reference,
  );
  const id = typeof body.id === 'string' ? body.id : null;
  // Sempre o init_point. As credenciais de teste do painel são de um vendedor de teste: o pagamento
  // é na página normal, logado com um comprador de teste, e o sandbox_init_point dá erro para elas.
  // O sandbox_init_point só serve se a resposta não trouxer o init_point.
  const live = typeof body.init_point === 'string' ? body.init_point : null;
  const sandbox = typeof body.sandbox_init_point === 'string' ? body.sandbox_init_point : null;
  const checkoutUrl = live ?? sandbox;
  if (!id || !checkoutUrl) throw new MercadoPagoError('invalid_response');
  return { id, checkoutUrl, raw: body };
}

/** O que importa de um pagamento do Mercado Pago para liquidar um depósito. */
export interface MercadoPagoPayment {
  id: string;
  status: string;
  externalReference: string | null;
  amount: number | null;
  currency: string | null;
  /** Tipo do pagamento no Mercado Pago (credit_card, debit_card, ticket, bank_transfer…). */
  paymentType: string | null;
  raw: Record<string, unknown>;
}

/** Consulta o pagamento pelo id que o webhook anunciou. */
export async function getPayment(id: string): Promise<MercadoPagoPayment> {
  const body = await call('GET', `/v1/payments/${encodeURIComponent(id)}`);
  const amount = Number(body.transaction_amount);
  return {
    id: String(body.id ?? id),
    status: typeof body.status === 'string' ? body.status : 'unknown',
    externalReference: typeof body.external_reference === 'string' ? body.external_reference : null,
    amount: Number.isFinite(amount) ? amount : null,
    currency: typeof body.currency_id === 'string' ? body.currency_id : null,
    paymentType: typeof body.payment_type_id === 'string' ? body.payment_type_id : null,
    raw: body,
  };
}

/** Como o tipo de pagamento do Mercado Pago entra na coluna `payments.method`. */
export function methodFromPaymentType(
  type: string | null,
): 'pix' | 'credit_card' | 'debit_card' | 'boleto' | 'wallet' | null {
  switch (type) {
    case 'credit_card':
      return 'credit_card';
    case 'debit_card':
    case 'prepaid_card':
      return 'debit_card';
    case 'ticket':
    case 'atm':
      return 'boleto';
    case 'bank_transfer':
      return 'pix';
    case 'account_money':
      return 'wallet';
    default:
      return null;
  }
}

/**
 * Confere a assinatura do webhook (`x-signature: ts=…,v1=…`), conforme o Mercado Pago: HMAC-SHA256
 * com a chave secreta sobre `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, com o `data.id` em
 * minúsculas quando é alfanumérico. A comparação é em tempo constante.
 */
export function verifyWebhookSignature(input: {
  signature: string | undefined;
  requestId: string | undefined;
  dataId: string | undefined;
  secret: string;
}): boolean {
  if (!input.signature || !input.dataId || !input.secret) return false;
  const parts = new Map(
    input.signature.split(',').map((p) => {
      const [k, ...v] = p.split('=');
      return [k?.trim() ?? '', v.join('=').trim()] as const;
    }),
  );
  const ts = parts.get('ts');
  const v1 = parts.get('v1');
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
  const id = /^[a-z0-9]+$/i.test(input.dataId) ? input.dataId.toLowerCase() : input.dataId;
  const manifest =
    `id:${id};` + (input.requestId ? `request-id:${input.requestId};` : '') + `ts:${ts};`;
  const expected = createHmac('sha256', input.secret).update(manifest).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
