import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./payments.repository', () => ({
  paymentsRepository: {
    createTopup: vi.fn(),
    findById: vi.fn(),
    findByGatewayId: vi.fn(),
    listTopupsForUser: vi.fn(),
    settle: vi.fn(),
    recordEvent: vi.fn(),
    expirePending: vi.fn(),
  },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { env } from '../../config/env';
import { notificationsService } from '../notifications/notifications.service';
import { setMercadoPagoFetchForTests } from './mercadopago';
import { paymentsRepository, type PaymentRow } from './payments.repository';
import { paymentsService } from './payments.service';

/**
 * O depósito pelo Mercado Pago (ADR 73) no service: a criação vira a página do Checkout Pro, e o
 * aviso só liquida depois de consultar o pagamento na API (aprovado, nosso, em BRL e no valor).
 */

const repo = vi.mocked(paymentsRepository);
const notify = vi.mocked(notificationsService.notify);

const mpRow = (o: Record<string, unknown> = {}): PaymentRow =>
  ({
    id: 21,
    kind: 'topup',
    payer_id: 4,
    amount: '150.00',
    method: 'pix',
    status: 'pending',
    gateway: 'mercadopago',
    gateway_payment_id: '01JREF',
    gateway_response: JSON.stringify({
      externalId: '01JREF',
      checkoutUrl: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=p1',
    }),
    paid_at: null,
    expires_at: new Date(Date.now() + 3_600_000),
    created_at: new Date('2026-11-15T00:00:00Z'),
    ...o,
  }) as unknown as PaymentRow;

/** O pagamento como a API do Mercado Pago devolve (com dado do comprador, que não pode ficar). */
const mpPayment = (o: Record<string, unknown> = {}) => ({
  id: 1325,
  status: 'approved',
  external_reference: '01JREF',
  transaction_amount: 150,
  currency_id: 'BRL',
  payment_type_id: 'credit_card',
  payer: { email: 'comprador@teste.test', identification: { number: '12345678909' } },
  ...o,
});

let fetchMock: ReturnType<typeof vi.fn>;
const answer = (body: unknown, status = 200) =>
  fetchMock.mockImplementation(async () => Response.json(body, { status }));

const RECEIPT = {
  event: 'payment.updated',
  body: { action: 'payment.updated', type: 'payment', data: { id: '1325' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  env.PAYMENTS_SIMULATE = true;
  fetchMock = vi.fn();
  setMercadoPagoFetchForTests(fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  env.PAYMENT_GATEWAY = 'simulated';
  setMercadoPagoFetchForTests(null);
});

describe('createDeposit com PAYMENT_GATEWAY=mercadopago', () => {
  beforeEach(() => {
    env.PAYMENT_GATEWAY = 'mercadopago';
  });

  it('grava a cobrança do Mercado Pago com a referência e a página de pagamento', async () => {
    answer({
      id: 'p1',
      init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=p1',
      sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=p1',
      collector_id: 99,
    });
    repo.createTopup.mockResolvedValue(21);
    repo.findById.mockResolvedValue(mpRow());

    const d = await paymentsService.createDeposit(4, { amount: 150, method: 'pix' });

    const arg = repo.createTopup.mock.calls[0]![0];
    expect(arg.gateway).toBe('mercadopago');
    // A referência (ULID) é o id da cobrança e o external_reference da preferência.
    expect(arg.gatewayPaymentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(arg.response).toMatchObject({
      externalId: arg.gatewayPaymentId,
      checkoutUrl: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=p1',
      raw: { id: 'p1', collector_id: 99 },
    });
    expect(arg.response).not.toHaveProperty('pixCode');
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(sent.external_reference).toBe(arg.gatewayPaymentId);
    expect(d).toMatchObject({
      status: 'pending',
      method: null,
      pixCode: null,
      checkoutUrl: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=p1',
      canSimulate: false,
    });
  });

  it('Mercado Pago fora do ar: 502 gateway_unavailable e nada gravado', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      paymentsService.createDeposit(4, { amount: 150, method: 'pix' }),
    ).rejects.toMatchObject({ statusCode: 502, code: 'gateway_unavailable' });
    expect(repo.createTopup).not.toHaveBeenCalled();
  });

  it('token recusado pelo Mercado Pago também é 502 (o erro dele não chega à pessoa)', async () => {
    answer({ message: 'invalid token' }, 401);
    await expect(
      paymentsService.createDeposit(4, { amount: 150, method: 'pix' }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('toDeposit de uma cobrança do Mercado Pago', () => {
  it('pendente: a página de pagamento, sem forma ainda e sem simulação', async () => {
    repo.findById.mockResolvedValue(mpRow());
    expect(await paymentsService.getDeposit(21, 4)).toMatchObject({
      method: null,
      checkoutUrl: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=p1',
      pixCode: null,
      canSimulate: false,
    });
  });

  it('paga: a forma gravada e sem a página', async () => {
    repo.findById.mockResolvedValue(
      mpRow({ status: 'paid', method: 'boleto', paid_at: new Date() }),
    );
    expect(await paymentsService.getDeposit(21, 4)).toMatchObject({
      status: 'paid',
      method: 'boleto',
      checkoutUrl: null,
    });
  });

  it('vencida: cancelada, sem página', async () => {
    repo.findById.mockResolvedValue(mpRow({ expires_at: new Date(Date.now() - 1000) }));
    expect(await paymentsService.getDeposit(21, 4)).toMatchObject({
      status: 'cancelled',
      method: null,
      checkoutUrl: null,
    });
  });
});

describe('simulate e o webhook simulado não tocam cobrança do Mercado Pago', () => {
  it('simular a cobrança do Mercado Pago é 409, mesmo com PAYMENTS_SIMULATE ligado', async () => {
    repo.findById.mockResolvedValue(mpRow());
    await expect(paymentsService.simulate(21, 4)).rejects.toMatchObject({
      statusCode: 409,
      code: 'deposit_not_simulated',
    });
    expect(repo.settle).not.toHaveBeenCalled();
  });

  it('o webhook do gateway simulado não acha a cobrança do Mercado Pago (404, not_found)', async () => {
    repo.findByGatewayId.mockResolvedValue(mpRow());
    await expect(
      paymentsService.settleFromGateway('01JREF', 'paid', { event: null, body: {} }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'payment_not_found' });
    expect(repo.settle).not.toHaveBeenCalled();
    expect(repo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ gateway: 'simulado', outcome: 'not_found' }),
    );
  });
});

describe('settleFromMercadoPago', () => {
  it('pagamento aprovado do nosso depósito: consulta a API, liquida com a forma e notifica', async () => {
    answer(mpPayment());
    repo.findByGatewayId.mockResolvedValue(mpRow());
    repo.settle.mockResolvedValue(true);

    const r = await paymentsService.settleFromMercadoPago('1325', RECEIPT);

    expect(r).toEqual({ outcome: 'applied', depositId: 21 });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.mercadopago.com/v1/payments/1325');
    expect(repo.findByGatewayId).toHaveBeenCalledWith('01JREF');
    const [id, status, notice, opts] = repo.settle.mock.calls[0]!;
    expect([id, status, opts]).toEqual([
      21,
      'paid',
      { method: 'credit_card', reopenExpired: true },
    ]);
    // O histórico guarda o aviso e o pagamento consultado, sem o comprador.
    expect(notice).toMatchObject({
      source: 'webhook',
      event: 'payment.updated',
      payload: {
        notice: RECEIPT.body,
        payment: { id: 1325, status: 'approved', payer: '[omitido]' },
      },
    });
    expect(JSON.stringify(notice)).not.toContain('comprador@teste.test');
    expect(notify).toHaveBeenCalledWith(4, expect.objectContaining({ type: 'deposit_confirmed' }));
  });

  it.each([
    ['ticket', 'boleto'],
    ['bank_transfer', 'pix'],
    ['debit_card', 'debit_card'],
    ['outro_tipo', null],
  ])('a forma do pagamento (%s) vai para a cobrança como %s', async (type, method) => {
    answer(mpPayment({ payment_type_id: type }));
    repo.findByGatewayId.mockResolvedValue(mpRow());
    repo.settle.mockResolvedValue(true);
    await paymentsService.settleFromMercadoPago('1325', RECEIPT);
    expect(repo.settle.mock.calls[0]![3]).toEqual({ method, reopenExpired: true });
  });

  it.each(['pending', 'in_process', 'rejected', 'cancelled', 'refunded'])(
    'pagamento %s: só fica no histórico (ignored), o depósito segue como está',
    async (status) => {
      answer(mpPayment({ status }));
      repo.findByGatewayId.mockResolvedValue(mpRow());

      expect(await paymentsService.settleFromMercadoPago('1325', RECEIPT)).toEqual({
        outcome: 'ignored',
        depositId: 21,
      });
      expect(repo.settle).not.toHaveBeenCalled();
      expect(repo.recordEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          paymentId: 21,
          gateway: 'mercadopago',
          gatewayPaymentId: '01JREF',
          status,
          outcome: 'ignored',
        }),
      );
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it('aprovado repetido (já liquidado): ignored, sem notificar de novo', async () => {
    answer(mpPayment());
    repo.findByGatewayId.mockResolvedValue(mpRow({ status: 'paid' }));
    repo.settle.mockResolvedValue(false);

    expect(await paymentsService.settleFromMercadoPago('1325', RECEIPT)).toEqual({
      outcome: 'ignored',
      depositId: 21,
    });
    expect(repo.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ignored' }));
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ['outro valor', { transaction_amount: 149.99 }],
    ['outra moeda', { currency_id: 'USD' }],
    ['sem valor', { transaction_amount: null }],
  ])('pagamento com %s não credita: mismatch, no histórico como invalid', async (_caso, o) => {
    answer(mpPayment(o));
    repo.findByGatewayId.mockResolvedValue(mpRow());

    expect(await paymentsService.settleFromMercadoPago('1325', RECEIPT)).toEqual({
      outcome: 'mismatch',
      depositId: 21,
    });
    expect(repo.settle).not.toHaveBeenCalled();
    expect(repo.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'invalid' }));
  });

  it('valor com centavos confere mesmo com a representação diferente (19.9 e "19.90")', async () => {
    answer(mpPayment({ transaction_amount: 19.9 }));
    repo.findByGatewayId.mockResolvedValue(mpRow({ amount: '19.90' }));
    repo.settle.mockResolvedValue(true);
    expect((await paymentsService.settleFromMercadoPago('1325', RECEIPT)).outcome).toBe('applied');
  });

  it('pagamento sem referência, de referência desconhecida ou de cobrança de outro gateway: not_found', async () => {
    answer(mpPayment({ external_reference: null }));
    expect(await paymentsService.settleFromMercadoPago('1325', RECEIPT)).toEqual({
      outcome: 'not_found',
      depositId: null,
    });
    expect(repo.findByGatewayId).not.toHaveBeenCalled();

    answer(mpPayment());
    repo.findByGatewayId.mockResolvedValueOnce(undefined);
    expect((await paymentsService.settleFromMercadoPago('1325', RECEIPT)).outcome).toBe(
      'not_found',
    );

    repo.findByGatewayId.mockResolvedValueOnce(mpRow({ gateway: 'simulado' }));
    expect((await paymentsService.settleFromMercadoPago('1325', RECEIPT)).outcome).toBe(
      'not_found',
    );

    expect(repo.settle).not.toHaveBeenCalled();
    expect(
      repo.recordEvent.mock.calls.map(([e]) => [e.paymentId, e.gatewayPaymentId, e.outcome]),
    ).toEqual([
      [null, null, 'not_found'],
      [null, '01JREF', 'not_found'],
      [null, '01JREF', 'not_found'],
    ]);
  });

  it('pagamento que o Mercado Pago não conhece (404, o "simular" do painel): not_found, sem repetir', async () => {
    answer({ message: 'Payment not found', error: 'not_found', status: 404 }, 404);

    expect(await paymentsService.settleFromMercadoPago('123456', RECEIPT)).toEqual({
      outcome: 'not_found',
      depositId: null,
    });
    expect(repo.findByGatewayId).not.toHaveBeenCalled();
    expect(repo.recordEvent).toHaveBeenCalledExactlyOnceWith({
      paymentId: null,
      gateway: 'mercadopago',
      gatewayPaymentId: null,
      source: 'webhook',
      event: 'payment.updated',
      status: null,
      outcome: 'not_found',
      payload: { notice: RECEIPT.body },
    });
  });

  it('outra recusa do Mercado Pago na consulta (401: token errado) sobe, para o webhook dar 502', async () => {
    answer({ message: 'invalid token' }, 401);
    await expect(paymentsService.settleFromMercadoPago('1325', RECEIPT)).rejects.toMatchObject({
      reason: 'rejected',
      status: 401,
    });
    expect(repo.recordEvent).not.toHaveBeenCalled();
  });

  it('Mercado Pago fora do ar na consulta: o erro sobe (o webhook responde 502 e ele repete)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(paymentsService.settleFromMercadoPago('1325', RECEIPT)).rejects.toMatchObject({
      reason: 'unreachable',
    });
    expect(repo.findByGatewayId).not.toHaveBeenCalled();
  });
});
