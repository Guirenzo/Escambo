import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import {
  MercadoPagoError,
  createCheckoutPreference,
  getPayment,
  mercadoPagoNotificationUrl,
  methodFromPaymentType,
  setMercadoPagoFetchForTests,
  verifyWebhookSignature,
} from './mercadopago';

const TOKEN = 'APP_USR-token-de-teste';
const SECRET = 'segredo-do-webhook';

/** fetch falso: devolve o corpo dado e guarda as chamadas. */
function fakeFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status }),
  );
  setMercadoPagoFetchForTests(fn as unknown as typeof fetch);
  return fn;
}

const saved = {
  token: env.MERCADOPAGO_ACCESS_TOKEN,
  sandbox: env.MERCADOPAGO_SANDBOX,
  api: env.MERCADOPAGO_API_URL,
  app: env.APP_URL,
};

beforeEach(() => {
  env.MERCADOPAGO_ACCESS_TOKEN = TOKEN;
  env.MERCADOPAGO_SANDBOX = true;
  env.MERCADOPAGO_API_URL = 'https://api.mercadopago.com';
  env.APP_URL = 'https://escambo.exemplo.test/';
});

afterEach(() => {
  setMercadoPagoFetchForTests(null);
  env.MERCADOPAGO_ACCESS_TOKEN = saved.token;
  env.MERCADOPAGO_SANDBOX = saved.sandbox;
  env.MERCADOPAGO_API_URL = saved.api;
  env.APP_URL = saved.app;
  vi.useRealTimers();
});

const PREFERENCE = {
  id: '123-abc',
  init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123-abc',
  sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=123-abc',
};

describe('createCheckoutPreference', () => {
  it('cria a preferência com o valor, a referência e o aviso de volta, idempotente pela referência', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    const fetchMock = fakeFetch(PREFERENCE);
    const expiresAt = new Date('2026-11-18T12:00:00.000Z');

    const pref = await createCheckoutPreference({ amount: 150, reference: '01JREF', expiresAt });

    expect(pref).toEqual({
      id: '123-abc',
      checkoutUrl: PREFERENCE.sandbox_init_point,
      raw: PREFERENCE,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadopago.com/checkout/preferences');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': '01JREF',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [
        {
          id: '01JREF',
          title: 'Depósito na carteira Escambo',
          quantity: 1,
          unit_price: 150,
          currency_id: 'BRL',
        },
      ],
      external_reference: '01JREF',
      notification_url:
        'https://escambo.exemplo.test/api/payments/webhook/mercadopago?source_news=webhooks',
      back_urls: {
        success: 'https://escambo.exemplo.test/carteira',
        pending: 'https://escambo.exemplo.test/carteira',
        failure: 'https://escambo.exemplo.test/carteira',
      },
      auto_return: 'approved',
      expires: true,
      expiration_date_from: '2026-11-15T12:00:00.000Z',
      expiration_date_to: '2026-11-18T12:00:00.000Z',
      date_of_expiration: '2026-11-18T12:00:00.000Z',
      payment_methods: { installments: 1 },
      statement_descriptor: 'ESCAMBO',
    });
  });

  it('fora do sandbox, a página é a de produção (init_point)', async () => {
    env.MERCADOPAGO_SANDBOX = false;
    fakeFetch(PREFERENCE);
    const pref = await createCheckoutPreference({
      amount: 10,
      reference: 'R',
      expiresAt: new Date(),
    });
    expect(pref.checkoutUrl).toBe(PREFERENCE.init_point);
  });

  it('sem a página do modo pedido, usa a outra que vier', async () => {
    fakeFetch({ id: 'p', init_point: PREFERENCE.init_point });
    expect(
      (await createCheckoutPreference({ amount: 10, reference: 'R', expiresAt: new Date() }))
        .checkoutUrl,
    ).toBe(PREFERENCE.init_point);
    env.MERCADOPAGO_SANDBOX = false;
    fakeFetch({ id: 'p', sandbox_init_point: PREFERENCE.sandbox_init_point });
    expect(
      (await createCheckoutPreference({ amount: 10, reference: 'R', expiresAt: new Date() }))
        .checkoutUrl,
    ).toBe(PREFERENCE.sandbox_init_point);
  });

  it('resposta sem id ou sem página é inválida', async () => {
    fakeFetch({ init_point: PREFERENCE.init_point });
    await expect(
      createCheckoutPreference({ amount: 10, reference: 'R', expiresAt: new Date() }),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
    fakeFetch({ id: 'p' });
    await expect(
      createCheckoutPreference({ amount: 10, reference: 'R', expiresAt: new Date() }),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('o endereço da API pode trocar (testes), sem barra dupla', async () => {
    env.MERCADOPAGO_API_URL = 'http://127.0.0.1:9999/';
    const fetchMock = fakeFetch(PREFERENCE);
    await createCheckoutPreference({ amount: 10, reference: 'R', expiresAt: new Date() });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:9999/checkout/preferences');
  });
});

describe('erros do Mercado Pago', () => {
  it('recusa (4xx/5xx) vira MercadoPagoError rejected com o status, sem o corpo na mensagem', async () => {
    fakeFetch({ error: 'unauthorized', message: 'invalid access token', cause: [] }, 401);
    const err = await getPayment('1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MercadoPagoError);
    expect(err).toMatchObject({ reason: 'rejected', status: 401 });
    expect((err as Error).message).toBe('Mercado Pago: rejected (401)');
  });

  it('sem resposta (rede, timeout) vira unreachable', async () => {
    setMercadoPagoFetchForTests((async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }) as unknown as typeof fetch);
    await expect(getPayment('1')).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('corpo que não é JSON, com 200, é resposta inválida', async () => {
    fakeFetch('<html>oi</html>');
    await expect(getPayment('1')).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('recusa sem corpo JSON também é rejected', async () => {
    fakeFetch('erro', 500);
    await expect(getPayment('1')).rejects.toMatchObject({ reason: 'rejected', status: 500 });
  });
});

describe('getPayment', () => {
  it('consulta o pagamento pelo id e lê status, referência, valor, moeda e tipo', async () => {
    const body = {
      id: 1325,
      status: 'approved',
      external_reference: '01JREF',
      transaction_amount: 150,
      currency_id: 'BRL',
      payment_type_id: 'credit_card',
      payer: { email: 'comprador@teste.test' },
    };
    const fetchMock = fakeFetch(body);

    expect(await getPayment('1325')).toEqual({
      id: '1325',
      status: 'approved',
      externalReference: '01JREF',
      amount: 150,
      currency: 'BRL',
      paymentType: 'credit_card',
      raw: body,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadopago.com/v1/payments/1325');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty('Content-Type');
  });

  it('campos ausentes ou de outro tipo viram nulos (e o status, unknown)', async () => {
    fakeFetch({ transaction_amount: 'muito' });
    expect(await getPayment('77')).toMatchObject({
      id: '77',
      status: 'unknown',
      externalReference: null,
      amount: null,
      currency: null,
      paymentType: null,
    });
  });

  it('o id vai escapado no caminho', async () => {
    const fetchMock = fakeFetch({ id: 1 });
    await getPayment('../x');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.mercadopago.com/v1/payments/..%2Fx');
  });
});

describe('methodFromPaymentType', () => {
  it.each([
    ['credit_card', 'credit_card'],
    ['debit_card', 'debit_card'],
    ['prepaid_card', 'debit_card'],
    ['ticket', 'boleto'],
    ['atm', 'boleto'],
    ['bank_transfer', 'pix'],
    ['account_money', 'wallet'],
    ['crypto', null],
    [null, null],
  ])('%s vira %s', (type, method) => {
    expect(methodFromPaymentType(type)).toBe(method);
  });
});

describe('mercadoPagoNotificationUrl', () => {
  it('é o webhook no mesmo domínio do app', () => {
    expect(mercadoPagoNotificationUrl()).toBe(
      'https://escambo.exemplo.test/api/payments/webhook/mercadopago',
    );
  });
});

describe('verifyWebhookSignature', () => {
  const sign = (manifest: string, secret = SECRET) =>
    createHmac('sha256', secret).update(manifest).digest('hex');
  const ts = '1742505638683';

  it('aceita a assinatura do manifesto id;request-id;ts', () => {
    const v1 = sign(`id:1325;request-id:req-1;ts:${ts};`);
    expect(
      verifyWebhookSignature({
        signature: `ts=${ts},v1=${v1}`,
        requestId: 'req-1',
        dataId: '1325',
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it('o id alfanumérico entra em minúsculas, e a ordem e os espaços do cabeçalho não importam', () => {
    const v1 = sign(`id:abc123;request-id:req-1;ts:${ts};`);
    expect(
      verifyWebhookSignature({
        signature: ` v1=${v1} , ts=${ts} `,
        requestId: 'req-1',
        dataId: 'ABC123',
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it('sem x-request-id, o manifesto não tem essa parte', () => {
    const v1 = sign(`id:1325;ts:${ts};`);
    expect(
      verifyWebhookSignature({
        signature: `ts=${ts},v1=${v1}`,
        requestId: undefined,
        dataId: '1325',
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it.each([
    ['outro segredo', { secretUsed: 'outro' }],
    ['outro id', { dataId: '9999' }],
    ['outro request-id', { requestId: 'req-2' }],
  ])('recusa com %s', (_caso, o: { secretUsed?: string; dataId?: string; requestId?: string }) => {
    const v1 = sign(`id:1325;request-id:req-1;ts:${ts};`, o.secretUsed ?? SECRET);
    expect(
      verifyWebhookSignature({
        signature: `ts=${ts},v1=${v1}`,
        requestId: o.requestId ?? 'req-1',
        dataId: o.dataId ?? '1325',
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it.each([
    ['sem cabeçalho', undefined],
    ['sem ts', 'v1=abcd'],
    ['sem v1', `ts=${ts}`],
    ['v1 que não é hexadecimal', `ts=${ts},v1=zzzz`],
    ['v1 curto', `ts=${ts},v1=ab`],
    ['lixo', 'qualquer coisa'],
  ])('recusa %s', (_caso, signature) => {
    expect(
      verifyWebhookSignature({ signature, requestId: 'req-1', dataId: '1325', secret: SECRET }),
    ).toBe(false);
  });

  it('recusa sem o id do pagamento ou sem o segredo configurado', () => {
    const v1 = sign(`id:1325;request-id:req-1;ts:${ts};`);
    const signature = `ts=${ts},v1=${v1}`;
    expect(
      verifyWebhookSignature({ signature, requestId: 'req-1', dataId: undefined, secret: SECRET }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({ signature, requestId: 'req-1', dataId: '1325', secret: '' }),
    ).toBe(false);
  });
});
