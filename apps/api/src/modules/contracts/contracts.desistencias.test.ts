import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClockForTests } from '../../utils/clock';
import type { FullDropoutRow } from '../dropouts/dropouts.repository';
import type { ContractRow } from './contracts.repository';

vi.mock('./contracts.repository', () => ({
  contractsRepository: {
    findById: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    transition: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('./milestones.repository', () => ({
  milestonesRepository: {
    listForContract: vi.fn().mockResolvedValue([]),
    escrowRemaining: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('./offers.repository', () => ({
  offersRepository: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { findByContractIdWithResponse: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../settings/settings.service', () => ({
  settingsService: {
    number: vi.fn().mockResolvedValue(24),
    feeRate: vi.fn().mockResolvedValue(0.15),
  },
}));
vi.mock('../settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn().mockResolvedValue(24) },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../dropouts/dropouts.repository', () => ({
  dropoutsRepository: { listCounting: vi.fn(), findByContractId: vi.fn() },
}));
vi.mock('../dropouts/dropouts.service', () => ({
  dropoutsService: { afterDropout: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../barter/barter.service', () => ({
  barterService: { onLinkedContractCancelled: vi.fn().mockResolvedValue(undefined) },
}));

import { logger } from '../../config/logger';
import { dropoutsRepository } from '../dropouts/dropouts.repository';
import { dropoutsService } from '../dropouts/dropouts.service';
import { notificationsService } from '../notifications/notifications.service';
import { barterService } from '../barter/barter.service';
import { contractsRepository } from './contracts.repository';
import { contractsService } from './contracts.service';

const NOW = new Date('2026-10-09T15:00:00Z');
const repo = vi.mocked(contractsRepository);
const dropouts = vi.mocked(dropoutsRepository);
const afterDropout = vi.mocked(dropoutsService.afterDropout);
const notices = vi.mocked(notificationsService.notify);
const row = (extra: Partial<Omit<ContractRow, 'constructor'>> = {}): ContractRow =>
  ({
    id: 31,
    ulid: '01CONTRACT0000000000000000',
    client_id: 7,
    freelancer_id: 44,
    service_id: null,
    title: 'Entrega',
    description: 'Descrição pública da contratação',
    status: 'accepted',
    payment_mode: 'cash',
    price: '100.00',
    platform_fee: '15.00',
    freelancer_net: '85.00',
    has_milestones: 0,
    created_at: NOW,
    accepted_at: NOW,
    deadline_at: null,
    barter_agreement_id: null,
    extension_status: 'none',
    extension_requests: 0,
    client_timezone: 'America/Manaus',
    freelancer_timezone: 'America/Noronha',
    ...extra,
  }) as ContractRow;
const dropout = (extra: Partial<Omit<FullDropoutRow, 'constructor'>> = {}): FullDropoutRow =>
  ({
    id: 51,
    contract_id: 31,
    freelancer_id: 44,
    client_id: 7,
    dropped_at: NOW,
    client_agreed_at: null,
    appealed_at: null,
    decision: null,
    appeal_text: 'Minha contestação privada',
    decision_note: 'Nota privada da equipe',
    decided_by: null,
    decided_at: null,
    review_checked_at: null,
    freelancer_ulid: '01FREELA00000000000000000',
    freelancer_name: 'Nome privado',
    freelancer_timezone: 'America/Noronha',
    contract_title: 'Entrega',
    ...extra,
  }) as FullDropoutRow;

beforeEach(() => {
  vi.clearAllMocks();
  setClockForTests(NOW, { frozen: true });
  repo.findById.mockReset().mockResolvedValue(row());
  repo.transition.mockReset().mockResolvedValue(true);
  dropouts.listCounting.mockReset().mockResolvedValue([]);
  dropouts.findByContractId.mockReset().mockResolvedValue(dropout());
  afterDropout.mockReset().mockResolvedValue(undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

describe('prévia de desistência RN-026', () => {
  it.each(['accepted', 'in_progress'])(
    'anexa contagem só à saída do freelancer em %s, cash/créditos/troca',
    async (status) => {
      dropouts.listCounting.mockResolvedValue([
        dropout({ id: 11, dropped_at: new Date('2026-10-01T15:00:00Z') }),
        dropout({ id: 12, dropped_at: new Date('2026-10-02T15:00:00Z') }),
      ]);
      for (const payment_mode of ['cash', 'credits', 'barter']) {
        repo.findById.mockResolvedValue(
          row({ status, payment_mode, barter_agreement_id: payment_mode === 'barter' ? 99 : null }),
        );
        const result = await contractsService.getById(31, 44);
        expect(result.cancellation?.dropout).toEqual({
          countAfter: 3,
          windowDays: 60,
          alertAt: 3,
          alertUntil: '2026-11-30T15:00:00.000Z',
        });
        expect(dropouts.listCounting).toHaveBeenLastCalledWith(44, NOW);
        expect(repo.transition).not.toHaveBeenCalled();
        expect(afterDropout).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['cash', 'credits', 'barter'])(
    'cancelamento do cliente em %s não consulta reputação do freelancer',
    async (payment_mode) => {
      repo.findById.mockResolvedValue(
        row({ payment_mode, barter_agreement_id: payment_mode === 'barter' ? 99 : null }),
      );
      const result = await contractsService.getById(31, 7);
      expect(result.cancellation?.allowed).toBe(true);
      expect(result.cancellation?.dropout).toBeUndefined();
      expect(dropouts.listCounting).not.toHaveBeenCalled();
    },
  );

  it.each(['pending', 'delivered', 'revision_requested', 'completed', 'disputed', 'cancelled'])(
    'estado %s não inventa uma desistência',
    async (status) => {
      repo.findById.mockResolvedValue(row({ status }));
      const result = await contractsService.getById(31, 44);
      expect(result.cancellation?.dropout).toBeUndefined();
      expect(dropouts.listCounting).not.toHaveBeenCalled();
      expect(afterDropout).not.toHaveBeenCalled();
    },
  );
});

describe('cancelamento e reconciliação após COMMIT', () => {
  it('contagem informada divergente recusa antes de qualquer transição financeira', async () => {
    await expect(
      contractsService.cancel(31, 44, { expectedRefund: 100, expectedDropoutCount: 2 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'cancel_quote_changed',
    });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(afterDropout).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  });

  it('uma transição recusada não reconcilia nem envia aviso de cancelamento', async () => {
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.cancel(31, 44, { expectedRefund: 100 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'cancel_quote_changed',
    });
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        dropout: { freelancerId: 44, expectedCountAfter: 1 },
        walletEffects: [
          { userId: 44, pendingDelta: -85, balanceDelta: 0, reason: 'escrow_refund' },
          { userId: 7, pendingDelta: 0, balanceDelta: 100, reason: 'refund' },
        ],
      }),
    );
    expect(afterDropout).not.toHaveBeenCalled();
    expect(dropouts.findByContractId).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  });

  it('falha no hook depois da transição preserva o cancelamento e o aviso ao cliente', async () => {
    afterDropout.mockRejectedValue(new Error('banco indisponível na reconciliação'));
    const result = await contractsService.cancel(31, 44, { expectedRefund: 100 });
    expect(result).toMatchObject({
      status: 'cancelled',
      by: 'freelancer',
      stage: 'withdrawal',
      refundClient: 100,
      releaseFreelancer: 0,
    });
    expect(afterDropout).toHaveBeenCalledExactlyOnceWith(44, 31, NOW);
    expect(repo.transition.mock.invocationCallOrder[0]).toBeLessThan(
      afterDropout.mock.invocationCallOrder[0]!,
    );
    expect(logger.warn).toHaveBeenCalled();
    expect(notices).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'contract_cancelled' }),
      {},
    );
    const notice = notices.mock.calls[0]![1];
    expect(notice.body).toContain('R$ 100,00 voltou para a sua carteira.');
    expect(notice.body).toContain('16/10/2026 às 11:00');
    expect(notice.body).not.toContain('13:00');
  });

  it.each(['credits', 'barter'])(
    'saída em %s mantém a mesma transação e a reconciliação após sucesso',
    async (payment_mode) => {
      repo.findById.mockResolvedValue(
        row({
          payment_mode,
          freelancer_net: '100.00',
          barter_agreement_id: payment_mode === 'barter' ? 99 : null,
        }),
      );
      const result = await contractsService.cancel(31, 44);
      expect(result.unit).toBe(payment_mode === 'credits' ? 'credits' : 'none');
      expect(repo.transition).toHaveBeenCalledWith(
        expect.objectContaining({ dropout: { freelancerId: 44, expectedCountAfter: 1 } }),
      );
      expect(afterDropout).toHaveBeenCalledOnce();
      const mutation = repo.transition.mock.calls[0]![0];
      if (payment_mode === 'credits') {
        expect(mutation.creditsEffects).toEqual([
          { userId: 44, pendingDelta: -100, balanceDelta: 0, reason: 'escrow_refund' },
          { userId: 7, pendingDelta: 0, balanceDelta: 100, reason: 'refund' },
        ]);
        expect(mutation.walletEffects).toBeUndefined();
      } else {
        expect(mutation.creditsEffects).toBeUndefined();
        expect(mutation.walletEffects).toBeUndefined();
        expect(barterService.onLinkedContractCancelled).toHaveBeenCalledWith(99);
      }
    },
  );

  it('leitura do acordo que falha após o COMMIT não inventa um prazo nem desfaz o resultado financeiro', async () => {
    dropouts.findByContractId.mockRejectedValue(new Error('leitura indisponível'));
    const result = await contractsService.cancel(31, 44);
    expect(result).toMatchObject({ status: 'cancelled', refundClient: 100 });
    expect(repo.transition).toHaveBeenCalledOnce();
    expect(afterDropout).toHaveBeenCalledOnce();
    expect(notices).toHaveBeenCalledOnce();
    expect(notices.mock.calls[0]![1].body).toBe('R$ 100,00 voltou para a sua carteira.');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('detalhe da contratação cancelada: projeção de privacidade', () => {
  it.each([7, 44])(
    'parte %s lê somente datas de confirmação e a indicação de contagem',
    async (uid) => {
      repo.findById.mockResolvedValue(row({ status: 'cancelled' }));
      const result = await contractsService.getById(31, uid);
      expect(result.dropout).toEqual({
        at: NOW.toISOString(),
        agreedAt: null,
        agreeUntil: '2026-10-16T15:00:00.000Z',
        counts: true,
      });
      expect(Object.keys(result.dropout!).sort()).toEqual([
        'agreeUntil',
        'agreedAt',
        'at',
        'counts',
      ]);
      expect(JSON.stringify(result)).not.toContain('Minha contestação privada');
      expect(JSON.stringify(result)).not.toContain('Nota privada da equipe');
      expect(JSON.stringify(result)).not.toContain('Nome privado');
    },
  );

  it('cancelamento antigo sem registro de desistência continua sem cartão', async () => {
    repo.findById.mockResolvedValue(row({ status: 'cancelled' }));
    dropouts.findByContractId.mockResolvedValue(undefined);
    expect((await contractsService.getById(31, 7)).dropout).toBeNull();
  });
});
