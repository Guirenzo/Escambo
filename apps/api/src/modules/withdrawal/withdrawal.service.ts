import type { Paginated, Withdrawal, WithdrawalMethod, WithdrawalStatus } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { withdrawalRepository, type WithdrawalRow } from './withdrawal.repository';
import type { CreateWithdrawalInput, ListWithdrawalsInput } from './withdrawal.schema';

/** Mascara chave PIX / conta na resposta (nunca expõe o valor completo). */
function mask(value: string): string {
  const v = value.trim();
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
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
  };
}

export const withdrawalService = {
  async request(userId: number, input: CreateWithdrawalInput): Promise<Withdrawal> {
    const id = await withdrawalRepository.createIfSufficient({
      userId,
      amount: input.amount,
      pixKey: input.method === 'pix' ? (input.pixKey ?? null) : null,
      bankName: input.method === 'bank' ? (input.bankName ?? null) : null,
      bankAgency: input.method === 'bank' ? (input.bankAgency ?? null) : null,
      bankAccount: input.method === 'bank' ? (input.bankAccount ?? null) : null,
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
};
