import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./payments.repository', () => ({
  paymentsRepository: {
    createTopup: vi.fn(),
    findById: vi.fn(),
    findByGatewayId: vi.fn(),
    listTopupsForUser: vi.fn(),
    settle: vi.fn(),
    expirePending: vi.fn(),
  },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { env } from '../../config/env';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsRepository, type PaymentRow } from './payments.repository';
import { paymentsService } from './payments.service';

const repo = vi.mocked(paymentsRepository);
const notify = vi.mocked(notificationsService.notify);

type Fields = Partial<{
  id: number;
  kind: string;
  payer_id: number;
  amount: string;
  status: string;
  gateway_payment_id: string | null;
  gateway_response: string | null;
  paid_at: Date | null;
  expires_at: Date | null;
}>;

const row = (o: Fields = {}): PaymentRow =>
  ({
    id: 7,
    kind: 'topup',
    payer_id: 1,
    amount: '150.00',
    method: 'pix',
    status: 'pending',
    gateway: 'simulado',
    gateway_payment_id: 'sim_X',
    gateway_response: JSON.stringify({ pixCode: '000201…6304ABCD' }),
    paid_at: null,
    expires_at: new Date(Date.now() + 10 * 60_000),
    created_at: new Date('2026-09-01T00:00:00Z'),
    ...o,
  }) as unknown as PaymentRow;

beforeEach(() => {
  vi.clearAllMocks();
  env.PAYMENTS_SIMULATE = true;
});

describe('paymentsService.createDeposit', () => {
  it('cria a cobrança no gateway simulado e devolve o código PIX pendente', async () => {
    repo.createTopup.mockResolvedValue(7);
    repo.findById.mockResolvedValue(row());
    const d = await paymentsService.createDeposit(1, { amount: 150, method: 'pix' });
    const arg = repo.createTopup.mock.calls[0]![0];
    expect(arg).toMatchObject({ payerId: 1, amount: 150, gateway: 'simulado' });
    expect(arg.gatewayPaymentId.startsWith('sim_')).toBe(true);
    expect(arg.pixCode).toMatch(/^000201.*6304[0-9A-F]{4}$/);
    expect(d).toMatchObject({
      id: 7,
      status: 'pending',
      pixCode: '000201…6304ABCD',
      canSimulate: true,
    });
  });
});

describe('paymentsService.simulate', () => {
  it('paga a cobrança e notifica o titular', async () => {
    repo.findById
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: 'paid', paid_at: new Date() }));
    repo.settle.mockResolvedValue(true);
    const d = await paymentsService.simulate(7, 1);
    expect(repo.settle).toHaveBeenCalledWith(7, 'paid');
    expect(d.status).toBe('paid');
    expect(d.pixCode).toBeNull(); // cobrança liquidada não expõe mais o código
    expect(notify).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'deposit_confirmed' }));
  });

  it('403 com a simulação desligada (produção)', async () => {
    env.PAYMENTS_SIMULATE = false;
    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'simulation_disabled',
    });
    expect(repo.settle).not.toHaveBeenCalled();
  });

  it('403 se o depósito é de outro usuário; 409 se venceu; 409 se já liquidado', async () => {
    repo.findById.mockResolvedValue(row({ payer_id: 2 }));
    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({ statusCode: 403 });

    repo.findById.mockResolvedValue(row({ expires_at: new Date(Date.now() - 1000) }));
    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({ code: 'deposit_expired' });

    repo.findById.mockResolvedValue(row({ status: 'paid' }));
    repo.settle.mockResolvedValue(false);
    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({
      code: 'deposit_not_pending',
    });
  });
});

describe('paymentsService.settleFromGateway (webhook)', () => {
  it('aplica uma vez e é idempotente na repetição do evento', async () => {
    repo.findByGatewayId.mockResolvedValue(row());
    repo.findById.mockResolvedValue(row({ status: 'paid' }));
    repo.settle.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await paymentsService.settleFromGateway('sim_X', 'paid');
    const again = await paymentsService.settleFromGateway('sim_X', 'paid');
    expect(first.applied).toBe(true);
    expect(again.applied).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('404 para cobrança desconhecida', async () => {
    repo.findByGatewayId.mockResolvedValue(undefined);
    await expect(paymentsService.settleFromGateway('nope', 'paid')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('toDeposit', () => {
  it('cobrança pendente vencida aparece cancelada e sem simulação', async () => {
    repo.findById.mockResolvedValue(row({ expires_at: new Date(Date.now() - 1000) }));
    const d = await paymentsService.getDeposit(7, 1);
    expect(d.status).toBe('cancelled');
    expect(d.canSimulate).toBe(false);
  });
});
