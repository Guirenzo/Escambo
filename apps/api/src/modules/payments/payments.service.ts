import { ulid } from 'ulid';
import type { Deposit, DepositStatus, Paginated } from '@escambo/types';
import { env } from '../../config/env';
import { HttpError } from '../../utils/http-error';
import { notificationsService } from '../notifications/notifications.service';
import { paymentGateway } from './gateway';
import { paymentsRepository, type PaymentRow } from './payments.repository';
import type { CreateDepositInput } from './payments.schema';

const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function isExpired(row: PaymentRow): boolean {
  return (
    row.status === 'pending' && !!row.expires_at && new Date(row.expires_at).getTime() < Date.now()
  );
}

export function toDeposit(row: PaymentRow): Deposit {
  const raw = row.gateway_response;
  const response =
    raw == null ? {} : typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
  // Cobrança vencida aparece cancelada mesmo antes do job de expiração passar.
  const status: DepositStatus = isExpired(row) ? 'cancelled' : (row.status as DepositStatus);
  return {
    id: row.id,
    amount: Number(row.amount),
    status,
    method: 'pix',
    gateway: row.gateway,
    reference: row.gateway_payment_id,
    pixCode: status === 'pending' ? ((response.pixCode as string | undefined) ?? null) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    canSimulate: env.PAYMENTS_SIMULATE && status === 'pending',
  };
}

async function loadOwned(id: number, userId: number): Promise<PaymentRow> {
  const row = await paymentsRepository.findById(id);
  if (!row || row.kind !== 'topup')
    throw new HttpError(404, 'Depósito não encontrado', 'deposit_not_found');
  if (row.payer_id !== userId) throw new HttpError(403, 'Este depósito não é seu', 'forbidden');
  return row;
}

function notifyPaid(row: PaymentRow): void {
  void notificationsService.notify(row.payer_id, {
    type: 'deposit_confirmed',
    title: `Depósito de ${brl(Number(row.amount))} confirmado`,
    body: 'O valor já está disponível na sua carteira para contratar.',
    data: { paymentId: row.id, amount: Number(row.amount) },
  });
}

export const paymentsService = {
  /** Cria a cobrança PIX no gateway e a registra como depósito pendente. */
  async createDeposit(userId: number, input: CreateDepositInput): Promise<Deposit> {
    const reference = ulid();
    const charge = await paymentGateway.createPixCharge({ amount: input.amount, reference });
    const id = await paymentsRepository.createTopup({
      payerId: userId,
      amount: input.amount,
      gateway: paymentGateway.name,
      gatewayPaymentId: charge.externalId,
      pixCode: charge.pixCode,
      expiresAt: charge.expiresAt,
    });
    return toDeposit((await paymentsRepository.findById(id))!);
  },

  async getDeposit(id: number, userId: number): Promise<Deposit> {
    return toDeposit(await loadOwned(id, userId));
  },

  async listDeposits(userId: number, page: number, limit: number): Promise<Paginated<Deposit>> {
    const rows = await paymentsRepository.listTopupsForUser(userId, limit, (page - 1) * limit);
    return { items: rows.map(toDeposit), page, limit };
  },

  /**
   * Confirmação vinda do GATEWAY (webhook): idempotente por `gatewayPaymentId`.
   * Retorna se o evento foi aplicado (false = já estava liquidado).
   */
  async settleFromGateway(
    gatewayPaymentId: string,
    status: 'paid' | 'failed',
  ): Promise<{ applied: boolean; deposit: Deposit }> {
    const row = await paymentsRepository.findByGatewayId(gatewayPaymentId);
    if (!row) throw new HttpError(404, 'Cobrança não encontrada', 'payment_not_found');
    const applied = await paymentsRepository.settle(row.id, status);
    if (applied && status === 'paid') notifyPaid(row);
    return { applied, deposit: toDeposit((await paymentsRepository.findById(row.id))!) };
  },

  /** Demo/dev: o próprio usuário "paga" a cobrança (só com PAYMENTS_SIMULATE=true). */
  async simulate(id: number, userId: number): Promise<Deposit> {
    if (!env.PAYMENTS_SIMULATE) {
      throw new HttpError(
        403,
        'Simulação de pagamento desligada neste ambiente',
        'simulation_disabled',
      );
    }
    const row = await loadOwned(id, userId);
    if (isExpired(row))
      throw new HttpError(409, 'Cobrança vencida; gere um novo depósito', 'deposit_expired');
    const applied = await paymentsRepository.settle(row.id, 'paid');
    if (!applied) throw new HttpError(409, 'Este depósito já foi liquidado', 'deposit_not_pending');
    notifyPaid(row);
    return toDeposit((await paymentsRepository.findById(row.id))!);
  },

  /** Job: cobranças vencidas viram canceladas. */
  async expirePending(): Promise<number> {
    return paymentsRepository.expirePending();
  },
};
