import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: { minWithdrawal: vi.fn().mockResolvedValue(20) },
}));

vi.mock('./withdrawal.repository', () => ({
  withdrawalRepository: { createIfSufficient: vi.fn(), findById: vi.fn(), listForUser: vi.fn() },
}));
vi.mock('../auth/auth.repository', () => ({ authRepository: { findById: vi.fn() } }));
vi.mock('../admin/admin.repository', () => ({ adminRepository: { recordAction: vi.fn() } }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));

import { HttpError } from '../../utils/http-error';
import { authRepository, type UserRow } from '../auth/auth.repository';
import { settingsService } from '../settings/settings.service';
import { withdrawalRepository, type WithdrawalRow } from './withdrawal.repository';
import { withdrawalService } from './withdrawal.service';

const repo = vi.mocked(withdrawalRepository);
const users = vi.mocked(authRepository);
const minWithdrawal = vi.mocked(settingsService.minWithdrawal);

const withdrawalRow = (o: Record<string, unknown> = {}): WithdrawalRow =>
  ({
    id: 42,
    user_id: 7,
    amount: '100.00',
    status: 'requested',
    pix_key: 'chave-secreta@escambo.test',
    bank_name: null,
    bank_agency: null,
    bank_account: null,
    gateway_ref: null,
    created_at: new Date('2026-09-10T12:00:00Z'),
    processed_at: null,
    ...o,
  }) as unknown as WithdrawalRow;

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
    // A tentativa foi uma só, e sem saque criado não há o que reler.
    expect(repo.createIfSufficient).toHaveBeenCalledTimes(1);
    expect(repo.findById).not.toHaveBeenCalled();
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

  it('abaixo do mínimo da plataforma: 422 below_minimum com o valor na mensagem, antes de qualquer consulta (RN-034)', async () => {
    const err = await withdrawalService.request(7, { ...input, amount: 19.99 }).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 422, code: 'below_minimum' });
    expect(err.message).toMatch(/^Saque mínimo é R\$\s20,00 \(RN-034\)$/);
    expect(users.findById).not.toHaveBeenCalled();
    expect(repo.createIfSufficient).not.toHaveBeenCalled();
  });

  it('o mínimo é o configurado na plataforma, e o valor igual a ele é aceito', async () => {
    users.findById.mockResolvedValue(userRow(true));
    repo.createIfSufficient.mockResolvedValue(42);
    repo.findById.mockResolvedValue(withdrawalRow({ amount: '50.00' }));

    minWithdrawal.mockResolvedValueOnce(50);
    await expect(withdrawalService.request(7, { ...input, amount: 49 })).rejects.toMatchObject({
      code: 'below_minimum',
    });

    minWithdrawal.mockResolvedValueOnce(50);
    expect(await withdrawalService.request(7, { ...input, amount: 50 })).toMatchObject({
      amount: 50,
    });
    expect(users.findById).toHaveBeenCalledWith(7);
  });

  it('usuário que não existe mais também não saca: 403 email_not_verified', async () => {
    users.findById.mockResolvedValue(undefined);
    await expect(withdrawalService.request(7, input)).rejects.toMatchObject({
      statusCode: 403,
      code: 'email_not_verified',
    });
    expect(repo.createIfSufficient).not.toHaveBeenCalled();
  });

  it('saque por PIX grava só a chave: dados bancários enviados junto são descartados', async () => {
    users.findById.mockResolvedValue(userRow(true));
    repo.createIfSufficient.mockResolvedValue(42);
    repo.findById.mockResolvedValue(withdrawalRow());

    await withdrawalService.request(7, {
      ...input,
      bankName: 'Banco do Brasil',
      bankAgency: '0001',
      bankAccount: '12345-6',
    });

    expect(repo.createIfSufficient).toHaveBeenCalledWith({
      userId: 7,
      amount: 100,
      pixKey: 'chave-secreta@escambo.test',
      bankName: null,
      bankAgency: null,
      bankAccount: null,
    });
    expect(repo.findById).toHaveBeenCalledWith(42);
  });

  it('saque por conta bancária grava só os dados do banco e mascara a conta na resposta', async () => {
    users.findById.mockResolvedValue(userRow(true));
    repo.createIfSufficient.mockResolvedValue(43);
    repo.findById.mockResolvedValue(
      withdrawalRow({
        id: 43,
        amount: '300.00',
        pix_key: null,
        bank_name: 'Banco do Brasil',
        bank_agency: '0001',
        bank_account: '12345-6',
      }),
    );

    const w = await withdrawalService.request(7, {
      amount: 300,
      method: 'bank',
      pixKey: 'chave-que-nao-vale',
      bankName: 'Banco do Brasil',
      bankAgency: '0001',
      bankAccount: '12345-6',
    });

    expect(repo.createIfSufficient).toHaveBeenCalledWith({
      userId: 7,
      amount: 300,
      pixKey: null,
      bankName: 'Banco do Brasil',
      bankAgency: '0001',
      bankAccount: '12345-6',
    });
    expect(w).toEqual({
      id: 43,
      amount: 300,
      status: 'requested',
      method: 'bank',
      maskedDestination: '••••45-6',
      createdAt: '2026-09-10T12:00:00.000Z',
      processedAt: null,
    });
  });

  it('destino com até 4 caracteres é mascarado por inteiro (os últimos 4 seriam ele todo)', async () => {
    users.findById.mockResolvedValue(userRow(true));
    repo.createIfSufficient.mockResolvedValue(42);

    repo.findById.mockResolvedValue(withdrawalRow({ pix_key: ' 1234 ' }));
    expect((await withdrawalService.request(7, input)).maskedDestination).toBe('••••');

    repo.findById.mockResolvedValue(withdrawalRow({ pix_key: '12345' }));
    expect((await withdrawalService.request(7, input)).maskedDestination).toBe('••••2345');

    // Linha sem chave e sem conta (dado antigo): bancário, com a máscara vazia.
    repo.findById.mockResolvedValue(withdrawalRow({ pix_key: null }));
    expect(await withdrawalService.request(7, input)).toMatchObject({
      method: 'bank',
      maskedDestination: '••••',
    });
  });

  it('chamado sem os campos de destino (fora da rota), grava null e não undefined', async () => {
    users.findById.mockResolvedValue(userRow(true));
    repo.createIfSufficient.mockResolvedValue(42);
    repo.findById.mockResolvedValue(withdrawalRow());
    const empty = { userId: 7, pixKey: null, bankName: null, bankAgency: null, bankAccount: null };

    await withdrawalService.request(7, { amount: 100, method: 'pix' });
    expect(repo.createIfSufficient.mock.calls[0]![0]).toStrictEqual({ ...empty, amount: 100 });

    await withdrawalService.request(7, { amount: 200, method: 'bank' });
    expect(repo.createIfSufficient.mock.calls[1]![0]).toStrictEqual({ ...empty, amount: 200 });
  });
});

describe('withdrawalService.listMine', () => {
  it('pagina os saques de quem pede: o deslocamento é (página - 1) x limite', async () => {
    repo.listForUser.mockResolvedValue([]);

    expect(await withdrawalService.listMine(7, { page: 3, limit: 20 })).toEqual({
      items: [],
      page: 3,
      limit: 20,
    });
    expect(repo.listForUser).toHaveBeenCalledTimes(1);
    expect(repo.listForUser).toHaveBeenCalledWith(7, 20, 40);

    await withdrawalService.listMine(7, { page: 1, limit: 50 });
    expect(repo.listForUser).toHaveBeenLastCalledWith(7, 50, 0);
  });

  it('devolve cada saque no formato da API, com o destino mascarado e as datas em ISO', async () => {
    repo.listForUser.mockResolvedValue([
      withdrawalRow({
        id: 2,
        status: 'completed',
        processed_at: new Date('2026-09-11T09:30:00Z'),
      }),
      withdrawalRow({
        id: 1,
        amount: '80.50',
        pix_key: null,
        bank_name: 'Banco do Brasil',
        bank_agency: '0001',
        bank_account: '98765-4',
      }),
    ]);

    const { items } = await withdrawalService.listMine(7, { page: 1, limit: 20 });

    expect(items).toEqual([
      {
        id: 2,
        amount: 100,
        status: 'completed',
        method: 'pix',
        maskedDestination: '••••test',
        createdAt: '2026-09-10T12:00:00.000Z',
        processedAt: '2026-09-11T09:30:00.000Z',
      },
      {
        id: 1,
        amount: 80.5,
        status: 'requested',
        method: 'bank',
        maskedDestination: '••••65-4',
        createdAt: '2026-09-10T12:00:00.000Z',
        processedAt: null,
      },
    ]);
  });
});
