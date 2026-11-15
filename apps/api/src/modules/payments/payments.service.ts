import { ulid } from 'ulid';
import type { Deposit, DepositMethod, DepositStatus, Paginated } from '@escambo/types';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { notificationsService } from '../notifications/notifications.service';
import { MERCADOPAGO_GATEWAY, SIMULATED_GATEWAY, paymentGateway } from './gateway';
import { MercadoPagoError, getPayment, methodFromPaymentType } from './mercadopago';
import { chargeResponse, sanitizeGatewayPayload, shortText } from './payment-events';
import { paymentsRepository, type PaymentRow } from './payments.repository';
import type { CreateDepositInput } from './payments.schema';

/** Desfecho do aviso do Mercado Pago, para a resposta do webhook e a auditoria. */
export type MercadoPagoOutcome = 'applied' | 'ignored' | 'not_found' | 'mismatch';

/** O webhook como chegou: o nome do evento (se veio) e o corpo inteiro, para o histórico. */
export interface WebhookReceipt {
  event: string | null;
  body: unknown;
}

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
  const pending = status === 'pending';
  const simulated = row.gateway === SIMULATED_GATEWAY;
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    id: row.id,
    amount: Number(row.amount),
    status,
    // No Mercado Pago a pessoa escolhe como pagar na página dele: até pagar, não há forma.
    method:
      row.gateway === MERCADOPAGO_GATEWAY && status !== 'paid'
        ? null
        : (row.method as DepositMethod),
    gateway: row.gateway,
    reference: row.gateway_payment_id,
    pixCode: pending ? text(response.pixCode) : null,
    checkoutUrl: pending ? text(response.checkoutUrl) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    // Só a cobrança do gateway simulado: a do Mercado Pago se paga lá, nunca por aqui.
    canSimulate: env.PAYMENTS_SIMULATE && pending && simulated,
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
  /**
   * Cria a cobrança no gateway (o PIX simulado ou a página do Mercado Pago) e a registra como
   * depósito pendente, com a resposta completa da criação guardada para auditoria (RF-050).
   */
  async createDeposit(userId: number, input: CreateDepositInput): Promise<Deposit> {
    const reference = ulid();
    const charge = await paymentGateway
      .createCharge({ amount: input.amount, reference })
      .catch((err: unknown) => {
        if (err instanceof MercadoPagoError) {
          throw new HttpError(
            502,
            'O Mercado Pago não respondeu; tente de novo em instantes',
            'gateway_unavailable',
          );
        }
        throw err;
      });
    const id = await paymentsRepository.createTopup({
      payerId: userId,
      amount: input.amount,
      gateway: paymentGateway.name,
      gatewayPaymentId: charge.externalId,
      response: chargeResponse(charge),
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
   * Confirmação vinda do GATEWAY (webhook): idempotente por `gatewayPaymentId` no efeito, mas todo
   * webhook recebido fica no histórico (RF-050): o que liquida, junto com a liquidação; o repetido
   * (`ignored`) e o de cobrança desconhecida (`not_found`), numa linha à parte.
   * Retorna se o evento foi aplicado (false = já estava liquidado).
   */
  async settleFromGateway(
    gatewayPaymentId: string,
    status: 'paid' | 'failed',
    receipt: WebhookReceipt,
  ): Promise<{ applied: boolean; deposit: Deposit }> {
    const notice = {
      source: 'webhook' as const,
      event: receipt.event,
      payload: sanitizeGatewayPayload(receipt.body),
    };
    const found = await paymentsRepository.findByGatewayId(gatewayPaymentId);
    // Este é o webhook do gateway simulado: a cobrança do Mercado Pago só liquida pelo webhook
    // assinado dele, com o pagamento conferido na API (settleFromMercadoPago).
    const row = found?.gateway === SIMULATED_GATEWAY ? found : undefined;
    if (!row) {
      await paymentsRepository.recordEvent({
        ...notice,
        paymentId: null,
        gateway: SIMULATED_GATEWAY,
        gatewayPaymentId,
        status,
        outcome: 'not_found',
      });
      throw new HttpError(404, 'Cobrança não encontrada', 'payment_not_found');
    }
    const applied = await paymentsRepository.settle(row.id, status, notice);
    if (!applied) {
      await paymentsRepository.recordEvent({
        ...notice,
        paymentId: row.id,
        gateway: row.gateway,
        gatewayPaymentId,
        status,
        outcome: 'ignored',
      });
    }
    if (applied && status === 'paid') notifyPaid(row);
    return { applied, deposit: toDeposit((await paymentsRepository.findById(row.id))!) };
  },

  /**
   * Aviso do Mercado Pago (assinatura já conferida): "o pagamento N mudou". O que vale é a consulta
   * de N na API com o nosso token, nunca o corpo do aviso. Só liquida quando o pagamento está
   * aprovado, aponta para um depósito nosso (external_reference) e tem a mesma moeda e o mesmo
   * valor. Recusado, pendente ou em análise fica registrado e o depósito segue pendente (a pessoa
   * pode tentar de novo na mesma página até vencer). Nenhum desfecho lança erro: o Mercado Pago
   * repete o aviso que não recebe 200, e repetir não muda nada.
   */
  async settleFromMercadoPago(
    mpPaymentId: string,
    receipt: WebhookReceipt,
  ): Promise<{ outcome: MercadoPagoOutcome; depositId: number | null }> {
    let mp: Awaited<ReturnType<typeof getPayment>>;
    try {
      mp = await getPayment(mpPaymentId);
    } catch (err) {
      // Pagamento que o Mercado Pago não conhece (o "simular" do painel manda um id inventado):
      // repetir não muda nada, então fica no histórico e responde 200. O resto sobe (502, ele repete).
      if (!(err instanceof MercadoPagoError && err.status === 404)) throw err;
      await paymentsRepository.recordEvent({
        paymentId: null,
        gateway: MERCADOPAGO_GATEWAY,
        gatewayPaymentId: null,
        source: 'webhook',
        event: receipt.event,
        status: null,
        outcome: 'not_found',
        payload: sanitizeGatewayPayload({ notice: receipt.body }),
      });
      return { outcome: 'not_found', depositId: null };
    }
    const payload = sanitizeGatewayPayload({ notice: receipt.body, payment: mp.raw });
    const notice = { source: 'webhook' as const, event: receipt.event, payload };
    const found = mp.externalReference
      ? await paymentsRepository.findByGatewayId(mp.externalReference)
      : undefined;
    const row = found?.gateway === MERCADOPAGO_GATEWAY ? found : undefined;
    const record = (outcome: 'ignored' | 'not_found' | 'invalid') =>
      paymentsRepository.recordEvent({
        ...notice,
        paymentId: row?.id ?? null,
        gateway: MERCADOPAGO_GATEWAY,
        gatewayPaymentId: row?.gateway_payment_id ?? shortText(mp.externalReference, 100),
        status: shortText(mp.status, 20),
        outcome,
      });
    if (!row) {
      await record('not_found');
      return { outcome: 'not_found', depositId: null };
    }
    const cents = (v: number): number => Math.round(v * 100);
    if (
      mp.currency !== 'BRL' ||
      mp.amount === null ||
      cents(mp.amount) !== cents(Number(row.amount))
    ) {
      // Pagamento de outro valor apontando para o nosso depósito: não credita, e alguém precisa ver.
      logger.warn(
        { paymentId: row.id, mpPaymentId, status: mp.status },
        'Mercado Pago: valor ou moeda do pagamento não conferem com o depósito',
      );
      await record('invalid');
      return { outcome: 'mismatch', depositId: row.id };
    }
    if (mp.status !== 'approved') {
      await record('ignored');
      return { outcome: 'ignored', depositId: row.id };
    }
    const applied = await paymentsRepository.settle(row.id, 'paid', notice, {
      method: methodFromPaymentType(mp.paymentType),
      reopenExpired: true,
    });
    if (!applied) {
      await record('ignored');
      return { outcome: 'ignored', depositId: row.id };
    }
    notifyPaid(row);
    return { outcome: 'applied', depositId: row.id };
  },

  /**
   * Webhook com o segredo certo mas corpo fora do formato: a recusa (422) continua, e o corpo fica
   * no histórico como `invalid`, ligado à cobrança quando o id dela veio e existe.
   */
  async recordInvalidWebhook(body: unknown): Promise<void> {
    const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const gatewayPaymentId = shortText(fields.gatewayPaymentId, 100);
    const row = gatewayPaymentId
      ? await paymentsRepository.findByGatewayId(gatewayPaymentId)
      : undefined;
    await paymentsRepository.recordEvent({
      paymentId: row?.id ?? null,
      gateway: row?.gateway ?? SIMULATED_GATEWAY,
      gatewayPaymentId,
      source: 'webhook',
      event: shortText(fields.event, 60),
      status: shortText(fields.status, 20),
      outcome: 'invalid',
      payload: sanitizeGatewayPayload(body),
    });
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
    // Simular só "paga" a cobrança do gateway simulado: a do Mercado Pago creditaria sem dinheiro.
    if (row.gateway !== SIMULATED_GATEWAY) {
      throw new HttpError(
        409,
        'Este depósito se paga na página do Mercado Pago',
        'deposit_not_simulated',
      );
    }
    if (isExpired(row))
      throw new HttpError(409, 'Cobrança vencida; gere um novo depósito', 'deposit_expired');
    // A simulação faz o papel do gateway: a liquidação entra no histórico como as do webhook.
    const applied = await paymentsRepository.settle(row.id, 'paid', {
      source: 'simulation',
      event: null,
      payload: { status: 'paid' },
    });
    if (!applied) throw new HttpError(409, 'Este depósito já foi liquidado', 'deposit_not_pending');
    notifyPaid(row);
    return toDeposit((await paymentsRepository.findById(row.id))!);
  },

  /** Job: cobranças vencidas viram canceladas. */
  async expirePending(): Promise<number> {
    return paymentsRepository.expirePending();
  },
};
