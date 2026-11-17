import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { routerApp } from '../../test-support/http';
import { MercadoPagoError } from './mercadopago';
import { paymentsRoutes } from './payments.routes';

const { service, log } = vi.hoisted(() => ({
  service: { settleFromMercadoPago: vi.fn(), settleFromGateway: vi.fn() },
  log: vi.fn(),
}));
vi.mock('./payments.service', () => ({ paymentsService: service }));
vi.mock('../audit/audit.service', () => ({ auditService: { log } }));

const app = routerApp('/api/payments', paymentsRoutes);
const URL = '/api/payments/webhook/mercadopago';
const SECRET = 'mp-webhook-secret-de-teste';
const TS = '1742505638683';
const saved = { token: env.MERCADOPAGO_ACCESS_TOKEN, secret: env.MERCADOPAGO_WEBHOOK_SECRET };

const signature = (dataId: string, requestId = 'req-1', secret = SECRET) =>
  `ts=${TS},v1=${createHmac('sha256', secret)
    .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${TS};`)
    .digest('hex')}`;

const notice = (id = '1325', type = 'payment') => ({
  action: 'payment.updated',
  api_version: 'v1',
  type,
  data: { id },
});

/**
 * Webhook do Mercado Pago (ADR 73): sem sessão, quem protege é a assinatura x-signature. O service
 * entra mockado; aqui se confere quem passa, o que chega a ele, as respostas que fazem o Mercado
 * Pago parar ou repetir e a auditoria.
 */
describe('POST /api/payments/webhook/mercadopago', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-teste';
    env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    env.MERCADOPAGO_ACCESS_TOKEN = saved.token;
    env.MERCADOPAGO_WEBHOOK_SECRET = saved.secret;
  });

  it('assinado: passa o id do pagamento e o aviso ao service, responde o desfecho e audita', async () => {
    service.settleFromMercadoPago.mockResolvedValue({ outcome: 'applied', depositId: 21 });

    const res = await request(app)
      .post(`${URL}?data.id=1325&type=payment`)
      .set('x-signature', signature('1325'))
      .set('x-request-id', 'req-1')
      .set('User-Agent', 'MercadoPago WebHook v1.0')
      .send(notice())
      .expect(200);

    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(service.settleFromMercadoPago).toHaveBeenCalledExactlyOnceWith('1325', {
      event: 'payment.updated',
      body: notice(),
    });
    expect(log).toHaveBeenCalledWith({
      userId: null,
      action: 'payment_webhook',
      entityType: 'payment',
      entityId: 21,
      newValue: { gateway: 'mercadopago', outcome: 'applied' },
      ip: expect.stringContaining('127.0.0.1'),
      userAgent: 'MercadoPago WebHook v1.0',
    });
  });

  it('sem data.id na query, usa o do corpo (e é ele que a assinatura cobre)', async () => {
    service.settleFromMercadoPago.mockResolvedValue({ outcome: 'ignored', depositId: 21 });
    await request(app)
      .post(URL)
      .set('x-signature', signature('987'))
      .set('x-request-id', 'req-1')
      .send({ type: 'payment', data: { id: 987 } })
      .expect(200);
    expect(service.settleFromMercadoPago).toHaveBeenCalledWith('987', expect.anything());
  });

  it.each(['not_found', 'ignored', 'mismatch'])(
    'desfecho %s também é 200 (senão o Mercado Pago repete para sempre)',
    async (outcome) => {
      service.settleFromMercadoPago.mockResolvedValue({ outcome, depositId: null });
      const res = await request(app)
        .post(`${URL}?data.id=1325&type=payment`)
        .set('x-signature', signature('1325'))
        .set('x-request-id', 'req-1')
        .send(notice())
        .expect(200);
      expect(res.body).toEqual({ ok: true, outcome });
    },
  );

  it.each([
    ['sem assinatura', undefined, 'req-1'],
    ['assinada com outro segredo', signature('1325', 'req-1', 'outro'), 'req-1'],
    ['assinatura de outro pagamento', signature('9999'), 'req-1'],
    ['outro x-request-id', signature('1325'), 'req-2'],
  ])('%s: 401 e o service nem é chamado', async (_caso, sig, requestId) => {
    const req = request(app)
      .post(`${URL}?data.id=1325&type=payment`)
      .set('x-request-id', requestId);
    if (sig) req.set('x-signature', sig);
    const res = await req.send(notice()).expect(401);
    expect(res.body.error).toBe('invalid_webhook_signature');
    expect(service.settleFromMercadoPago).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('assinado mas de outro tópico (merchant_order) ou sem id: 200 ignored, sem consultar nada', async () => {
    await request(app)
      .post(`${URL}?data.id=55&type=merchant_order`)
      .set('x-signature', signature('55'))
      .set('x-request-id', 'req-1')
      .send(notice('55', 'merchant_order'))
      .expect(200, { ok: true, outcome: 'ignored' });
    expect(service.settleFromMercadoPago).not.toHaveBeenCalled();
  });

  it('id com caractere estranho, mesmo assinado, não vira consulta', async () => {
    await request(app)
      .post(`${URL}?type=payment`)
      .set('x-signature', signature('a/b'))
      .set('x-request-id', 'req-1')
      .send({ type: 'payment', data: { id: 'a/b' } })
      .expect(200, { ok: true, outcome: 'ignored' });
    expect(service.settleFromMercadoPago).not.toHaveBeenCalled();
  });

  it('Mercado Pago fora do ar na consulta: 502, para ele repetir o aviso mais tarde', async () => {
    service.settleFromMercadoPago.mockRejectedValue(new MercadoPagoError('unreachable'));
    const res = await request(app)
      .post(`${URL}?data.id=1325&type=payment`)
      .set('x-signature', signature('1325'))
      .set('x-request-id', 'req-1')
      .send(notice())
      .expect(502);
    expect(res.body.error).toBe('gateway_unavailable');
    expect(log).not.toHaveBeenCalled();
  });

  it('outro erro do service sobe como está (500)', async () => {
    service.settleFromMercadoPago.mockRejectedValue(new Error('banco caiu'));
    await request(app)
      .post(`${URL}?data.id=1325&type=payment`)
      .set('x-signature', signature('1325'))
      .set('x-request-id', 'req-1')
      .send(notice())
      .expect(500);
  });

  it.each([
    ['sem o token', 'MERCADOPAGO_ACCESS_TOKEN'],
    ['sem a chave secreta', 'MERCADOPAGO_WEBHOOK_SECRET'],
  ] as const)('%s: 503 webhook_disabled', async (_caso, key) => {
    env[key] = '';
    const res = await request(app)
      .post(`${URL}?data.id=1325&type=payment`)
      .set('x-signature', signature('1325'))
      .send(notice())
      .expect(503);
    expect(res.body.error).toBe('webhook_disabled');
    expect(service.settleFromMercadoPago).not.toHaveBeenCalled();
  });

  it('a rota do Mercado Pago não cai no webhook do gateway simulado', async () => {
    service.settleFromMercadoPago.mockResolvedValue({ outcome: 'applied', depositId: 1 });
    await request(app)
      .post(`${URL}?data.id=1325&type=payment`)
      .set('x-signature', signature('1325'))
      .set('x-request-id', 'req-1')
      .send(notice())
      .expect(200);
    expect(service.settleFromGateway).not.toHaveBeenCalled();
  });
});
