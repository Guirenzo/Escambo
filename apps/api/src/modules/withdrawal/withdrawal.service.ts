import type {
  AdminWithdrawal,
  Paginated,
  Withdrawal,
  WithdrawalMethod,
  WithdrawalStatus,
} from '@escambo/types';
import { businessDueAt } from '../../utils/business-days';
import { clock } from '../../utils/clock';
import { FIELD_UNAVAILABLE } from '../../utils/field-crypto';
import { HttpError } from '../../utils/http-error';
import { adminFacade } from '../admin/admin.facade';
import { notificationsService } from '../notifications/notifications.service';
import {
  withdrawalRepository,
  type AdminWithdrawalRow,
  type WithdrawalRow,
} from './withdrawal.repository';
import type { CreateWithdrawalInput, ListWithdrawalsInput } from './withdrawal.schema';
import { settingsService } from '../settings/settings.service';

/** Mascara chave PIX / conta na resposta (nunca expõe o valor completo). */
function mask(value: string): string {
  // Destino cifrado que não decifrou (RNF-017): o marcador vai inteiro, e não "••••vel]".
  if (value === FIELD_UNAVAILABLE) return value;
  const v = value.trim();
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function destinationOf(row: WithdrawalRow): string {
  if (row.pix_key) return row.pix_key;
  return [row.bank_name, row.bank_agency, row.bank_account].filter(Boolean).join(' · ');
}

function toWithdrawal(row: WithdrawalRow): Withdrawal {
  const method: WithdrawalMethod = row.pix_key ? 'pix' : 'bank';
  const destination = row.pix_key ?? row.bank_account ?? '';
  return {
    id: row.id,
    amount: Number(row.amount),
    status: row.status as WithdrawalStatus,
    method,
    maskedDestination: mask(destination),
    createdAt: new Date(row.created_at).toISOString(),
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
  };
}

const OPEN: WithdrawalStatus[] = ['requested', 'processing'];

/** Ainda não pago e já passou do prazo gravado no pedido (RN-035), no relógio do fluxo. */
function isOverdue(row: WithdrawalRow, now: Date): boolean {
  return (
    OPEN.includes(row.status as WithdrawalStatus) &&
    row.due_at !== null &&
    new Date(row.due_at).getTime() < now.getTime()
  );
}

/** Visão do admin: destino completo, porque é ele quem executa o pagamento. */
function toAdminWithdrawal(row: AdminWithdrawalRow, now: Date): AdminWithdrawal {
  return {
    ...toWithdrawal(row),
    userId: row.user_id,
    userUlid: row.user_ulid,
    userEmail: row.user_email,
    userName: row.user_name,
    destination: destinationOf(row),
    overdue: isOverdue(row, now),
  };
}

async function loadOr404(id: number): Promise<WithdrawalRow> {
  const row = await withdrawalRepository.findById(id);
  if (!row) throw new HttpError(404, 'Saque não encontrado', 'withdrawal_not_found');
  return row;
}

export const withdrawalService = {
  async request(userId: number, input: CreateWithdrawalInput): Promise<Withdrawal> {
    const min = await settingsService.minWithdrawal();
    if (input.amount < min) {
      throw new HttpError(422, `Saque mínimo é ${brl(min)} (RN-034)`, 'below_minimum');
    }
    // E-mail confirmado (ADR 20, RF-006) é conferido na rota (requireVerifiedEmail), como nas
    // outras ações críticas: uma sessão roubada não manda o saldo para um PIX de terceiro sem aviso.
    // Prazo (RN-035) com o parâmetro que vale agora: gravado no saque, não muda se o admin mexer.
    const businessDays = await settingsService.withdrawalBusinessDays(input.method);
    const id = await withdrawalRepository.createIfSufficient({
      userId,
      amount: input.amount,
      pixKey: input.method === 'pix' ? (input.pixKey ?? null) : null,
      bankName: input.method === 'bank' ? (input.bankName ?? null) : null,
      bankAgency: input.method === 'bank' ? (input.bankAgency ?? null) : null,
      bankAccount: input.method === 'bank' ? (input.bankAccount ?? null) : null,
      dueAt: businessDueAt(clock.now(), businessDays),
    });
    if (id === null) {
      throw new HttpError(400, 'Saldo insuficiente para o saque', 'insufficient_balance'); // RN-034
    }
    const row = await withdrawalRepository.findById(id);
    return toWithdrawal(row!);
  },

  async listMine(userId: number, input: ListWithdrawalsInput): Promise<Paginated<Withdrawal>> {
    const rows = await withdrawalRepository.listForUser(
      userId,
      input.limit,
      (input.page - 1) * input.limit,
    );
    return { items: rows.map(toWithdrawal), page: input.page, limit: input.limit };
  },

  /** O titular desiste antes do processamento: valor volta na hora. */
  async cancelMine(id: number, userId: number): Promise<Withdrawal> {
    const row = await loadOr404(id);
    if (row.user_id !== userId) throw new HttpError(403, 'Este saque não é seu', 'forbidden');
    const ok = await withdrawalRepository.closeAndRefund(id, ['requested'], 'cancelled');
    if (!ok) {
      throw new HttpError(
        409,
        'O saque já está em processamento ou encerrado',
        'invalid_transition',
      );
    }
    return toWithdrawal((await withdrawalRepository.findById(id))!);
  },

  // ---------- Processamento pelo admin ----------

  async listForAdmin(filter: 'open' | 'all' | WithdrawalStatus): Promise<AdminWithdrawal[]> {
    const statuses =
      filter === 'open'
        ? OPEN
        : filter === 'all'
          ? ['requested', 'processing', 'completed', 'failed', 'cancelled']
          : [filter];
    const now = clock.now();
    return (await withdrawalRepository.listForAdmin(statuses, 200)).map((row) =>
      toAdminWithdrawal(row, now),
    );
  },

  /** requested → processing: o admin assumiu o pagamento. */
  async process(adminId: number, id: number): Promise<AdminWithdrawal> {
    await loadOr404(id);
    const ok = await withdrawalRepository.advance(id, ['requested'], 'processing', null);
    if (!ok)
      throw new HttpError(409, 'Saque não está aguardando processamento', 'invalid_transition');
    await adminFacade.recordAction(adminId, 'withdrawal_processing', 'withdrawal', id, null);
    return this.adminView(id);
  },

  /** requested|processing → completed: pagamento feito (referência do banco/gateway opcional). */
  async complete(adminId: number, id: number, gatewayRef: string | null): Promise<AdminWithdrawal> {
    const row = await loadOr404(id);
    const ok = await withdrawalRepository.advance(id, OPEN, 'completed', gatewayRef);
    if (!ok) throw new HttpError(409, 'Saque já encerrado', 'invalid_transition');
    await adminFacade.recordAction(
      adminId,
      'withdrawal_completed',
      'withdrawal',
      id,
      gatewayRef ? `ref=${gatewayRef}` : null,
    );
    void notificationsService.notify(row.user_id, {
      type: 'withdrawal_completed',
      title: `Saque de ${brl(Number(row.amount))} concluído`,
      body: `Enviado para ${mask(destinationOf(row))}.`,
      data: { withdrawalId: id, amount: Number(row.amount) },
    });
    return this.adminView(id);
  },

  /** requested|processing → failed: não foi possível pagar; o valor volta à carteira. */
  async fail(adminId: number, id: number, reason: string | null): Promise<AdminWithdrawal> {
    const row = await loadOr404(id);
    const ok = await withdrawalRepository.closeAndRefund(id, OPEN, 'failed');
    if (!ok) throw new HttpError(409, 'Saque já encerrado', 'invalid_transition');
    await adminFacade.recordAction(adminId, 'withdrawal_failed', 'withdrawal', id, reason);
    void notificationsService.notify(row.user_id, {
      type: 'withdrawal_failed',
      title: `Saque de ${brl(Number(row.amount))} não pôde ser feito`,
      body: `${reason ?? 'Dados de destino inválidos'}. O valor voltou para a sua carteira.`,
      data: { withdrawalId: id, amount: Number(row.amount) },
    });
    return this.adminView(id);
  },

  async adminView(id: number): Promise<AdminWithdrawal> {
    const row = await withdrawalRepository.findForAdmin(id);
    if (!row) throw new HttpError(404, 'Saque não encontrado', 'withdrawal_not_found');
    return toAdminWithdrawal(row, clock.now());
  },
};
