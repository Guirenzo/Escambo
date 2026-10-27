import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: {
    minWithdrawal: vi.fn().mockResolvedValue(20),
    withdrawalBusinessDays: vi.fn(),
  },
}));

vi.mock('./withdrawal.repository', () => ({
  withdrawalRepository: { createIfSufficient: vi.fn(), findById: vi.fn(), listForUser: vi.fn() },
}));
vi.mock('../auth/auth.repository', () => ({ authRepository: { findById: vi.fn() } }));
vi.mock('../profiles/profiles.repository', () => ({
  profilesRepository: { payoutState: vi.fn() },
}));
vi.mock('../admin/admin.repository', () => ({ adminRepository: { recordAction: vi.fn() } }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));

import { setClockForTests } from '../../utils/clock';
import { setFieldKeysForTests } from '../../utils/field-crypto';
import { profilesRepository } from '../profiles/profiles.repository';
import { HttpError } from '../../utils/http-error';
import { authRepository, type UserRow } from '../auth/auth.repository';
import { settingsService } from '../settings/settings.service';
import { withdrawalRepository, type WithdrawalRow } from './withdrawal.repository';
import { withdrawalService } from './withdrawal.service';

const repo = vi.mocked(withdrawalRepository);
const users = vi.mocked(authRepository);
const minWithdrawal = vi.mocked(settingsService.minWithdrawal);
const businessDays = vi.mocked(settingsService.withdrawalBusinessDays);
const payout = vi.mocked(profilesRepository.payoutState);
const FIELD_KEY = Buffer.alloc(32, 0x5c).toString('base64');

/** Sexta, 09/10/2026, 15:00 em Brasília: PIX (1 dia útil) vence na segunda, TED (2) na terça. */
const FRIDAY_AFTERNOON = new Date('2026-10-09T18:00:00.000Z');
const PIX_DUE = new Date('2026-10-13T02:59:59.000Z');
const BANK_DUE = new Date('2026-10-14T02:59:59.000Z');

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
    due_at: new Date('2026-09-12T02:59:59Z'),
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

beforeEach(() => {
  vi.clearAllMocks();
  setClockForTests(FRIDAY_AFTERNOON, { frozen: true });
  businessDays.mockImplementation(async (method) => (method === 'pix' ? 1 : 2));
  // Freelancer com o CPF validado (RF-020), num servidor com a chave de cifragem.
  setFieldKeysForTests({ current: FIELD_KEY });
  payout.mockResolvedValue({ delivers_work: 1, cpf_verified: 1 } as never);
});
afterEach(() => {
  setClockForTests(null);
  setFieldKeysForTests(null);
});

/** RF-020: quem entrega trabalho só saca com o CPF validado; quem só contrata, não precisa. */
describe('withdrawalService.request: CPF (RF-020)', () => {
  it('freelancer sem CPF validado: 403 cpf_required, que leva ao Perfil, sem tocar no saldo', async () => {
    users.findById.mockResolvedValue(userRow(true));
    payout.mockResolvedValue({ delivers_work: 1, cpf_verified: 0 } as never);

    const err = await withdrawalService.request(7, input).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 403, code: 'cpf_required' });
    expect(err.message).toBe('Para sacar, valide seu CPF em Perfil, "Dados para receber".');
    expect(payout).toHaveBeenCalledWith(7);
    expect(repo.createIfSufficient).not.toHaveBeenCalled();
  });

  it('o e-mail é conferido antes: sem ele, 403 email_not_verified nem chega ao CPF', async () => {
    users.findById.mockResolvedValue(userRow(false));
    payout.mockResolvedValue({ delivers_work: 1, cpf_verified: 0 } as never);

    await expect(withdrawalService.request(7, input)).rejects.toMatchObject({
      code: 'email_not_verified',
    });
    expect(payout).not.toHaveBeenCalled();
  });

  it('sem a FIELD_ENCRYPTION_KEY: 503 cpf_unavailable para quem entrega trabalho, mesmo validado', async () => {
    users.findById.mockResolvedValue(userRow(true));
    setFieldKeysForTests({});

    const err = await withdrawalService.request(7, input).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 503, code: 'cpf_unavailable' });
    expect(err.message).toContain('validação de CPF ainda não está disponível neste servidor');
    expect(repo.createIfSufficient).not.toHaveBeenCalled();
  });

  it('quem só contrata (cliente, empresa) saca o que depositou sem CPF, com ou sem a chave', async () => {
    users.findById.mockResolvedValue(userRow(true));
    payout.mockResolvedValue({ delivers_work: 0, cpf_verified: 0 } as never);
    repo.createIfSufficient.mockResolvedValue(42);
    repo.findById.mockResolvedValue(withdrawalRow());

    await expect(withdrawalService.request(7, input)).resolves.toMatchObject({ id: 42 });
    setFieldKeysForTests({});
    await expect(withdrawalService.request(7, input)).resolves.toMatchObject({ id: 42 });
    expect(repo.createIfSufficient).toHaveBeenCalledTimes(2);
  });

  it('conta que não voltou do banco conta como quem não entrega trabalho', async () => {
    users.findById.mockResolvedValue(userRow(true));
    payout.mockResolvedValue(undefined);
    repo.createIfSufficient.mockResolvedValue(42);
    repo.findById.mockResolvedValue(withdrawalRow());

    await expect(withdrawalService.request(7, input)).resolves.toMatchObject({ id: 42 });
  });
});

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
      dueAt: PIX_DUE,
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
        due_at: BANK_DUE,
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
      dueAt: BANK_DUE,
    });
    expect(w).toEqual({
      id: 43,
      amount: 300,
      status: 'requested',
      method: 'bank',
      maskedDestination: '••••45-6',
      createdAt: '2026-09-10T12:00:00.000Z',
      processedAt: null,
      dueAt: '2026-10-14T02:59:59.000Z',
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
    expect(repo.createIfSufficient.mock.calls[0]![0]).toStrictEqual({
      ...empty,
      amount: 100,
      dueAt: PIX_DUE,
    });

    await withdrawalService.request(7, { amount: 200, method: 'bank' });
    expect(repo.createIfSufficient.mock.calls[1]![0]).toStrictEqual({
      ...empty,
      amount: 200,
      dueAt: BANK_DUE,
    });
  });
});

describe('withdrawalService.request: prazo do saque (RN-035)', () => {
  beforeEach(() => {
    users.findById.mockResolvedValue(userRow(true));
    repo.createIfSufficient.mockResolvedValue(42);
    repo.findById.mockResolvedValue(withdrawalRow());
  });

  it('lê o parâmetro da forma escolhida, na hora do pedido, e grava o fim do n-ésimo dia útil', async () => {
    await withdrawalService.request(7, input);
    expect(businessDays).toHaveBeenLastCalledWith('pix');
    expect(repo.createIfSufficient.mock.calls[0]![0].dueAt).toEqual(PIX_DUE);

    await withdrawalService.request(7, {
      amount: 100,
      method: 'bank',
      bankName: 'Banco do Brasil',
      bankAgency: '0001',
      bankAccount: '12345-6',
    });
    expect(businessDays).toHaveBeenLastCalledWith('bank');
    expect(repo.createIfSufficient.mock.calls[1]![0].dueAt).toEqual(BANK_DUE);
  });

  it('o admin aumentou o prazo do PIX para 3 dias úteis: o pedido seguinte já sai com ele', async () => {
    businessDays.mockResolvedValueOnce(3);
    await withdrawalService.request(7, input);
    // Sexta + 3 dias úteis = quarta, 14/10, 23:59:59 de Brasília.
    expect(repo.createIfSufficient.mock.calls[0]![0].dueAt).toEqual(
      new Date('2026-10-15T02:59:59.000Z'),
    );
  });

  it('sexta à noite em Brasília (sábado em UTC) ainda conta como sexta', async () => {
    setClockForTests(new Date('2026-10-10T01:30:00.000Z'), { frozen: true });
    await withdrawalService.request(7, input);
    expect(repo.createIfSufficient.mock.calls[0]![0].dueAt).toEqual(PIX_DUE);
  });

  it('pedido recusado antes (mínimo ou e-mail) nem lê o prazo', async () => {
    await withdrawalService.request(7, { ...input, amount: 1 }).catch(() => undefined);
    users.findById.mockResolvedValue(userRow(false));
    await withdrawalService.request(7, input).catch(() => undefined);
    expect(businessDays).not.toHaveBeenCalled();
    expect(repo.createIfSufficient).not.toHaveBeenCalled();
  });

  it('a resposta traz o prazo gravado no saque, em ISO', async () => {
    repo.findById.mockResolvedValue(withdrawalRow({ due_at: PIX_DUE }));
    expect((await withdrawalService.request(7, input)).dueAt).toBe('2026-10-13T02:59:59.000Z');
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
        dueAt: '2026-09-12T02:59:59.000Z',
      },
      {
        id: 1,
        amount: 80.5,
        status: 'requested',
        method: 'bank',
        maskedDestination: '••••65-4',
        createdAt: '2026-09-10T12:00:00.000Z',
        processedAt: null,
        dueAt: '2026-09-12T02:59:59.000Z',
      },
    ]);
  });

  it('destino cifrado que não decifrou (RNF-017) vai como "[indisponível]", sem máscara por cima', async () => {
    repo.listForUser.mockResolvedValue([withdrawalRow({ pix_key: '[indisponível]' })]);
    const { items } = await withdrawalService.listMine(7, { page: 1, limit: 20 });
    expect(items[0]).toMatchObject({ method: 'pix', maskedDestination: '[indisponível]' });
  });

  it('saque encerrado antes de o prazo existir (1.44.0) vem com dueAt null', async () => {
    repo.listForUser.mockResolvedValue([withdrawalRow({ status: 'completed', due_at: null })]);
    const { items } = await withdrawalService.listMine(7, { page: 1, limit: 20 });
    expect(items[0]!.dueAt).toBeNull();
  });
});
