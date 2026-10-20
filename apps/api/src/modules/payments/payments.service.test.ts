import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./payments.repository', () => ({
  paymentsRepository: {
    createTopup: vi.fn(),
    findById: vi.fn(),
    findByGatewayId: vi.fn(),
    listTopupsForUser: vi.fn(),
    settle: vi.fn(),
    recordEvent: vi.fn(),
    expirePending: vi.fn(),
  },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { env } from '../../config/env';
import { notificationsService } from '../notifications/notifications.service';
import { paymentGateway } from './gateway';
import { paymentsRepository, type PaymentRow } from './payments.repository';
import { paymentsService } from './payments.service';

const repo = vi.mocked(paymentsRepository);
/** O webhook como chega ao service: sem nome de evento, com o corpo inteiro. */
const RECEIPT = { event: null, body: { gatewayPaymentId: 'sim_X', status: 'paid' } };
/** O que vai para o histórico (RF-050) junto com a liquidação, pelo webhook e pela simulação. */
const WEBHOOK_NOTICE = { source: 'webhook', event: null, payload: RECEIPT.body };
const SIMULATION_NOTICE = { source: 'simulation', event: null, payload: { status: 'paid' } };
const notify = vi.mocked(notificationsService.notify);

type Fields = Partial<{
  id: number;
  kind: string;
  payer_id: number;
  amount: string;
  status: string;
  gateway: string;
  gateway_payment_id: string | null;
  gateway_response: string | Record<string, unknown> | null;
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
    expect(arg.response.pixCode).toMatch(/^000201.*6304[0-9A-F]{4}$/);
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
    expect(repo.settle).toHaveBeenCalledWith(7, 'paid', SIMULATION_NOTICE);
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

    const first = await paymentsService.settleFromGateway('sim_X', 'paid', RECEIPT);
    const again = await paymentsService.settleFromGateway('sim_X', 'paid', RECEIPT);
    expect(first.applied).toBe(true);
    expect(again.applied).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('404 para cobrança desconhecida', async () => {
    repo.findByGatewayId.mockResolvedValue(undefined);
    await expect(paymentsService.settleFromGateway('nope', 'paid', RECEIPT)).rejects.toMatchObject({
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

  it('lê o código PIX quando o driver já entrega o JSON como objeto', async () => {
    repo.findById.mockResolvedValue(row({ gateway_response: { pixCode: '000201OBJ' } }));
    expect((await paymentsService.getDeposit(7, 1)).pixCode).toBe('000201OBJ');
  });

  it('sem resposta do gateway guardada, ou sem código nela, o código PIX vem nulo', async () => {
    repo.findById.mockResolvedValueOnce(row({ gateway_response: null }));
    expect((await paymentsService.getDeposit(7, 1)).pixCode).toBeNull();

    repo.findById.mockResolvedValueOnce(row({ gateway_response: '{}' }));
    expect((await paymentsService.getDeposit(7, 1)).pixCode).toBeNull();
  });

  it('cobrança sem prazo nunca vence: continua pendente e sem data de expiração', async () => {
    repo.findById.mockResolvedValue(row({ expires_at: null }));

    const d = await paymentsService.getDeposit(7, 1);

    expect(d.status).toBe('pending');
    expect(d.expiresAt).toBeNull();
  });

  it('com a simulação desligada no ambiente, nem a cobrança pendente pode ser simulada', async () => {
    env.PAYMENTS_SIMULATE = false;
    repo.findById.mockResolvedValue(row());

    const d = await paymentsService.getDeposit(7, 1);

    expect(d.status).toBe('pending');
    expect(d.canSimulate).toBe(false);
  });

  it('só cobrança pendente vira cancelada pelo prazo; a liquidada mantém o status e não expõe código nem simulação', async () => {
    const past = new Date(Date.now() - 60_000);
    for (const status of ['paid', 'failed', 'cancelled']) {
      repo.findById.mockResolvedValueOnce(row({ status, expires_at: past }));
      const d = await paymentsService.getDeposit(7, 1);
      expect(d.status).toBe(status);
      expect(d.pixCode).toBeNull();
      expect(d.canSimulate).toBe(false);
    }
  });
});

describe('paymentsService.getDeposit (dono e tipo)', () => {
  it('404 quando o id não existe ou é um pagamento de contratação, não um depósito', async () => {
    repo.findById.mockResolvedValueOnce(undefined);
    await expect(paymentsService.getDeposit(7, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'deposit_not_found',
    });
    expect(repo.findById).toHaveBeenCalledWith(7);

    // Mesmo sendo de quem pede, pagamento de contrato não aparece como depósito.
    repo.findById.mockResolvedValueOnce(row({ kind: 'contract' }));
    await expect(paymentsService.getDeposit(7, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'deposit_not_found',
    });
  });

  it('403 quando o depósito é de outro usuário', async () => {
    repo.findById.mockResolvedValue(row({ payer_id: 2 }));
    await expect(paymentsService.getDeposit(7, 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
  });

  it('o dono recebe a cobrança mapeada: valor em número, gateway e referência gravados nela e datas em ISO', async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    // O gateway é o gravado na cobrança (outro de propósito), não o provedor em uso hoje.
    repo.findById.mockResolvedValue(
      row({ expires_at: expiresAt, gateway: 'pagarme', gateway_payment_id: 'ch_9Z' }),
    );

    expect(await paymentsService.getDeposit(7, 1)).toEqual({
      id: 7,
      amount: 150,
      status: 'pending',
      method: 'pix',
      gateway: 'pagarme',
      reference: 'ch_9Z',
      pixCode: '000201…6304ABCD',
      expiresAt: expiresAt.toISOString(),
      paidAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      canSimulate: true,
    });
  });
});

describe('paymentsService.listDeposits', () => {
  it('pede ao repositório a página pelo deslocamento (página - 1) × limite e mapeia cada cobrança', async () => {
    repo.listTopupsForUser.mockResolvedValue([
      row({ id: 9 }),
      row({ id: 8, status: 'paid', paid_at: new Date('2026-09-02T10:00:00Z') }),
    ]);

    const page = await paymentsService.listDeposits(1, 3, 10);

    expect(repo.listTopupsForUser).toHaveBeenCalledWith(1, 10, 20);
    expect(page.page).toBe(3);
    expect(page.limit).toBe(10);
    expect(page.items.map((d) => [d.id, d.status, d.paidAt])).toEqual([
      [9, 'pending', null],
      [8, 'paid', '2026-09-02T10:00:00.000Z'],
    ]);
  });

  it('sem depósitos devolve a lista vazia, e a primeira página começa do zero', async () => {
    repo.listTopupsForUser.mockResolvedValue([]);

    expect(await paymentsService.listDeposits(1, 1, 20)).toEqual({ items: [], page: 1, limit: 20 });
    expect(repo.listTopupsForUser).toHaveBeenCalledWith(1, 20, 0);
  });
});

describe('paymentsService.expirePending (job)', () => {
  it('devolve quantas cobranças vencidas o repositório cancelou', async () => {
    repo.expirePending.mockResolvedValue(4);

    expect(await paymentsService.expirePending()).toBe(4);
    expect(repo.expirePending).toHaveBeenCalledTimes(1);
    expect(repo.expirePending).toHaveBeenCalledWith();
    // O job só cancela o que venceu: não liquida nem avisa ninguém.
    expect(repo.settle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('sem nada vencido devolve zero, e erro do banco sobe para quem chamou', async () => {
    repo.expirePending.mockResolvedValueOnce(0);
    expect(await paymentsService.expirePending()).toBe(0);

    const boom = new Error('connection lost');
    repo.expirePending.mockRejectedValueOnce(boom);
    await expect(paymentsService.expirePending()).rejects.toBe(boom);
  });
});

describe('paymentsService.settleFromGateway: o que é liquidado e avisado', () => {
  it('pagamento aplicado avisa o titular com o valor em reais e a referência do depósito', async () => {
    repo.findByGatewayId.mockResolvedValue(row({ amount: '1500.50' }));
    repo.findById.mockResolvedValue(row({ amount: '1500.50', status: 'paid' }));
    repo.settle.mockResolvedValue(true);

    const out = await paymentsService.settleFromGateway('sim_X', 'paid', RECEIPT);

    expect(repo.findByGatewayId).toHaveBeenCalledWith('sim_X');
    expect(repo.settle).toHaveBeenCalledWith(7, 'paid', WEBHOOK_NOTICE);
    expect(out.deposit).toMatchObject({ id: 7, status: 'paid', amount: 1500.5 });
    expect(notify).toHaveBeenCalledTimes(1);
    const [userId, payload] = notify.mock.calls[0]!;
    expect(userId).toBe(1);
    // O aviso inteiro: tipo, título com o valor, o texto e os dados que o app usa para abrir o
    // depósito. Entre "R$" e o número a formatação pt-BR põe um espaço não separável.
    expect(payload).toEqual({
      type: 'deposit_confirmed',
      title: expect.stringMatching(/^Depósito de R\$\s1\.500,50 confirmado$/),
      body: 'O valor já está disponível na sua carteira para contratar.',
      data: { paymentId: 7, amount: 1500.5 },
    });
  });

  it('o aviso vai para o pagador da cobrança, que é quem tem a carteira creditada', async () => {
    repo.findByGatewayId.mockResolvedValue(row({ id: 31, payer_id: 44, amount: '19.99' }));
    repo.findById.mockResolvedValue(row({ id: 31, payer_id: 44, amount: '19.99', status: 'paid' }));
    repo.settle.mockResolvedValue(true);

    await paymentsService.settleFromGateway('sim_OUTRA', 'paid', RECEIPT);

    expect(repo.findByGatewayId).toHaveBeenCalledWith('sim_OUTRA');
    expect(repo.settle).toHaveBeenCalledWith(31, 'paid', WEBHOOK_NOTICE);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        type: 'deposit_confirmed',
        title: expect.stringMatching(/^Depósito de R\$\s19,99 confirmado$/),
        data: { paymentId: 31, amount: 19.99 },
      }),
    );
  });

  it('se a liquidação falha no banco, o erro sobe, ninguém é avisado e a cobrança não é relida', async () => {
    const boom = new Error('deadlock');
    repo.findByGatewayId.mockResolvedValue(row());
    repo.settle.mockRejectedValueOnce(boom);

    await expect(paymentsService.settleFromGateway('sim_X', 'paid', RECEIPT)).rejects.toBe(boom);

    expect(notify).not.toHaveBeenCalled();
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('cobrança que falhou é liquidada como failed e ninguém é avisado de depósito confirmado', async () => {
    repo.findByGatewayId.mockResolvedValue(row());
    repo.findById.mockResolvedValue(row({ status: 'failed' }));
    repo.settle.mockResolvedValue(true);

    const out = await paymentsService.settleFromGateway('sim_X', 'failed', RECEIPT);

    expect(repo.settle).toHaveBeenCalledWith(7, 'failed', WEBHOOK_NOTICE);
    expect(out.applied).toBe(true);
    expect(out.deposit.status).toBe('failed');
    expect(notify).not.toHaveBeenCalled();
  });

  it('cobrança desconhecida não tenta liquidar nada', async () => {
    repo.findByGatewayId.mockResolvedValue(undefined);

    await expect(paymentsService.settleFromGateway('nope', 'paid', RECEIPT)).rejects.toMatchObject({
      statusCode: 404,
      code: 'payment_not_found',
    });
    expect(repo.settle).not.toHaveBeenCalled();
  });
});

describe('paymentsService.createDeposit: o que vai para o banco', () => {
  it('registra a cobrança do usuário com a validade configurada e relê o depósito pelo id gravado', async () => {
    const configured = env.DEPOSIT_EXPIRES_MINUTES;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T15:00:00.000Z'));
    // Validade diferente do padrão (30), para o teste não passar com um valor fixo no código.
    env.DEPOSIT_EXPIRES_MINUTES = 45;
    try {
      repo.createTopup.mockResolvedValue(42);
      repo.findById.mockResolvedValue(row({ id: 42 }));

      const d = await paymentsService.createDeposit(5, { amount: 80.5, method: 'pix' });

      expect(repo.createTopup).toHaveBeenCalledTimes(1);
      const arg = repo.createTopup.mock.calls[0]![0];
      expect(arg.payerId).toBe(5);
      expect(arg.amount).toBe(80.5);
      expect(arg.response.pixCode).toContain('540580.50');
      expect(arg.expiresAt).toEqual(new Date('2026-10-02T15:45:00.000Z'));
      expect(repo.findById).toHaveBeenCalledTimes(1);
      expect(repo.findById).toHaveBeenCalledWith(42);
      expect(d.id).toBe(42);
    } finally {
      env.DEPOSIT_EXPIRES_MINUTES = configured;
      vi.useRealTimers();
    }
  });

  it('se o gateway não gera a cobrança, nada é gravado nem devolvido', async () => {
    const boom = new Error('gateway fora do ar');
    const charge = vi.spyOn(paymentGateway, 'createPixCharge').mockRejectedValueOnce(boom);
    try {
      await expect(paymentsService.createDeposit(5, { amount: 150, method: 'pix' })).rejects.toBe(
        boom,
      );

      expect(repo.createTopup).not.toHaveBeenCalled();
      expect(repo.findById).not.toHaveBeenCalled();
    } finally {
      charge.mockRestore();
    }
  });

  it('o que é gravado é o que o gateway devolveu: referência, código PIX e validade da cobrança dele', async () => {
    const expiresAt = new Date('2026-10-02T16:00:00.000Z');
    const charge = vi.spyOn(paymentGateway, 'createPixCharge').mockResolvedValueOnce({
      externalId: 'gw_777',
      pixCode: '000201GATEWAY6304FFFF',
      expiresAt,
    });
    try {
      repo.createTopup.mockResolvedValue(9);
      repo.findById.mockResolvedValue(row({ id: 9 }));

      await paymentsService.createDeposit(5, { amount: 150, method: 'pix' });

      // O gateway recebe o valor pedido e uma referência nova (ULID).
      expect(charge).toHaveBeenCalledTimes(1);
      expect(charge).toHaveBeenCalledWith({
        amount: 150,
        reference: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      });
      expect(repo.createTopup).toHaveBeenCalledWith({
        payerId: 5,
        amount: 150,
        gateway: 'simulado',
        gatewayPaymentId: 'gw_777',
        response: {
          externalId: 'gw_777',
          pixCode: '000201GATEWAY6304FFFF',
          expiresAt: '2026-10-02T16:00:00.000Z',
        },
        expiresAt,
      });
    } finally {
      charge.mockRestore();
    }
  });

  it('cada depósito ganha uma referência própria (a chave de idempotência do webhook), e o txid dela vai no código PIX', async () => {
    repo.createTopup.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    repo.findById.mockResolvedValue(row());

    await paymentsService.createDeposit(5, { amount: 150, method: 'pix' });
    await paymentsService.createDeposit(5, { amount: 150, method: 'pix' });

    const first = repo.createTopup.mock.calls[0]![0];
    const second = repo.createTopup.mock.calls[1]![0];
    // sim_ + ULID (26 caracteres em base32 de Crockford).
    expect(first.gatewayPaymentId).toMatch(/^sim_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second.gatewayPaymentId).toMatch(/^sim_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second.gatewayPaymentId).not.toBe(first.gatewayPaymentId);
    // O txid do BR Code tem no máximo 25 caracteres: os 25 primeiros da referência.
    expect(first.response.pixCode).toContain(`0525${first.gatewayPaymentId.slice(4, 29)}`);
    expect(first.gateway).toBe('simulado');
  });

  it('se a gravação falha, o erro sobe e nenhum depósito é devolvido', async () => {
    const boom = new Error('ER_DUP_ENTRY');
    repo.createTopup.mockRejectedValue(boom);

    await expect(paymentsService.createDeposit(5, { amount: 150, method: 'pix' })).rejects.toBe(
      boom,
    );

    expect(repo.findById).not.toHaveBeenCalled();
  });
});

describe('paymentsService.simulate: quem é barrado não liquida nem avisa', () => {
  it('depósito de outro usuário é 403 forbidden, sem liquidar nada', async () => {
    repo.findById.mockResolvedValue(row({ payer_id: 2 }));

    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });

    expect(repo.findById).toHaveBeenCalledWith(7);
    expect(repo.settle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('pagamento que não é depósito não pode ser simulado, mesmo sendo de quem pede: 404', async () => {
    repo.findById.mockResolvedValue(row({ kind: 'contract' }));

    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'deposit_not_found',
    });

    expect(repo.settle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('cobrança vencida é 409 e não chega a ser liquidada', async () => {
    repo.findById.mockResolvedValue(row({ expires_at: new Date(Date.now() - 1000) }));

    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'deposit_expired',
    });

    expect(repo.settle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('cobrança já liquidada é 409 e o titular não é avisado de novo', async () => {
    repo.findById.mockResolvedValue(row({ status: 'paid', paid_at: new Date() }));
    repo.settle.mockResolvedValue(false);

    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'deposit_not_pending',
    });

    expect(repo.settle).toHaveBeenCalledTimes(1);
    expect(repo.settle).toHaveBeenCalledWith(7, 'paid', SIMULATION_NOTICE);
    expect(notify).not.toHaveBeenCalled();
  });

  it('com a simulação desligada, o depósito nem é consultado', async () => {
    env.PAYMENTS_SIMULATE = false;
    repo.findById.mockResolvedValue(row());

    await expect(paymentsService.simulate(7, 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'simulation_disabled',
    });

    expect(repo.findById).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('simulação aceita devolve a cobrança relida depois de liquidada e avisa o dono com valor e referência', async () => {
    const paidAt = new Date('2026-10-02T15:05:00.000Z');
    repo.findById
      .mockResolvedValueOnce(row({ id: 12, payer_id: 5, amount: '80.50' }))
      .mockResolvedValueOnce(
        row({ id: 12, payer_id: 5, amount: '80.50', status: 'paid', paid_at: paidAt }),
      );
    repo.settle.mockResolvedValue(true);

    const d = await paymentsService.simulate(12, 5);

    expect(repo.settle).toHaveBeenCalledTimes(1);
    expect(repo.settle).toHaveBeenCalledWith(12, 'paid', SIMULATION_NOTICE);
    expect(repo.findById).toHaveBeenCalledTimes(2);
    expect(repo.findById).toHaveBeenLastCalledWith(12);
    expect(d).toMatchObject({
      id: 12,
      amount: 80.5,
      status: 'paid',
      paidAt: '2026-10-02T15:05:00.000Z',
      pixCode: null,
      canSimulate: false,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const [userId, payload] = notify.mock.calls[0]!;
    expect(userId).toBe(5);
    expect(payload.type).toBe('deposit_confirmed');
    expect(payload.title).toMatch(/^Depósito de R\$\s80,50 confirmado$/);
    expect(payload.data).toEqual({ paymentId: 12, amount: 80.5 });
  });
});

describe('paymentsService.settleFromGateway: a resposta é a cobrança relida', () => {
  it('falha que chega depois do pagamento não é aplicada nem avisada, e devolve a cobrança como está', async () => {
    repo.findByGatewayId.mockResolvedValue(row({ id: 31, status: 'paid' }));
    repo.findById.mockResolvedValue(row({ id: 31, status: 'paid' }));
    repo.settle.mockResolvedValue(false);

    const out = await paymentsService.settleFromGateway('sim_X', 'failed', RECEIPT);

    expect(repo.settle).toHaveBeenCalledWith(31, 'failed', WEBHOOK_NOTICE);
    expect(repo.findById).toHaveBeenCalledTimes(1);
    expect(repo.findById).toHaveBeenCalledWith(31);
    expect(out.applied).toBe(false);
    expect(out.deposit).toMatchObject({ id: 31, status: 'paid' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('o depósito devolvido vem da releitura, não da linha de antes da liquidação', async () => {
    const paidAt = new Date('2026-10-02T15:05:00.000Z');
    repo.findByGatewayId.mockResolvedValue(row({ status: 'pending', paid_at: null }));
    repo.findById.mockResolvedValue(row({ status: 'paid', paid_at: paidAt }));
    repo.settle.mockResolvedValue(true);

    const out = await paymentsService.settleFromGateway('sim_X', 'paid', RECEIPT);

    expect(repo.findById).toHaveBeenCalledWith(7);
    expect(out).toMatchObject({
      applied: true,
      deposit: { status: 'paid', paidAt: '2026-10-02T15:05:00.000Z', pixCode: null },
    });
  });
});

describe('toDeposit: o prazo no limite', () => {
  it('a cobrança vence só depois do instante do prazo: no instante exato ainda está pendente', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T15:00:00.000Z'));
    try {
      repo.findById.mockResolvedValueOnce(
        row({ expires_at: new Date('2026-10-02T15:00:00.000Z') }),
      );
      const atLimit = await paymentsService.getDeposit(7, 1);
      expect(atLimit.status).toBe('pending');
      expect(atLimit.pixCode).toBe('000201…6304ABCD');
      expect(atLimit.canSimulate).toBe(true);

      repo.findById.mockResolvedValueOnce(
        row({ expires_at: new Date('2026-10-02T14:59:59.999Z') }),
      );
      const justPast = await paymentsService.getDeposit(7, 1);
      expect(justPast.status).toBe('cancelled');
      // Vencida não expõe mais o código para pagar, mas mantém a data do prazo.
      expect(justPast.pixCode).toBeNull();
      expect(justPast.expiresAt).toBe('2026-10-02T14:59:59.999Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('paymentsService: histórico do gateway (RF-050)', () => {
  it('webhook que liquida vai junto com a liquidação, higienizado: nenhuma linha avulsa', async () => {
    repo.findByGatewayId.mockResolvedValue(row());
    repo.findById.mockResolvedValue(row({ status: 'paid' }));
    repo.settle.mockResolvedValue(true);
    const body = {
      event: 'payment.updated',
      gatewayPaymentId: 'sim_X',
      status: 'paid',
      payer: { name: 'Maria', cpf: '123.456.789-00' },
    };

    await paymentsService.settleFromGateway('sim_X', 'paid', { event: 'payment.updated', body });

    expect(repo.settle).toHaveBeenCalledWith(7, 'paid', {
      source: 'webhook',
      event: 'payment.updated',
      payload: {
        event: 'payment.updated',
        gatewayPaymentId: 'sim_X',
        status: 'paid',
        payer: '[omitido]',
      },
    });
    expect(repo.recordEvent).not.toHaveBeenCalled();
  });

  it('webhook repetido não liquida de novo, mas fica no histórico como ignored, ligado à cobrança', async () => {
    repo.findByGatewayId.mockResolvedValue(row({ status: 'paid', gateway: 'simulado' }));
    repo.findById.mockResolvedValue(row({ status: 'paid' }));
    repo.settle.mockResolvedValue(false);

    const out = await paymentsService.settleFromGateway('sim_X', 'paid', RECEIPT);

    expect(out.applied).toBe(false);
    expect(repo.recordEvent).toHaveBeenCalledExactlyOnceWith({
      paymentId: 7,
      gateway: 'simulado',
      gatewayPaymentId: 'sim_X',
      source: 'webhook',
      event: null,
      status: 'paid',
      outcome: 'ignored',
      payload: RECEIPT.body,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('cobrança desconhecida: o corpo fica no histórico sem cobrança (not_found) e a resposta é 404', async () => {
    repo.findByGatewayId.mockResolvedValue(undefined);

    await expect(
      paymentsService.settleFromGateway('sim_nada', 'failed', { event: 'x', body: { a: 1 } }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'payment_not_found' });

    expect(repo.recordEvent).toHaveBeenCalledExactlyOnceWith({
      paymentId: null,
      gateway: paymentGateway.name,
      gatewayPaymentId: 'sim_nada',
      source: 'webhook',
      event: 'x',
      status: 'failed',
      outcome: 'not_found',
      payload: { a: 1 },
    });
    expect(repo.settle).not.toHaveBeenCalled();
  });

  it('se o histórico do repetido não grava, o erro sobe (o gateway reenvia, e o efeito segue idempotente)', async () => {
    const boom = new Error('payment_events');
    repo.findByGatewayId.mockResolvedValue(row({ status: 'paid' }));
    repo.settle.mockResolvedValue(false);
    repo.recordEvent.mockRejectedValueOnce(boom);

    await expect(paymentsService.settleFromGateway('sim_X', 'paid', RECEIPT)).rejects.toBe(boom);
    expect(notify).not.toHaveBeenCalled();
  });

  it('corpo fora do formato: liga à cobrança quando o id veio e existe, com evento e status curtos', async () => {
    repo.findByGatewayId.mockResolvedValue(row({ id: 31, gateway: 'pagarme' }));

    await paymentsService.recordInvalidWebhook({
      gatewayPaymentId: 'sim_X',
      status: 'x'.repeat(30),
      event: 7,
      email: 'quem@pagou.test',
    });

    expect(repo.findByGatewayId).toHaveBeenCalledWith('sim_X');
    expect(repo.recordEvent).toHaveBeenCalledExactlyOnceWith({
      paymentId: 31,
      gateway: 'pagarme',
      gatewayPaymentId: 'sim_X',
      source: 'webhook',
      event: null,
      status: 'x'.repeat(20),
      outcome: 'invalid',
      payload: { gatewayPaymentId: 'sim_X', status: 'x'.repeat(30), event: 7, email: '[omitido]' },
    });
  });

  it('corpo fora do formato sem id (ou que não é objeto) fica sem cobrança, e nem procura', async () => {
    await paymentsService.recordInvalidWebhook(['lista']);
    await paymentsService.recordInvalidWebhook(null);

    expect(repo.findByGatewayId).not.toHaveBeenCalled();
    expect(
      repo.recordEvent.mock.calls.map(([e]) => [e.paymentId, e.gatewayPaymentId, e.payload]),
    ).toEqual([
      [null, null, ['lista']],
      [null, null, null],
    ]);
    expect(repo.recordEvent.mock.calls[0]![0]).toMatchObject({
      gateway: paymentGateway.name,
      outcome: 'invalid',
    });
  });

  it('id que não existe no corpo inválido: procura, não acha e grava sem cobrança', async () => {
    repo.findByGatewayId.mockResolvedValue(undefined);

    await paymentsService.recordInvalidWebhook({ gatewayPaymentId: 'sim_Y' });

    expect(repo.recordEvent.mock.calls[0]![0]).toMatchObject({
      paymentId: null,
      gatewayPaymentId: 'sim_Y',
      gateway: paymentGateway.name,
    });
  });

  it('a criação guarda o corpo original do provedor, quando há um, higienizado', async () => {
    const expiresAt = new Date('2026-10-02T16:00:00.000Z');
    const charge = vi.spyOn(paymentGateway, 'createPixCharge').mockResolvedValueOnce({
      externalId: 'gw_1',
      pixCode: '000201X',
      expiresAt,
      raw: { id: 'gw_1', status: 'pending', customer: { document: '123' }, qr: { url: 'u' } },
    });
    try {
      repo.createTopup.mockResolvedValue(9);
      repo.findById.mockResolvedValue(row({ id: 9 }));

      await paymentsService.createDeposit(5, { amount: 150, method: 'pix' });

      expect(repo.createTopup.mock.calls[0]![0].response).toEqual({
        externalId: 'gw_1',
        pixCode: '000201X',
        expiresAt: '2026-10-02T16:00:00.000Z',
        raw: { id: 'gw_1', status: 'pending', customer: '[omitido]', qr: { url: 'u' } },
      });
    } finally {
      charge.mockRestore();
    }
  });
});
