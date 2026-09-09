import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { HttpError } from '../../utils/http-error';
import { auditService } from '../audit/audit.service';
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

/** POST /api/wallet/deposits — gera a cobrança PIX de um depósito na carteira. */
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
  const input = webhookSchema.parse(req.body);
  const result = await paymentsService.settleFromGateway(input.gatewayPaymentId, input.status);
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
