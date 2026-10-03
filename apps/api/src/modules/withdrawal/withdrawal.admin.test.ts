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

  it('saque que não existe: 404 withdrawal_not_found, sem tentar devolver nada', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(withdrawalService.cancelMine(9, 4)).rejects.toMatchObject({
      statusCode: 404,
      code: 'withdrawal_not_found',
    });
    expect(repo.findById).toHaveBeenCalledWith(9);
    expect(repo.closeAndRefund).not.toHaveBeenCalled();
  });

  it('as recusas saem com o código que o front trata, e o saque alheio não é tocado', async () => {
    repo.findById.mockResolvedValue(row());
    await expect(withdrawalService.cancelMine(9, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    expect(repo.closeAndRefund).not.toHaveBeenCalled();

    repo.closeAndRefund.mockResolvedValue(false);
    await expect(withdrawalService.cancelMine(9, 4)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
  });

  it('cancelado, devolve o saque RELIDO (status e data novos), com o destino mascarado', async () => {
    repo.closeAndRefund.mockResolvedValue(true);
    repo.findById
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(
        row({ status: 'cancelled', processed_at: new Date('2026-09-02T08:00:00Z') }),
      );

    expect(await withdrawalService.cancelMine(9, 4)).toEqual({
      id: 9,
      amount: 120,
      status: 'cancelled',
      method: 'pix',
      maskedDestination: '••••4321',
      createdAt: '2026-09-01T00:00:00.000Z',
      processedAt: '2026-09-02T08:00:00.000Z',
    });

    expect(repo.findById).toHaveBeenCalledTimes(2);
    expect(repo.findById).toHaveBeenNthCalledWith(1, 9);
    expect(repo.findById).toHaveBeenNthCalledWith(2, 9);
    expect(repo.closeAndRefund).toHaveBeenCalledTimes(1);
    expect(repo.closeAndRefund).toHaveBeenCalledWith(9, ['requested'], 'cancelled');
    // Desistência do titular não é ação de admin nem gera aviso para ele mesmo.
    expect(adminRepository.recordAction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('o titular não cancela saque que o admin já assumiu: só "requested" entra na origem', async () => {
    repo.findById.mockResolvedValue(row({ status: 'processing' }));
    repo.closeAndRefund.mockResolvedValue(false);

    await expect(withdrawalService.cancelMine(9, 4)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
      message: 'O saque já está em processamento ou encerrado',
    });
    // 'processing' fica de fora da origem: quem decide se pode é o repository, sob a trava.
    expect(repo.closeAndRefund).toHaveBeenCalledWith(9, ['requested'], 'cancelled');
    expect(repo.findById).toHaveBeenCalledTimes(1);
  });
});

describe('fila de saques do admin', () => {
  const bankRow = adminRow({
    id: 10,
    pix_key: null,
    bank_name: 'Banco do Brasil',
    bank_agency: '0001',
    bank_account: '12345-6',
  });

  it('"open" traz só o que falta pagar, "all" traz todos os status, e um status traz só ele; até 200', async () => {
    repo.listForAdmin.mockResolvedValue([]);

    expect(await withdrawalService.listForAdmin('open')).toEqual([]);
    expect(repo.listForAdmin).toHaveBeenLastCalledWith(['requested', 'processing'], 200);

    await withdrawalService.listForAdmin('all');
    expect(repo.listForAdmin).toHaveBeenLastCalledWith(
      ['requested', 'processing', 'completed', 'failed', 'cancelled'],
      200,
    );

    await withdrawalService.listForAdmin('failed');
    expect(repo.listForAdmin).toHaveBeenLastCalledWith(['failed'], 200);
    expect(repo.listForAdmin).toHaveBeenCalledTimes(3);
  });

  it('o admin vê o titular e o destino completo (é ele quem paga); a versão mascarada continua mascarada', async () => {
    repo.listForAdmin.mockResolvedValue([adminRow(), bankRow]);

    expect(await withdrawalService.listForAdmin('open')).toEqual([
      {
        id: 9,
        amount: 120,
        status: 'requested',
        method: 'pix',
        maskedDestination: '••••4321',
        createdAt: '2026-09-01T00:00:00.000Z',
        processedAt: null,
        userId: 4,
        userUlid: '01USERULID00000000000000000',
        userEmail: 'freela@escambo.test',
        userName: 'Freela',
        destination: 'chave-pix-final-4321',
      },
      {
        id: 10,
        amount: 120,
        status: 'requested',
        method: 'bank',
        maskedDestination: '••••45-6',
        createdAt: '2026-09-01T00:00:00.000Z',
        processedAt: null,
        userId: 4,
        userUlid: '01USERULID00000000000000000',
        userEmail: 'freela@escambo.test',
        userName: 'Freela',
        destination: 'Banco do Brasil · 0001 · 12345-6',
      },
    ]);
  });

  it('destino bancário incompleto (dado antigo) mostra só as partes que existem, sem separador sobrando', async () => {
    repo.listForAdmin.mockResolvedValue([
      adminRow({ pix_key: null, bank_name: null, bank_agency: '0001', bank_account: '12345-6' }),
      adminRow({
        pix_key: null,
        bank_name: 'Banco do Brasil',
        bank_agency: '',
        bank_account: null,
      }),
    ]);

    const [noBank, onlyBank] = await withdrawalService.listForAdmin('all');

    expect(noBank!.destination).toBe('0001 · 12345-6');
    expect(onlyBank!.destination).toBe('Banco do Brasil');
    // Sem chave e sem conta, a versão mascarada não tem o que mostrar.
    expect(onlyBank!).toMatchObject({ method: 'bank', maskedDestination: '••••' });
  });

  it('titular sem perfil preenchido aparece na fila com o nome nulo', async () => {
    repo.listForAdmin.mockResolvedValue([
      { ...adminRow(), user_name: null } as unknown as AdminWithdrawalRow,
    ]);
    const [item] = await withdrawalService.listForAdmin('requested');
    expect(item!.userName).toBeNull();
    expect(item!.userEmail).toBe('freela@escambo.test');
    expect(repo.listForAdmin).toHaveBeenCalledWith(['requested'], 200);
  });

  it('adminView: 404 withdrawal_not_found quando o saque não existe', async () => {
    repo.findForAdmin.mockResolvedValue(undefined);
    await expect(withdrawalService.adminView(9)).rejects.toMatchObject({
      statusCode: 404,
      code: 'withdrawal_not_found',
    });
    expect(repo.findForAdmin).toHaveBeenCalledWith(9);
  });
});

describe('processamento de saques pelo admin: recusas, registro e aviso', () => {
  it('saque que não existe: process, complete e fail dão 404 sem mudar nada', async () => {
    repo.findById.mockResolvedValue(undefined);

    for (const attempt of [
      withdrawalService.process(1, 9),
      withdrawalService.complete(1, 9, 'E2E-1'),
      withdrawalService.fail(1, 9, 'Chave inválida'),
    ]) {
      await expect(attempt).rejects.toMatchObject({
        statusCode: 404,
        code: 'withdrawal_not_found',
      });
    }
    // A busca é pelo id do SAQUE (9), não pelo do admin (1), nas três ações.
    expect(repo.findById.mock.calls).toEqual([[9], [9], [9]]);
    expect(repo.advance).not.toHaveBeenCalled();
    expect(repo.closeAndRefund).not.toHaveBeenCalled();
    expect(repo.findForAdmin).not.toHaveBeenCalled();
    expect(adminRepository.recordAction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('complete e fail não esperam o aviso ao titular sair: o admin recebe o saque mesmo com o envio pendente', async () => {
    repo.findById.mockResolvedValue(row());
    repo.advance.mockResolvedValue(true);
    repo.closeAndRefund.mockResolvedValue(true);
    // Aviso que nunca termina (e-mail/push lento): o pagamento já registrado não fica preso nele.
    const never = new Promise<void>(() => undefined);
    notify.mockReturnValueOnce(never).mockReturnValueOnce(never);

    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'completed' }));
    expect(await withdrawalService.complete(1, 9, null)).toMatchObject({
      id: 9,
      status: 'completed',
    });
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'failed' }));
    expect(await withdrawalService.fail(1, 9, null)).toMatchObject({ id: 9, status: 'failed' });

    expect(notify.mock.calls.map((c) => [c[0], c[1].type])).toEqual([
      [4, 'withdrawal_completed'],
      [4, 'withdrawal_failed'],
    ]);
  });

  it('o registro da ação do admin vem depois da mudança de status e antes do aviso ao titular', async () => {
    const recordAction = vi.mocked(adminRepository.recordAction);
    repo.findById.mockResolvedValue(row());
    repo.advance.mockResolvedValue(true);
    repo.closeAndRefund.mockResolvedValue(true);
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'completed' }));

    await withdrawalService.complete(1, 9, 'E2E-1');
    expect(repo.advance.mock.invocationCallOrder[0]!).toBeLessThan(
      recordAction.mock.invocationCallOrder[0]!,
    );
    expect(recordAction.mock.invocationCallOrder[0]!).toBeLessThan(
      notify.mock.invocationCallOrder[0]!,
    );

    await withdrawalService.fail(1, 9, 'Chave inválida');
    expect(repo.closeAndRefund.mock.invocationCallOrder[0]!).toBeLessThan(
      recordAction.mock.invocationCallOrder[1]!,
    );
    expect(recordAction.mock.invocationCallOrder[1]!).toBeLessThan(
      notify.mock.invocationCallOrder[1]!,
    );
    // Cada ação lê o saque uma vez, pelo id dele, antes de mudar qualquer coisa.
    expect(repo.findById.mock.calls).toEqual([[9], [9]]);
    expect(repo.findById.mock.invocationCallOrder[0]!).toBeLessThan(
      repo.advance.mock.invocationCallOrder[0]!,
    );
  });

  it('process: registra a ação do admin; se o saque já não estava aguardando, 409 sem registro', async () => {
    repo.findById.mockResolvedValue(row());
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'processing' }));

    repo.advance.mockResolvedValue(true);
    await withdrawalService.process(1, 9);
    expect(adminRepository.recordAction).toHaveBeenCalledTimes(1);
    expect(adminRepository.recordAction).toHaveBeenCalledWith(
      1,
      'withdrawal_processing',
      'withdrawal',
      9,
      null,
    );
    expect(repo.findForAdmin).toHaveBeenCalledWith(9);
    // Assumir o pagamento não avisa o titular: o aviso vem na conclusão ou na falha.
    expect(notify).not.toHaveBeenCalled();

    vi.mocked(adminRepository.recordAction).mockClear();
    repo.advance.mockResolvedValue(false);
    await expect(withdrawalService.process(1, 9)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(adminRepository.recordAction).not.toHaveBeenCalled();
  });

  it('complete sem referência: registra sem descrição e avisa o titular com o valor e o destino mascarado', async () => {
    repo.findById.mockResolvedValue(row({ status: 'processing' }));
    repo.advance.mockResolvedValue(true);
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'completed' }));

    await withdrawalService.complete(1, 9, null);

    expect(repo.advance).toHaveBeenCalledWith(9, ['requested', 'processing'], 'completed', null);
    expect(adminRepository.recordAction).toHaveBeenCalledWith(
      1,
      'withdrawal_completed',
      'withdrawal',
      9,
      null,
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(4, {
      type: 'withdrawal_completed',
      title: expect.stringMatching(/^Saque de R\$\s120,00 concluído$/),
      body: 'Enviado para ••••4321.',
      data: { withdrawalId: 9, amount: 120 },
    });
  });

  it('complete de saque bancário: o aviso mascara o destino inteiro (banco, agência e conta)', async () => {
    repo.findById.mockResolvedValue(
      row({
        pix_key: null,
        bank_name: 'Banco do Brasil',
        bank_agency: '0001',
        bank_account: '12345-6',
      }),
    );
    repo.advance.mockResolvedValue(true);
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'completed' }));

    await withdrawalService.complete(1, 9, 'TED-77');

    expect(notify).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ body: 'Enviado para ••••45-6.' }),
    );
  });

  it('fail: registra o motivo, e sem motivo o aviso usa o texto padrão; o valor volta à carteira', async () => {
    repo.findById.mockResolvedValue(row());
    repo.closeAndRefund.mockResolvedValue(true);
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'failed' }));

    await withdrawalService.fail(1, 9, 'Chave PIX inexistente');
    expect(adminRepository.recordAction).toHaveBeenLastCalledWith(
      1,
      'withdrawal_failed',
      'withdrawal',
      9,
      'Chave PIX inexistente',
    );
    expect(notify).toHaveBeenLastCalledWith(4, {
      type: 'withdrawal_failed',
      title: expect.stringMatching(/^Saque de R\$\s120,00 não pôde ser feito$/),
      body: 'Chave PIX inexistente. O valor voltou para a sua carteira.',
      data: { withdrawalId: 9, amount: 120 },
    });

    await withdrawalService.fail(1, 9, null);
    expect(adminRepository.recordAction).toHaveBeenLastCalledWith(
      1,
      'withdrawal_failed',
      'withdrawal',
      9,
      null,
    );
    expect(notify).toHaveBeenLastCalledWith(
      4,
      expect.objectContaining({
        body: 'Dados de destino inválidos. O valor voltou para a sua carteira.',
      }),
    );
  });

  it('complete de saque já encerrado: 409 invalid_transition, sem registro nem aviso', async () => {
    repo.findById.mockResolvedValue(row({ status: 'cancelled' }));
    repo.advance.mockResolvedValue(false);

    await expect(withdrawalService.complete(1, 9, 'E2E-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
      message: 'Saque já encerrado',
    });
    // Concluir nunca passa pelo caminho que devolve dinheiro.
    expect(repo.closeAndRefund).not.toHaveBeenCalled();
    expect(adminRepository.recordAction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(repo.findForAdmin).not.toHaveBeenCalled();
  });

  it('complete e fail devolvem a visão de admin RELIDA depois da mudança, e fail não avança status', async () => {
    repo.findById.mockResolvedValue(row());
    repo.advance.mockResolvedValue(true);
    repo.closeAndRefund.mockResolvedValue(true);
    repo.findForAdmin.mockResolvedValue(
      adminRow({ status: 'completed', processed_at: new Date('2026-09-03T10:00:00Z') }),
    );

    expect(await withdrawalService.complete(1, 9, 'E2E-1')).toEqual({
      id: 9,
      amount: 120,
      status: 'completed',
      method: 'pix',
      maskedDestination: '••••4321',
      createdAt: '2026-09-01T00:00:00.000Z',
      processedAt: '2026-09-03T10:00:00.000Z',
      userId: 4,
      userUlid: '01USERULID00000000000000000',
      userEmail: 'freela@escambo.test',
      userName: 'Freela',
      destination: 'chave-pix-final-4321',
    });
    expect(repo.findForAdmin).toHaveBeenLastCalledWith(9);
    expect(repo.closeAndRefund).not.toHaveBeenCalled();

    repo.advance.mockClear();
    repo.findForAdmin.mockResolvedValue(adminRow({ status: 'failed' }));
    expect(await withdrawalService.fail(1, 9, null)).toMatchObject({ id: 9, status: 'failed' });
    expect(repo.findForAdmin).toHaveBeenLastCalledWith(9);
    expect(repo.findForAdmin).toHaveBeenCalledTimes(2);
    // A falha encerra pelo caminho que devolve o valor, não pelo que avança o status.
    expect(repo.advance).not.toHaveBeenCalled();
  });

  it('fail de saque já encerrado: 409 invalid_transition, sem registro nem aviso', async () => {
    repo.findById.mockResolvedValue(row({ status: 'completed' }));
    repo.closeAndRefund.mockResolvedValue(false);

    await expect(withdrawalService.fail(1, 9, 'x')).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(adminRepository.recordAction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
