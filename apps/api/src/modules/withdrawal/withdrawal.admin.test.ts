import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./withdrawal.repository', () => ({
  withdrawalRepository: {
    createIfSufficient: vi.fn(),
    findById: vi.fn(),
    findForAdmin: vi.fn(),
    listForUser: vi.fn(),
    listForAdmin: vi.fn(),
    advance: vi.fn(),
    closeAndRefund: vi.fn(),
  },
}));
vi.mock('../admin/admin.repository', () => ({
  adminRepository: { recordAction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { adminRepository } from '../admin/admin.repository';
import { notificationsService } from '../notifications/notifications.service';
import {
  withdrawalRepository,
  type AdminWithdrawalRow,
  type WithdrawalRow,
} from './withdrawal.repository';
import { withdrawalService } from './withdrawal.service';

const repo = vi.mocked(withdrawalRepository);
const notify = vi.mocked(notificationsService.notify);

const base: {
  id: number;
  user_id: number;
  amount: string;
  status: string;
  pix_key: string | null;
  bank_name: string | null;
  bank_agency: string | null;
  bank_account: string | null;
  gateway_ref: string | null;
  created_at: Date;
  processed_at: Date | null;
} = {
  id: 9,
  user_id: 4,
  amount: '120.00',
  status: 'requested',
  pix_key: 'chave-pix-final-4321',
  bank_name: null,
  bank_agency: null,
  bank_account: null,
  gateway_ref: null,
  created_at: new Date('2026-09-01T00:00:00Z'),
  processed_at: null,
};
const row = (o: Partial<typeof base> = {}): WithdrawalRow =>
  ({ ...base, ...o }) as unknown as WithdrawalRow;
const adminRow = (o: Partial<typeof base> = {}): AdminWithdrawalRow =>
  ({
    ...base,
    ...o,
    user_ulid: '01USERULID00000000000000000',
    user_email: 'freela@escambo.test',
    user_name: 'Freela',
  }) as unknown as AdminWithdrawalRow;

beforeEach(() => vi.clearAllMocks());

describe('processamento de saques pelo admin', () => {
  it('complete: marca pago, registra a ação e avisa o titular (destino mascarado)', async () => {
    repo.findById.mockResolvedValue(row());
    repo.advance.mockResolvedValue(true);
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'completed', gateway_ref: 'E2E-1' }));

    const w = await withdrawalService.complete(1, 9, 'E2E-1');

    expect(repo.advance).toHaveBeenCalledWith(9, ['requested', 'processing'], 'completed', 'E2E-1');
    expect(adminRepository.recordAction).toHaveBeenCalledWith(
      1,
      'withdrawal_completed',
      'withdrawal',
      9,
      'ref=E2E-1',
    );
    expect(notify).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ type: 'withdrawal_completed' }),
    );
    expect(w).toMatchObject({
      status: 'completed',
      destination: 'chave-pix-final-4321',
      userEmail: 'freela@escambo.test',
    });
  });

  it('fail: devolve o valor à carteira e avisa com o motivo', async () => {
    repo.findById.mockResolvedValue(row({ status: 'processing' }));
    repo.closeAndRefund.mockResolvedValue(true);
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'failed' }));

    const w = await withdrawalService.fail(1, 9, 'Chave PIX inexistente');

    expect(repo.closeAndRefund).toHaveBeenCalledWith(9, ['requested', 'processing'], 'failed');
    expect(notify).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        type: 'withdrawal_failed',
        body: expect.stringContaining('Chave PIX inexistente'),
      }),
    );
    expect(w.status).toBe('failed');
  });

  it('409 quando o saque já está encerrado', async () => {
    repo.findById.mockResolvedValue(row({ status: 'completed' }));
    repo.advance.mockResolvedValue(false);
    await expect(withdrawalService.complete(1, 9, null)).rejects.toMatchObject({ statusCode: 409 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('process: requested → processing', async () => {
    repo.findById.mockResolvedValue(row());
    repo.advance.mockResolvedValue(true);
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'processing' }));
    const w = await withdrawalService.process(1, 9);
    expect(repo.advance).toHaveBeenCalledWith(9, ['requested'], 'processing', null);
    expect(w.status).toBe('processing');
  });
});

describe('cancelamento pelo titular', () => {
  it('só o dono cancela, e só enquanto está aguardando', async () => {
    repo.findById.mockResolvedValue(row());
    await expect(withdrawalService.cancelMine(9, 99)).rejects.toMatchObject({ statusCode: 403 });

    repo.closeAndRefund.mockResolvedValue(false);
    await expect(withdrawalService.cancelMine(9, 4)).rejects.toMatchObject({ statusCode: 409 });

    repo.closeAndRefund.mockResolvedValue(true);
    repo.findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: 'cancelled' }));
    const w = await withdrawalService.cancelMine(9, 4);
    expect(repo.closeAndRefund).toHaveBeenCalledWith(9, ['requested'], 'cancelled');
    expect(w.status).toBe('cancelled');
  });
});
