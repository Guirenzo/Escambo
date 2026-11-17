import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { auditService } from '../audit/audit.service';
import { MercadoPagoError, verifyWebhookSignature } from './mercadopago';
import { shortText } from './payment-events';
import {
  createDepositSchema,
  depositIdParamSchema,
  listDepositsSchema,
  webhookSchema,
} from './payments.schema';
import { paymentsService } from './payments.service';

const audit = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});

/** POST /api/wallet/deposits — gera a cobrança (PIX simulado ou Mercado Pago) de um depósito. */
export async function createDeposit(req: Request, res: Response): Promise<void> {
  const input = createDepositSchema.parse(req.body);
  const deposit = await paymentsService.createDeposit(req.user!.uid, input);
  void auditService.log({
    userId: req.user!.uid,
    action: 'deposit_created',
    entityType: 'payment',
    entityId: deposit.id,
    newValue: { amount: deposit.amount, gateway: deposit.gateway },
    ...audit(req),
  });
  res.status(201).json(deposit);
}

/** GET /api/wallet/deposits — meus depósitos (mais recentes primeiro). */
export async function listDeposits(req: Request, res: Response): Promise<void> {
  const { page, limit } = listDepositsSchema.parse(req.query);
  res.json(await paymentsService.listDeposits(req.user!.uid, page, limit));
}

/** GET /api/wallet/deposits/:id — situação da cobrança (o front consulta até confirmar). */
export async function getDeposit(req: Request, res: Response): Promise<void> {
  const { id } = depositIdParamSchema.parse(req.params);
  res.json(await paymentsService.getDeposit(id, req.user!.uid));
}

/** POST /api/wallet/deposits/:id/simulate — demo: confirma a cobrança sem gateway. */
export async function simulateDeposit(req: Request, res: Response): Promise<void> {
  const { id } = depositIdParamSchema.parse(req.params);
  const deposit = await paymentsService.simulate(id, req.user!.uid);
  void auditService.log({
    userId: req.user!.uid,
    action: 'deposit_simulated',
    entityType: 'payment',
    entityId: id,
    newValue: { amount: deposit.amount },
    ...audit(req),
  });
  res.json(deposit);
}

/** Compara o segredo do webhook em tempo constante. */
function secretMatches(given: string | undefined): boolean {
  const expected = Buffer.from(env.PAYMENT_WEBHOOK_SECRET);
  const actual = Buffer.from(given ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * POST /api/payments/webhook — notificação do gateway (pago/falhou). Sem autenticação de
 * usuário: protegido pelo segredo compartilhado no header `x-webhook-secret`.
 */
export async function webhook(req: Request, res: Response): Promise<void> {
  if (!env.PAYMENT_WEBHOOK_SECRET) {
    throw new HttpError(503, 'Webhook de pagamentos não configurado', 'webhook_disabled');
  }
  const header = req.headers['x-webhook-secret'];
  if (!secretMatches(Array.isArray(header) ? header[0] : header)) {
    throw new HttpError(401, 'Assinatura do webhook inválida', 'invalid_webhook_secret');
  }
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    // Veio do gateway (o segredo confere), então o corpo fica no histórico (RF-050); se a gravação
    // falhar, a resposta continua a recusa do formato (422), não um 500.
    await paymentsService
      .recordInvalidWebhook(req.body)
      .catch((err: unknown) => logger.warn({ err }, 'histórico do webhook inválido falhou'));
    throw parsed.error;
  }
  const input = parsed.data;
  const result = await paymentsService.settleFromGateway(input.gatewayPaymentId, input.status, {
    event: input.event ?? null,
    body: req.body,
  });
  void auditService.log({
    userId: null,
    action: 'payment_webhook',
    entityType: 'payment',
    entityId: result.deposit.id,
    newValue: { status: input.status, applied: result.applied },
    ...audit(req),
  });
  res.json({ ok: true, applied: result.applied, status: result.deposit.status });
}

const firstHeader = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** O id do pagamento que o aviso anuncia: na query (`data.id`, o que a assinatura cobre) ou no corpo. */
function announcedId(req: Request): string | null {
  const fromQuery = shortText(req.query['data.id'], 64);
  if (fromQuery) return fromQuery;
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    data?: { id?: unknown };
  };
  const id = body.data?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id).slice(0, 64) : null;
}

/**
 * POST /api/payments/webhook/mercadopago — aviso do Mercado Pago (ADR 73). Sem sessão de usuário:
 * vale a assinatura `x-signature` (HMAC com a chave secreta do painel). O aviso só diz qual
 * pagamento mudou; o service consulta o pagamento na API antes de creditar qualquer coisa.
 * Responde 200 a todo aviso conferido, mesmo o que não muda nada (senão o Mercado Pago repete),
 * e 502 se a API dele não responder (aí ele repete mais tarde, que é o que se quer).
 */
export async function mercadoPagoWebhook(req: Request, res: Response): Promise<void> {
  if (!env.MERCADOPAGO_ACCESS_TOKEN || !env.MERCADOPAGO_WEBHOOK_SECRET) {
    throw new HttpError(503, 'Webhook do Mercado Pago não configurado', 'webhook_disabled');
  }
  const dataId = announcedId(req);
  const signed = verifyWebhookSignature({
    signature: firstHeader(req, 'x-signature'),
    requestId: firstHeader(req, 'x-request-id'),
    dataId: dataId ?? undefined,
    secret: env.MERCADOPAGO_WEBHOOK_SECRET,
  });
  if (!signed) {
    throw new HttpError(401, 'Assinatura do webhook inválida', 'invalid_webhook_signature');
  }
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;
  const type = shortText(req.query.type, 40) ?? shortText(body.type, 40);
  // Só pagamento interessa (merchant_order e outros tópicos chegam se ligados no painel).
  if (type !== 'payment' || !dataId || !/^[A-Za-z0-9_-]+$/.test(dataId)) {
    res.json({ ok: true, outcome: 'ignored' });
    return;
  }
  let result: Awaited<ReturnType<typeof paymentsService.settleFromMercadoPago>>;
  try {
    result = await paymentsService.settleFromMercadoPago(dataId, {
      event: shortText(body.action, 60),
      body: req.body,
    });
  } catch (err) {
    if (err instanceof MercadoPagoError) {
      throw new HttpError(
        502,
        'Mercado Pago indisponível; o aviso será repetido',
        'gateway_unavailable',
      );
    }
    throw err;
  }
  void auditService.log({
    userId: null,
    action: 'payment_webhook',
    entityType: 'payment',
    entityId: result.depositId,
    newValue: { gateway: 'mercadopago', outcome: result.outcome },
    ...audit(req),
  });
  res.json({ ok: true, outcome: result.outcome });
}
