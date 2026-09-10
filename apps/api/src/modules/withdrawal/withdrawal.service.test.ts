import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./withdrawal.repository', () => ({
  withdrawalRepository: { createIfSufficient: vi.fn(), findById: vi.fn() },
}));
vi.mock('../auth/auth.repository', () => ({ authRepository: { findById: vi.fn() } }));
vi.mock('../admin/admin.repository', () => ({ adminRepository: { recordAction: vi.fn() } }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));

import { HttpError } from '../../utils/http-error';
import { authRepository, type UserRow } from '../auth/auth.repository';
import { withdrawalRepository, type WithdrawalRow } from './withdrawal.repository';
import { withdrawalService } from './withdrawal.service';

const repo = vi.mocked(withdrawalRepository);
const users = vi.mocked(authRepository);

const userRow = (verified: boolean): UserRow =>
  ({
    id: 7,
    ulid: 'U',
    email: 'f@escambo.test',
    password_hash: 'x',
    role: 'freelancer',
    status: verified ? 'active' : 'pending_verification',
    email_verified_at: verified ? new Date('2026-01-01T00:00:00Z') : null,
  }) as UserRow;

const input = { amount: 100, method: 'pix' as const, pixKey: 'chave-secreta@escambo.test' };

beforeEach(() => vi.clearAllMocks());

describe('withdrawalService.request', () => {
  it('exige e-mail confirmado: 403 email_not_verified sem tocar no saldo', async () => {
    users.findById.mockResolvedValue(userRow(false));

    await expect(withdrawalService.request(7, input)).rejects.toMatchObject({
      statusCode: 403,
      code: 'email_not_verified',
    } satisfies Partial<HttpError>);
    expect(repo.createIfSufficient).not.toHaveBeenCalled();
  });

  it('sem saldo: 400 insufficient_balance (RN-034)', async () => {
    users.findById.mockResolvedValue(userRow(true));
    repo.createIfSufficient.mockResolvedValue(null);

    await expect(withdrawalService.request(7, input)).rejects.toMatchObject({
      statusCode: 400,
      code: 'insufficient_balance',
    });
  });

  it('com e-mail confirmado e saldo: cria o saque e mascara o destino', async () => {
    users.findById.mockResolvedValue(userRow(true));
    repo.createIfSufficient.mockResolvedValue(42);
    repo.findById.mockResolvedValue({
      id: 42,
      user_id: 7,
      amount: '100.00',
      status: 'requested',
      pix_key: input.pixKey,
      bank_name: null,
      bank_agency: null,
      bank_account: null,
      created_at: new Date('2026-09-10T12:00:00Z'),
      processed_at: null,
    } as unknown as WithdrawalRow);

    const w = await withdrawalService.request(7, input);

    expect(repo.createIfSufficient).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, amount: 100, pixKey: input.pixKey, bankName: null }),
    );
    expect(w).toMatchObject({ id: 42, amount: 100, status: 'requested', method: 'pix' });
    expect(w.maskedDestination).toBe('••••test');
    expect(w.maskedDestination).not.toContain('chave-secreta');
  });
});
