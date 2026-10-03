import type { Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { webhook } from './payments.controller';
import { paymentsRoutes } from './payments.routes';

const { service, log } = vi.hoisted(() => ({
  service: { settleFromGateway: vi.fn() },
  log: vi.fn(),
}));
vi.mock('./payments.service', () => ({ paymentsService: service }));
vi.mock('../audit/audit.service', () => ({ auditService: { log } }));

const app = routerApp('/api/payments', paymentsRoutes);

const SECRET = 'whsec-unit-test-0123456789';
const originalSecret = env.PAYMENT_WEBHOOK_SECRET;

const paidEvent = { event: 'charge.paid', gatewayPaymentId: 'sim_ABC', status: 'paid' };
const settled = (applied: boolean) => ({ applied, deposit: { id: 7, status: 'paid' } });

/**
 * Webhook do gateway de pagamento: não tem sessão de usuário, quem protege é o segredo
 * compartilhado no cabeçalho `x-webhook-secret`. O service entra mockado; aqui se confere quem
 * passa, quem é barrado, o que chega ao service e o que fica na auditoria (RN-010).
 */
describe('POST /api/payments/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.PAYMENT_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    env.PAYMENT_WEBHOOK_SECRET = originalSecret;
  });

  it('com o segredo certo e sem login, liquida pela referência do gateway e responde o que foi aplicado', async () => {
    service.settleFromGateway.mockResolvedValue(settled(true));

    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .set('User-Agent', 'gateway-teste/1.0')
      .send(paidEvent)
      .expect(200);

    expect(res.body).toEqual({ ok: true, applied: true, status: 'paid' });
    expect(service.settleFromGateway).toHaveBeenCalledTimes(1);
    expect(service.settleFromGateway).toHaveBeenCalledWith('sim_ABC', 'paid');
    // Auditoria da movimentação financeira: sem usuário (quem chamou foi o gateway).
    expect(log).toHaveBeenCalledWith({
      userId: null,
      action: 'payment_webhook',
      entityType: 'payment',
      entityId: 7,
      newValue: { status: 'paid', applied: true },
      ip: expect.stringContaining('127.0.0.1'),
      userAgent: 'gateway-teste/1.0',
    });
  });

  it('evento repetido responde 200 com applied false, para o gateway parar de reenviar', async () => {
    service.settleFromGateway.mockResolvedValue(settled(false));

    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .send(paidEvent)
      .expect(200);

    expect(res.body).toEqual({ ok: true, applied: false, status: 'paid' });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 7, newValue: { status: 'paid', applied: false } }),
    );
  });

  it('aviso de falha chega ao service como failed e a resposta traz o status da cobrança', async () => {
    service.settleFromGateway.mockResolvedValue({
      applied: true,
      deposit: { id: 7, status: 'failed' },
    });

    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .send({ gatewayPaymentId: 'sim_ABC', status: 'failed' })
      .expect(200);

    expect(res.body).toEqual({ ok: true, applied: true, status: 'failed' });
    expect(service.settleFromGateway).toHaveBeenCalledWith('sim_ABC', 'failed');
  });

  it('a resposta traz a situação da cobrança, não a do evento: aviso de falha para cobrança já paga continua paga', async () => {
    // Evento atrasado ou fora de ordem: o service não aplica e devolve a cobrança como está.
    service.settleFromGateway.mockResolvedValue({
      applied: false,
      deposit: { id: 31, status: 'paid' },
    });

    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .send({ gatewayPaymentId: 'sim_PAGA', status: 'failed' })
      .expect(200);

    expect(res.body).toEqual({ ok: true, applied: false, status: 'paid' });
    expect(service.settleFromGateway).toHaveBeenCalledWith('sim_PAGA', 'failed');
    // Na auditoria fica o que o gateway mandou e se foi aplicado, ligado à cobrança encontrada.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        action: 'payment_webhook',
        entityId: 31,
        newValue: { status: 'failed', applied: false },
      }),
    );
  });

  it('corpo vazio com o segredo certo é erro de validação, não liquidação', async () => {
    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .expect(422);

    expect(res.body.error).toBe('validation_error');
    expect(res.body.details).toHaveProperty('gatewayPaymentId');
    expect(res.body.details).toHaveProperty('status');
    expect(service.settleFromGateway).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('sem o cabeçalho do segredo é 401 e nada é liquidado nem auditado', async () => {
    const res = await request(app).post('/api/payments/webhook').send(paidEvent).expect(401);

    expect(res.body).toEqual({
      error: 'invalid_webhook_secret',
      message: 'Assinatura do webhook inválida',
    });
    expect(service.settleFromGateway).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('segredo errado é recusado: do mesmo tamanho, mais curto, mais longo ou vazio', async () => {
    const wrong = [
      `${SECRET.slice(0, -1)}X`, // mesmo tamanho, último caractere diferente
      SECRET.slice(0, -1), // prefixo do segredo
      `${SECRET}0`, // o segredo com sobra
      '',
    ];
    for (const given of wrong) {
      const res = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-secret', given)
        .send(paidEvent);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_webhook_secret');
    }
    expect(service.settleFromGateway).not.toHaveBeenCalled();
  });

  it('token de usuário logado não substitui o segredo', async () => {
    const res = await request(app)
      .post('/api/payments/webhook')
      .set(bearer(7, 'admin'))
      .send(paidEvent)
      .expect(401);

    expect(res.body.error).toBe('invalid_webhook_secret');
    expect(service.settleFromGateway).not.toHaveBeenCalled();
  });

  it('sem segredo configurado no ambiente o webhook fica desligado (503), mande o chamador o que mandar', async () => {
    env.PAYMENT_WEBHOOK_SECRET = '';

    const semCabecalho = await request(app).post('/api/payments/webhook').send(paidEvent);
    expect(semCabecalho.status).toBe(503);
    expect(semCabecalho.body).toEqual({
      error: 'webhook_disabled',
      message: 'Webhook de pagamentos não configurado',
    });
    // Segredo vazio no ambiente não pode casar com cabeçalho vazio.
    const vazio = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', '')
      .send(paidEvent);
    expect(vazio.status).toBe(503);
    expect(service.settleFromGateway).not.toHaveBeenCalled();
  });

  it('o segredo é conferido antes do corpo: corpo inválido com segredo errado é 401, com o certo é 422', async () => {
    const invalid = { gatewayPaymentId: 'sim_ABC', status: 'refunded' };

    await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', 'errado')
      .send(invalid)
      .expect(401);
    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .send(invalid)
      .expect(422);

    expect(res.body.error).toBe('validation_error');
    expect(res.body.details).toHaveProperty('status');
    expect(service.settleFromGateway).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('evento sem a referência da cobrança é recusado na validação', async () => {
    for (const body of [{ status: 'paid' }, { gatewayPaymentId: '', status: 'paid' }]) {
      const res = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-secret', SECRET)
        .send(body)
        .expect(422);
      expect(res.body.details).toHaveProperty('gatewayPaymentId');
    }
    expect(service.settleFromGateway).not.toHaveBeenCalled();
  });

  it('cobrança desconhecida: a recusa do service vira a resposta e nada é auditado', async () => {
    service.settleFromGateway.mockRejectedValue(
      new HttpError(404, 'Cobrança não encontrada', 'payment_not_found'),
    );

    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .send(paidEvent)
      .expect(404);

    expect(res.body).toEqual({ error: 'payment_not_found', message: 'Cobrança não encontrada' });
    expect(log).not.toHaveBeenCalled();
  });

  it('só existe como POST', async () => {
    await request(app).get('/api/payments/webhook').set('x-webhook-secret', SECRET).expect(404);
    expect(service.settleFromGateway).not.toHaveBeenCalled();
  });

  // O Node junta cabeçalhos repetidos numa string só, então a lista não chega pelo HTTP de
  // verdade; o controller ainda assim trata o tipo `string[]`, e o handler é chamado direto.
  it('cabeçalho do segredo em lista vale pelo primeiro valor; sem ip nem user-agent a auditoria grava nulos', async () => {
    service.settleFromGateway.mockResolvedValue(settled(true));
    const res = { json: vi.fn() };
    const req = (secrets: string[]) =>
      ({ headers: { 'x-webhook-secret': secrets }, body: paidEvent }) as unknown as Request;

    await webhook(req([SECRET, 'outro']), res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ ok: true, applied: true, status: 'paid' });
    expect(service.settleFromGateway).toHaveBeenCalledWith('sim_ABC', 'paid');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ ip: null, userAgent: null }));

    await expect(webhook(req(['outro', SECRET]), res as unknown as Response)).rejects.toMatchObject(
      { statusCode: 401, code: 'invalid_webhook_secret' },
    );
    // A segunda chamada parou no segredo: o service e a resposta ficaram só com a primeira.
    expect(service.settleFromGateway).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('o nome do evento é só informativo: quem decide é o status, e o que vai ao service é a referência e o status', async () => {
    service.settleFromGateway.mockResolvedValue({
      applied: true,
      deposit: { id: 7, status: 'failed' },
    });

    // Evento dizendo "pago" com status de falha: vale o status.
    await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .send({ event: 'charge.paid', gatewayPaymentId: 'sim_ABC', status: 'failed', amount: 9999 })
      .expect(200);

    expect(service.settleFromGateway).toHaveBeenCalledTimes(1);
    expect(service.settleFromGateway).toHaveBeenCalledWith('sim_ABC', 'failed');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: { status: 'failed', applied: true } }),
    );
  });

  it('referência da cobrança ou nome do evento acima do tamanho aceito é erro de validação', async () => {
    const tooLong: [Record<string, unknown>, string][] = [
      [{ gatewayPaymentId: 'x'.repeat(101), status: 'paid' }, 'gatewayPaymentId'],
      [{ event: 'e'.repeat(61), gatewayPaymentId: 'sim_ABC', status: 'paid' }, 'event'],
    ];
    for (const [body, field] of tooLong) {
      const res = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-secret', SECRET)
        .send(body)
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toHaveProperty(field);
    }
    expect(service.settleFromGateway).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('falha inesperada do service vira 500 genérico, sem vazar o erro e sem auditar', async () => {
    service.settleFromGateway.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3306'));

    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', SECRET)
      .send(paidEvent)
      .expect(500);

    // RNF-039: a resposta de erro nunca leva a mensagem interna.
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    expect(log).not.toHaveBeenCalled();
  });
});
