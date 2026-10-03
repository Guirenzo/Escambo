import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../config/logger';
import { notificationsService } from '../notifications/notifications.service';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { deadlineRemindersService } from './deadline-reminders.service';
import { milestonesRepository, type MilestoneRow } from './milestones.repository';
import { remindersRepository, type ReminderCandidate } from './reminders.repository';

/** A conexão falsa da transação: cada passo dela entra na mesma fila de eventos do teste. */
const { conn, getConnection, order } = vi.hoisted(() => {
  const order: string[] = [];
  const conn = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  return { conn, getConnection: vi.fn(), order };
});
vi.mock('../../config/db', () => ({ pool: { getConnection } }));
vi.mock('./reminders.repository', () => ({
  remindersRepository: { lockContract: vi.fn(), claim: vi.fn() },
}));
vi.mock('./contracts.repository', () => ({ contractsRepository: { findById: vi.fn() } }));
vi.mock('./milestones.repository', () => ({
  milestonesRepository: { listForContract: vi.fn(), titlesByDelivery: vi.fn() },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { persist: vi.fn(), dispatch: vi.fn() },
}));

const reminders = vi.mocked(remindersRepository);
const contracts = vi.mocked(contractsRepository);
const milestones = vi.mocked(milestonesRepository);
const notifications = vi.mocked(notificationsService);

/** qui, 01/10/2026 às 12:00 em Brasília (10:00 em Rio Branco). */
const NOW = new Date('2026-10-01T15:00:00.000Z');
/** Fim do dia 02/10 em Brasília (sex): 23:59:59. */
const END_02_SP = new Date('2026-10-03T02:59:59.000Z');
/** Fim do dia 09/10 em Brasília (sex). */
const END_09_SP = new Date('2026-10-10T02:59:59.000Z');
/** Fim do dia 30/09 em Brasília (qua): já passou. */
const END_30_SP = new Date('2026-10-01T02:59:59.000Z');

const dbError = (code: string): Error => Object.assign(new Error(code), { code });

/** As colunas da linha, opcionais, sem a assinatura de índice nem o `constructor` do RowDataPacket. */
type Columns<T> = {
  [
    K in keyof T as string extends K
      ? never
      : number extends K
        ? never
        : K extends 'constructor'
          ? never
          : K
  ]?: T[K];
};

function contract(over: Columns<ContractRow> = {}): ContractRow {
  return {
    id: 7,
    ulid: '01JLEMBRETE0000000000000007',
    client_id: 1,
    freelancer_id: 2,
    service_id: null,
    title: 'Logo nova',
    description: 'Logo para a padaria',
    price: '500.00',
    platform_fee: '50.00',
    freelancer_net: '450.00',
    status: 'in_progress',
    payment_mode: 'cash',
    barter_agreement_id: null,
    deadline_at: END_02_SP,
    accepted_at: new Date('2026-09-20T15:00:00.000Z'),
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-09-19T15:00:00.000Z'),
    has_milestones: 0,
    extension_status: 'none',
    extension_requests: 0,
    extension_deadline_at: null,
    extension_reason: null,
    extension_requested_at: null,
    extension_respond_by: null,
    extension_resolved_at: null,
    deadline_extended_at: null,
    overdue_notified_at: null,
    grace_ends_at: null,
    approval_due_at: null,
    revision_requested_at: null,
    proposal_expires_at: null,
    total_milestones: 0,
    undelivered_milestones: 0,
    delivered_awaiting: 0,
    in_revision: 0,
    deliveries_count: 0,
    first_delivered_at: null,
    freelancer_timezone: 'America/Sao_Paulo',
    client_timezone: 'America/Sao_Paulo',
    ...over,
  } as unknown as ContractRow;
}

function candidate(over: Columns<ReminderCandidate> = {}): ReminderCandidate {
  return {
    contract_id: 7,
    entity_id: 7,
    due_at: END_02_SP,
    seq: 0,
    start_at: null,
    client_id: 1,
    freelancer_id: 2,
    client_timezone: 'America/Sao_Paulo',
    freelancer_timezone: 'America/Sao_Paulo',
    ...over,
  } as unknown as ReminderCandidate;
}

function milestone(over: Columns<MilestoneRow>): MilestoneRow {
  return {
    id: 31,
    contract_id: 7,
    title: 'Layout',
    description: null,
    amount: '300.00',
    freelancer_net: '270.00',
    sort_order: 1,
    status: 'delivered',
    due_at: null,
    overdue_notified_at: null,
    delivered_at: new Date('2026-09-28T15:00:00.000Z'),
    approval_due_at: null,
    revision_requested_at: null,
    delivery_note: null,
    revision_note: null,
    released_at: null,
    created_at: new Date('2026-09-19T15:00:00.000Z'),
    ...over,
  } as unknown as MilestoneRow;
}

/** A contratação que a trava lê (os fatos do texto). */
function facts(row: ContractRow | undefined): void {
  contracts.findById.mockImplementation(async () => {
    order.push('fatos');
    return row;
  });
}

/** O que foi gravado na transação, na ordem: [usuário, notificação]. */
const persisted = (): unknown[][] =>
  notifications.persist.mock.calls.map(([u, input]) => [u, input]);

function expectRolledBack(): void {
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledTimes(1);
  expect(notifications.persist).not.toHaveBeenCalled();
  expect(notifications.dispatch).not.toHaveBeenCalled();
}

/**
 * O envio de um lembrete (ADR 58) sem banco: a transação por contratação (trava compartilhada →
 * trava do lembrete → fatos → notificação gravada com a conexão → COMMIT → envio), o que desfaz e o
 * texto de cada tipo com os fatos lidos sob a trava.
 */
describe('envio dos lembretes (ADR 58)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    order.length = 0;
    getConnection.mockResolvedValue(conn);
    conn.beginTransaction.mockImplementation(async () => {
      order.push('begin');
    });
    conn.commit.mockImplementation(async () => {
      order.push('commit');
    });
    conn.rollback.mockImplementation(async () => {
      order.push('rollback');
    });
    conn.release.mockImplementation(() => {
      order.push('release');
    });
    reminders.lockContract.mockImplementation(async () => {
      order.push('trava');
      return true;
    });
    reminders.claim.mockImplementation(async (_c, kind, p) => {
      order.push(`claim ${kind} ${p.entityId}`);
      return true;
    });
    let id = 900;
    notifications.persist.mockImplementation(async (userId, params) => {
      order.push(`grava ${userId}`);
      return { userId, id: ++id, params };
    });
    notifications.dispatch.mockImplementation((saved) => {
      order.push(`envia ${saved.userId}`);
    });
    milestones.titlesByDelivery.mockResolvedValue({ delivered: [], missing: [] });
    milestones.listForContract.mockResolvedValue([]);
    warn = vi.spyOn(logger, 'warn');
  });
  afterEach(() => vi.restoreAllMocks());

  describe('a transação', () => {
    const proposal = (): ContractRow =>
      contract({
        status: 'pending',
        accepted_at: null,
        proposal_expires_at: new Date('2026-10-02T15:00:00.000Z'),
        deadline_at: END_09_SP,
      });

    it('trava a contratação, ganha a trava do lembrete, lê os fatos, grava com a conexão, confirma e só então envia, com etiqueta própria', async () => {
      facts(proposal());
      const c = candidate({
        due_at: new Date('2026-10-02T15:00:00.000Z'),
        start_at: new Date('2026-09-19T15:00:00.000Z'),
      });

      expect(await deadlineRemindersService.proposal(c, NOW)).toBe(true);

      expect(order).toEqual([
        'begin',
        'trava',
        'claim proposal 7',
        'fatos',
        'grava 2',
        'commit',
        'envia 2',
        'release',
      ]);
      expect(reminders.lockContract).toHaveBeenCalledWith(conn, 7);
      expect(reminders.claim).toHaveBeenCalledWith(
        conn,
        'proposal',
        expect.objectContaining({
          contractId: 7,
          entityId: 7,
          due: new Date('2026-10-02T15:00:00.000Z'),
          seq: 0,
          start: new Date('2026-09-19T15:00:00.000Z'),
          now: NOW,
        }),
      );
      expect(contracts.findById).toHaveBeenCalledWith(7, conn);
      const params = {
        type: 'contract_proposal_reminder',
        title: 'Responda à proposta até sex, 02/10 às 12:00: Logo nova',
        body: 'Aceite ou recuse até lá. Sem resposta, a proposta se encerra e o valor reservado volta ao cliente. Se aceitar, o prazo de entrega é sex, 09/10/2026, até 23:59.',
        data: { contractId: 7 },
      };
      expect(notifications.persist.mock.calls).toEqual([[2, params, conn]]);
      expect(notifications.dispatch.mock.calls).toEqual([
        [{ userId: 2, id: 901, params }, { ownTag: true }],
      ]);
      expect(conn.rollback).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a candidata trouxe o início como data',
        new Date('2026-09-30T13:00:00.000Z'),
        new Date('2026-09-30T13:00:00.000Z'),
      ],
      [
        'o banco trouxe o início como texto',
        '2026-09-30T13:00:00.000Z',
        new Date('2026-09-30T13:00:00.000Z'),
      ],
      ['a candidata não tem início', null, null],
    ] as const)(
      'a trava recebe o início que a leitura viu (%s), para não gravar se uma recusa o mudou',
      async (_case, startAt, start) => {
        facts(contract());

        expect(
          await deadlineRemindersService.delivery(
            candidate({ start_at: startAt as unknown as Date | null }),
            24,
            NOW,
          ),
        ).toBe(true);

        expect(reminders.claim).toHaveBeenCalledTimes(1);
        expect(reminders.claim.mock.calls[0]![2].start).toEqual(start);
        expect(reminders.claim).toHaveBeenCalledWith(
          conn,
          'delivery',
          expect.objectContaining({ contractId: 7, entityId: 7, due: END_02_SP, seq: 0, start }),
        );
      },
    );

    it('a recusa do pedido de extensão mudou o início entre a leitura e a trava: a trava não grava, desfaz e nada sai', async () => {
      // A leitura viu o início antigo; a trava compara com o banco, que já tem a hora da recusa.
      const declinedAt = new Date('2026-10-01T14:00:00.000Z');
      reminders.claim.mockImplementation(async (_c, kind, p) => {
        order.push(`claim ${kind} ${p.entityId}`);
        return p.start?.getTime() === declinedAt.getTime();
      });
      facts(contract({ extension_status: 'declined', extension_resolved_at: declinedAt }));

      expect(
        await deadlineRemindersService.delivery(
          candidate({ start_at: new Date('2026-09-20T15:00:00.000Z') }),
          24,
          NOW,
        ),
      ).toBe(false);

      expect(order).toEqual(['begin', 'trava', 'claim delivery 7', 'rollback', 'release']);
      expect(contracts.findById).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('nenhuma trava ganha (o estado mudou ou outra instância levou): desfaz, nem lê os fatos e nada sai', async () => {
      reminders.claim.mockImplementation(async () => {
        order.push('claim perdido');
        return false;
      });
      facts(proposal());

      expect(await deadlineRemindersService.proposal(candidate(), NOW)).toBe(false);

      expect(order).toEqual(['begin', 'trava', 'claim perdido', 'rollback', 'release']);
      expect(contracts.findById).not.toHaveBeenCalled();
      expectRolledBack();
      expect(warn).not.toHaveBeenCalled();
    });

    it('a contratação sumiu antes da trava: desfaz sem tentar a trava do lembrete', async () => {
      reminders.lockContract.mockImplementation(async () => {
        order.push('trava vazia');
        return false;
      });

      expect(await deadlineRemindersService.approval(candidate(), NOW)).toBe(false);

      expect(order).toEqual(['begin', 'trava vazia', 'rollback', 'release']);
      expect(reminders.claim).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it.each([
      ['o pedido de extensão ficou pendente (o prazo pausou)', { extension_status: 'pending' }],
      ['a entrega foi registrada (nada mais a cobrar)', { deliveries_count: 1 }],
      ['o prazo já venceu', { deadline_at: END_30_SP }],
      ['a contratação foi concluída', { status: 'completed' }],
    ] as const)(
      'os fatos não sustentam o lembrete da entrega (%s): desfaz com aviso no log, e a trava não fica queimada',
      async (_case, over) => {
        facts(contract(over as Columns<ContractRow>));

        expect(await deadlineRemindersService.delivery(candidate(), 24, NOW)).toBe(false);

        expect(order).toEqual([
          'begin',
          'trava',
          'claim delivery 7',
          'fatos',
          'rollback',
          'release',
        ]);
        expectRolledBack();
        expect(warn.mock.calls).toEqual([
          [{ contractId: 7, kinds: ['delivery'] }, 'lembrete sem fatos que o sustentem: desfeito'],
        ]);
      },
    );

    it('a contratação não volta na leitura dos fatos: desfaz com aviso no log', async () => {
      facts(undefined);

      expect(await deadlineRemindersService.approval(candidate(), NOW)).toBe(false);

      expectRolledBack();
      expect(warn.mock.calls).toEqual([
        [{ contractId: 7, kinds: ['approval'] }, 'lembrete sem fatos que o sustentem: desfeito'],
      ]);
    });

    it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])(
      '%s desfaz e adia para a próxima rodada, sem lançar',
      async (code) => {
        const err = dbError(code);
        reminders.claim.mockRejectedValue(err);

        expect(await deadlineRemindersService.extension(candidate(), NOW)).toBe(false);

        expectRolledBack();
        expect(warn.mock.calls).toEqual([
          [{ err, contractId: 7 }, 'lembrete adiado: trava ocupada'],
        ]);
      },
    );

    it('trava ocupada nos marcos devolve a lista vazia', async () => {
      const err = dbError('ER_LOCK_WAIT_TIMEOUT');
      reminders.lockContract.mockRejectedValue(err);

      expect(
        await deadlineRemindersService.milestoneApprovals(7, [candidate({ entity_id: 31 })], NOW),
      ).toEqual([]);

      expectRolledBack();
      expect(warn.mock.calls).toEqual([[{ err, contractId: 7 }, 'lembrete adiado: trava ocupada']]);
    });

    it('outro erro desfaz, solta a conexão e sobe para o job (nada é enviado)', async () => {
      facts(proposal());
      const boom = dbError('ER_DATA_TOO_LONG');
      notifications.persist.mockRejectedValue(boom);

      await expect(deadlineRemindersService.proposal(candidate(), NOW)).rejects.toBe(boom);

      expect(conn.rollback).toHaveBeenCalledTimes(1);
      expect(conn.commit).not.toHaveBeenCalled();
      expect(conn.release).toHaveBeenCalledTimes(1);
      expect(notifications.dispatch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('o rollback que falha no meio do erro não esconde o erro original', async () => {
      facts(proposal());
      const boom = new Error('socket fechado');
      notifications.persist.mockRejectedValue(boom);
      conn.rollback.mockRejectedValue(new Error('conexão perdida'));

      await expect(deadlineRemindersService.proposal(candidate(), NOW)).rejects.toBe(boom);

      expect(conn.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('proposta, ao freelancer', () => {
    it.each([
      [
        'em créditos, com o prazo de Brasília lido em Manaus',
        { payment_mode: 'credits', deadline_at: END_09_SP },
        'Responda à proposta até sex, 02/10 às 11:00: Logo nova',
        'Aceite ou recuse até lá. Sem resposta, a proposta se encerra. Se aceitar, o prazo de entrega é sex, 09/10/2026, até 23:59 (horário de Brasília).',
      ],
      [
        'sem prazo de entrega',
        { payment_mode: 'cash', deadline_at: null },
        'Responda à proposta até sex, 02/10 às 11:00: Logo nova',
        'Aceite ou recuse até lá. Sem resposta, a proposta se encerra e o valor reservado volta ao cliente.',
      ],
    ] as const)('%s', async (_case, over, title, body) => {
      facts(
        contract({
          status: 'pending',
          proposal_expires_at: new Date('2026-10-02T15:00:00.000Z'),
          freelancer_timezone: 'America/Manaus',
          ...(over as Columns<ContractRow>),
        }),
      );

      expect(await deadlineRemindersService.proposal(candidate(), NOW)).toBe(true);

      expect(persisted()).toEqual([
        [2, { type: 'contract_proposal_reminder', title, body, data: { contractId: 7 } }],
      ]);
    });
  });

  describe('entrega, a quem entrega', () => {
    it('entrega única: o dia do prazo, a hora do aviso de atraso (a mesma conta da Sala) e a carência de hoje', async () => {
      facts(contract());

      expect(await deadlineRemindersService.delivery(candidate(), 24, NOW)).toBe(true);

      expect(milestones.titlesByDelivery).not.toHaveBeenCalled();
      expect(persisted()).toEqual([
        [
          2,
          {
            type: 'contract_deadline_reminder',
            title: 'Entregue até sex, 02/10: Logo nova',
            body: 'Registre a entrega até lá ou peça a extensão antes. Sem entrega, a partir de sáb, 03/10 às 09:00 o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 02/10/2026, até 23:59.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it('por marcos, em Manaus, sem pedido de extensão e com marco entregue em aberto: lista o que falta e não oferece o cancelamento', async () => {
      facts(
        contract({
          has_milestones: 1,
          total_milestones: 3,
          undelivered_milestones: 2,
          delivered_awaiting: 1,
          extension_status: 'declined',
          extension_requests: 2,
          freelancer_timezone: 'America/Manaus',
        }),
      );
      milestones.titlesByDelivery.mockResolvedValue({
        delivered: ['Briefing'],
        missing: ['Layout', 'Código'],
      });

      expect(await deadlineRemindersService.delivery(candidate(), 1, NOW)).toBe(true);

      // Os marcos que faltam são lidos na conexão da transação, com a contratação travada.
      expect(milestones.titlesByDelivery).toHaveBeenCalledWith(7, conn);
      expect(persisted()).toEqual([
        [
          2,
          {
            type: 'contract_deadline_reminder',
            title: 'Entregue até sex, 02/10: Logo nova',
            body: 'Entregue os marcos «Layout» e «Código» até lá: não há mais pedido de extensão. Sem as entregas, a partir de sáb, 03/10 às 09:00 o Escambo avisa vocês dois e começa a carência até a disputa automática (hoje, 1 hora). O prazo é sex, 02/10/2026, até 23:59 (horário de Brasília).',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it('linha sem as colunas calculadas dos marcos: vale zero (entrega única, cancelamento aberto)', async () => {
      facts(
        contract({
          has_milestones: undefined,
          total_milestones: undefined,
          undelivered_milestones: undefined,
          delivered_awaiting: undefined,
          in_revision: undefined,
        }),
      );

      expect(await deadlineRemindersService.delivery(candidate(), 24, NOW)).toBe(true);

      expect(milestones.titlesByDelivery).not.toHaveBeenCalled();
      expect(persisted()).toEqual([
        [
          2,
          {
            type: 'contract_deadline_reminder',
            title: 'Entregue até sex, 02/10: Logo nova',
            body: 'Registre a entrega até lá ou peça a extensão antes. Sem entrega, a partir de sáb, 03/10 às 09:00 o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 02/10/2026, até 23:59.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it('por marcos, com um marco de volta em revisão: também não oferece o cancelamento', async () => {
      facts(
        contract({
          has_milestones: 1,
          total_milestones: 2,
          undelivered_milestones: 1,
          in_revision: 1,
        }),
      );
      milestones.titlesByDelivery.mockResolvedValue({ delivered: ['Layout'], missing: ['Código'] });

      expect(await deadlineRemindersService.delivery(candidate(), 24, NOW)).toBe(true);

      expect(persisted()).toEqual([
        [
          2,
          {
            type: 'contract_deadline_reminder',
            title: 'Entregue até sex, 02/10: Logo nova',
            body: 'Entregue o marco «Código» até lá ou peça a extensão antes. Sem as entregas, a partir de sáb, 03/10 às 09:00 o Escambo avisa vocês dois e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 02/10/2026, até 23:59.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it.each([
      ['nenhum marco entregue ainda', { total_milestones: 2, undelivered_milestones: 2 }],
      [
        'sem as contagens na linha',
        { total_milestones: undefined, undelivered_milestones: undefined },
      ],
    ] as const)(
      'por marcos, %s e nada em aberto: o cliente pode cancelar tudo (não só "o que falta")',
      async (_case, over) => {
        facts(contract({ has_milestones: 1, ...(over as Columns<ContractRow>) }));
        milestones.titlesByDelivery.mockResolvedValue({
          delivered: [],
          missing: ['Layout', 'Código'],
        });

        expect(await deadlineRemindersService.delivery(candidate(), 24, NOW)).toBe(true);

        expect(persisted()).toEqual([
          [
            2,
            {
              type: 'contract_deadline_reminder',
              title: 'Entregue até sex, 02/10: Logo nova',
              body: 'Entregue os marcos «Layout» e «Código» até lá ou peça a extensão antes. Sem as entregas, a partir de sáb, 03/10 às 09:00 o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 02/10/2026, até 23:59.',
              data: { contractId: 7 },
            },
          ],
        ]);
      },
    );

    it('por marcos, com parte já aprovada e nada em aberto: o cliente pode cancelar o que falta', async () => {
      facts(contract({ has_milestones: 1, total_milestones: 3, undelivered_milestones: 2 }));
      milestones.titlesByDelivery.mockResolvedValue({
        delivered: ['Briefing'],
        missing: ['Layout', 'Código'],
      });

      expect(await deadlineRemindersService.delivery(candidate(), 24, NOW)).toBe(true);

      expect(persisted()).toEqual([
        [
          2,
          {
            type: 'contract_deadline_reminder',
            title: 'Entregue até sex, 02/10: Logo nova',
            body: 'Entregue os marcos «Layout» e «Código» até lá ou peça a extensão antes. Sem as entregas, a partir de sáb, 03/10 às 09:00 o Escambo avisa vocês dois, o cliente pode cancelar o que falta com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 02/10/2026, até 23:59.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });
  });

  describe('aprovação da entrega, ao cliente', () => {
    it.each([
      [
        'cash',
        'Depois disso, a entrega é aprovada sozinha, o pagamento é liberado ao freelancer e não cabe mais revisão nem disputa. Valor da contratação: R$ 500,00.',
      ],
      [
        'credits',
        'Depois disso, a entrega é aprovada sozinha, os créditos são liberados ao freelancer e não cabe mais revisão nem disputa. Créditos da contratação: 450.',
      ],
      [
        'barter',
        'Depois disso, a entrega é aprovada sozinha, conta para fechar a troca e não cabe mais revisão nem disputa.',
      ],
    ])('em %s: a hora gravada da aprovação automática, no fuso do cliente', async (mode, body) => {
      facts(
        contract({
          status: 'delivered',
          payment_mode: mode,
          freelancer_net: '449.60',
          approval_due_at: new Date('2026-10-03T15:00:00.000Z'),
          client_timezone: 'America/Rio_Branco',
        }),
      );

      expect(await deadlineRemindersService.approval(candidate(), NOW)).toBe(true);

      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_approval_reminder',
            title: 'Aprove ou peça revisão até sáb, 03/10 às 10:00: Logo nova',
            body,
            data: { contractId: 7 },
          },
        ],
      ]);
    });
  });

  describe('aprovação dos marcos, ao cliente', () => {
    const due3 = new Date('2026-10-03T15:00:00.000Z');
    const list = (second: Date | null = due3): MilestoneRow[] => [
      milestone({ id: 31, title: 'Layout', amount: '300.00', approval_due_at: due3 }),
      milestone({ id: 32, title: 'Código', amount: '400.00', approval_due_at: second }),
      // Também vence, mas não estava na rodada: fica de fora do aviso.
      milestone({ id: 33, title: 'Ajustes', amount: '100.00', approval_due_at: due3 }),
    ];
    const delivered31 = new Date('2026-09-28T15:00:00.000Z');
    const rows = [
      candidate({ entity_id: 31, due_at: due3, start_at: delivered31 }),
      candidate({ entity_id: 32, due_at: due3 }),
    ];

    it('os marcos da mesma contratação viram um aviso só, com duas travas (cada uma com o início do seu marco), e devolvem os marcos lembrados', async () => {
      facts(contract({ has_milestones: 1 }));
      milestones.listForContract.mockResolvedValue(list());

      expect(await deadlineRemindersService.milestoneApprovals(7, rows, NOW)).toEqual([31, 32]);

      expect(order).toEqual([
        'begin',
        'trava',
        'claim milestone_approval 31',
        'claim milestone_approval 32',
        'fatos',
        'grava 1',
        'commit',
        'envia 1',
        'release',
      ]);
      // Uma trava na contratação; cada trava de lembrete leva a contratação E o marco.
      expect(reminders.lockContract.mock.calls).toEqual([[conn, 7]]);
      expect(
        reminders.claim.mock.calls.map(([c, kind, p]) => [
          c,
          kind,
          p.contractId,
          p.entityId,
          p.due,
          p.seq,
          p.start,
          p.now,
        ]),
      ).toEqual([
        [conn, 'milestone_approval', 7, 31, due3, 0, delivered31, NOW],
        [conn, 'milestone_approval', 7, 32, due3, 0, null, NOW],
      ]);
      expect(milestones.listForContract).toHaveBeenCalledWith(7, conn);
      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_approval_reminder',
            title: 'Aprove ou peça revisão de 2 marcos até sáb, 03/10 às 12:00: Logo nova',
            body: 'Depois disso, os marcos «Layout» e «Código» são aprovados sozinhos, o pagamento deles é liberado ao freelancer e não cabe mais pedir revisão. Valor dos marcos: R$ 700,00.',
            data: { contractId: 7 },
          },
        ],
      ]);
      expect(notifications.dispatch).toHaveBeenCalledTimes(1);
    });

    it('com horas diferentes, o aviso diz a do primeiro', async () => {
      facts(contract({ has_milestones: 1 }));
      milestones.listForContract.mockResolvedValue(list(new Date('2026-10-04T15:00:00.000Z')));

      expect(await deadlineRemindersService.milestoneApprovals(7, rows, NOW)).toEqual([31, 32]);

      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_approval_reminder',
            title: '2 marcos esperam a sua resposta, o primeiro até sáb, 03/10 às 12:00: Logo nova',
            body: 'Cada um é aprovado sozinho na hora dele (a de cada marco está na Sala): os marcos «Layout» e «Código». O pagamento é liberado ao freelancer e não cabe mais pedir revisão. Valor dos marcos: R$ 700,00.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it('só entra no aviso o marco cuja trava foi ganha (em créditos, com o marco nos dados)', async () => {
      reminders.claim.mockImplementation(async (_c, _kind, p) => p.entityId === 32);
      facts(contract({ has_milestones: 1, payment_mode: 'credits' }));
      milestones.listForContract.mockResolvedValue(list());

      expect(await deadlineRemindersService.milestoneApprovals(7, rows, NOW)).toEqual([32]);

      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_approval_reminder',
            title: 'Até sáb, 03/10 às 12:00: aprove ou peça revisão do marco «Código»',
            body: 'Depois disso, o marco é aprovado sozinho, os créditos dele são liberados ao freelancer e não cabe mais pedir revisão. Valor do marco: 400 créditos. Contratação: Logo nova.',
            data: { contractId: 7, milestoneId: 32 },
          },
        ],
      ]);
    });

    it('marco ganho que não está mais na leitura (ou sem a hora): desfaz com aviso no log', async () => {
      facts(contract({ has_milestones: 1 }));
      milestones.listForContract.mockResolvedValue([
        milestone({ id: 31, approval_due_at: null }),
        milestone({ id: 33, approval_due_at: due3 }),
      ]);

      expect(await deadlineRemindersService.milestoneApprovals(7, rows, NOW)).toEqual([]);

      expectRolledBack();
      expect(warn.mock.calls).toEqual([
        [
          { contractId: 7, kinds: ['milestone_approval', 'milestone_approval'] },
          'lembrete sem fatos que o sustentem: desfeito',
        ],
      ]);
    });
  });

  describe('pedido de extensão, ao cliente', () => {
    const pending = (over: Columns<ContractRow> = {}): ContractRow =>
      contract({
        extension_status: 'pending',
        extension_requests: 2,
        extension_deadline_at: END_09_SP,
        extension_respond_by: new Date('2026-10-02T12:00:00.000Z'),
        ...over,
      });

    it('o novo prazo e o atual como dia; a trava leva o número do pedido (que o banco pode trazer como texto)', async () => {
      facts(pending());
      const c = candidate({
        due_at: '2026-10-02T12:00:00.000Z' as never,
        seq: '2' as never,
      });

      expect(await deadlineRemindersService.extension(c, NOW)).toBe(true);

      expect(reminders.claim).toHaveBeenCalledWith(
        conn,
        'extension',
        expect.objectContaining({
          contractId: 7,
          entityId: 7,
          due: new Date('2026-10-02T12:00:00.000Z'),
          seq: 2,
          start: null,
          now: NOW,
        }),
      );
      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_extension_reminder',
            title: 'Responda ao pedido de extensão até sex, 02/10 às 09:00: Logo nova',
            body: 'Aceite o novo prazo, sex, 09/10/2026, até 23:59, ou recuse. Sem resposta, o pedido expira e vale o prazo atual, sex, 02/10/2026, até 23:59.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it('com o prazo atual vencido e o cliente em Manaus: a disputa espera, e o dia vem com o fuso', async () => {
      facts(
        pending({
          deadline_at: END_30_SP,
          extension_respond_by: new Date('2026-10-02T13:00:00.000Z'),
          client_timezone: 'America/Manaus',
        }),
      );

      expect(await deadlineRemindersService.extension(candidate(), NOW)).toBe(true);

      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_extension_reminder',
            title: 'Responda ao pedido de extensão até sex, 02/10 às 09:00: Logo nova',
            body: 'Aceite o novo prazo, sex, 09/10/2026, até 23:59 (horário de Brasília), ou recuse. Sem resposta, o pedido expira e vale o prazo atual, que já venceu. Enquanto você decide, a disputa automática espera.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it('cliente em outro relógio, com o prazo atual ainda correndo: os dois dias vêm com o fuso deles', async () => {
      facts(
        pending({
          extension_respond_by: new Date('2026-10-02T13:00:00.000Z'),
          client_timezone: 'America/Manaus',
        }),
      );

      expect(await deadlineRemindersService.extension(candidate(), NOW)).toBe(true);

      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_extension_reminder',
            title: 'Responda ao pedido de extensão até sex, 02/10 às 09:00: Logo nova',
            body: 'Aceite o novo prazo, sex, 09/10/2026, até 23:59 (horário de Brasília), ou recuse. Sem resposta, o pedido expira e vale o prazo atual, sex, 02/10/2026, até 23:59 (horário de Brasília).',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it('o novo prazo é dito no fuso em que ele é um dia, que pode não ser o do prazo atual', async () => {
      // Quem entrega mudou para Manaus e pediu até o fim de 09/10 lá; o prazo atual é de Brasília.
      facts(
        pending({
          extension_deadline_at: new Date('2026-10-10T03:59:59.000Z'),
          freelancer_timezone: 'America/Manaus',
        }),
      );

      expect(await deadlineRemindersService.extension(candidate(), NOW)).toBe(true);

      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_extension_reminder',
            title: 'Responda ao pedido de extensão até sex, 02/10 às 09:00: Logo nova',
            body: 'Aceite o novo prazo, sex, 09/10/2026, até 23:59 (horário de Manaus), ou recuse. Sem resposta, o pedido expira e vale o prazo atual, sex, 02/10/2026, até 23:59.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it('no instante exato do prazo atual, ele já conta como vencido (a mesma conta da Sala)', async () => {
      facts(pending());

      expect(await deadlineRemindersService.extension(candidate(), END_02_SP)).toBe(true);

      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_extension_reminder',
            title: 'Responda ao pedido de extensão até sex, 02/10 às 09:00: Logo nova',
            body: 'Aceite o novo prazo, sex, 09/10/2026, até 23:59, ou recuse. Sem resposta, o pedido expira e vale o prazo atual, que já venceu. Enquanto você decide, a disputa automática espera.',
            data: { contractId: 7 },
          },
        ],
      ]);
    });

    it.each([
      ['sem a data pedida', { extension_deadline_at: null }],
      ['sem a hora de resposta', { extension_respond_by: null }],
      ['sem prazo atual', { deadline_at: null }],
    ] as const)('%s não há o que lembrar: desfaz', async (_case, over) => {
      facts(pending(over as Columns<ContractRow>));

      expect(await deadlineRemindersService.extension(candidate(), NOW)).toBe(false);

      expectRolledBack();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('revisão parada, às duas partes', () => {
    it('entrega única: um aviso a cada parte, com a data do pedido no fuso de cada uma e "há N dias"', async () => {
      facts(
        contract({
          status: 'revision_requested',
          revision_requested_at: new Date('2026-09-23T14:00:00.000Z'),
          freelancer_timezone: 'America/Rio_Branco',
        }),
      );
      const c = candidate({ due_at: new Date('2026-09-23T14:00:00.000Z') });

      expect(await deadlineRemindersService.revisionStalled(c, NOW)).toBe(true);

      expect(order).toEqual([
        'begin',
        'trava',
        'claim revision 7',
        'fatos',
        'grava 1',
        'grava 2',
        'commit',
        'envia 1',
        'envia 2',
        'release',
      ]);
      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_revision_stalled',
            title: 'Revisão sem nova entrega há 8 dias: Logo nova',
            body: 'Você pediu revisão em qua, 23/09 às 11:00 e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala, e a mediação do Escambo decide sobre o valor.',
            data: { contractId: 7 },
          },
        ],
        [
          2,
          {
            type: 'contract_revision_stalled',
            title: 'Revisão esperando você há 8 dias: Logo nova',
            body: 'O cliente pediu revisão em qua, 23/09 às 09:00. Registre a nova entrega ou combine pelo chat. Nada muda sozinho, mas qualquer um de vocês pode abrir uma disputa pela Sala.',
            data: { contractId: 7 },
          },
        ],
      ]);
      for (const call of notifications.persist.mock.calls) expect(call[2]).toBe(conn);
      expect(notifications.dispatch.mock.calls.map(([, opts]) => opts)).toEqual([
        { ownTag: true },
        { ownTag: true },
      ]);
    });

    it.each([
      [
        'barter',
        'Você pediu revisão em qua, 23/09 às 11:00 e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.',
      ],
      [
        'credits',
        'Você pediu revisão em qua, 23/09 às 11:00 e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala, e a mediação do Escambo decide sobre o valor.',
      ],
      [
        'cash',
        'Você pediu revisão em qua, 23/09 às 11:00 e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala, e a mediação do Escambo decide sobre o valor.',
      ],
    ])(
      'entrega única em %s: só na troca o cliente não lê que a mediação decide sobre o valor',
      async (mode, body) => {
        facts(
          contract({
            status: 'revision_requested',
            payment_mode: mode,
            revision_requested_at: new Date('2026-09-23T14:00:00.000Z'),
          }),
        );

        expect(await deadlineRemindersService.revisionStalled(candidate(), NOW)).toBe(true);

        expect(persisted()).toEqual([
          [
            1,
            {
              type: 'contract_revision_stalled',
              title: 'Revisão sem nova entrega há 8 dias: Logo nova',
              body,
              data: { contractId: 7 },
            },
          ],
          [
            2,
            {
              type: 'contract_revision_stalled',
              title: 'Revisão esperando você há 8 dias: Logo nova',
              body: 'O cliente pediu revisão em qua, 23/09 às 11:00. Registre a nova entrega ou combine pelo chat. Nada muda sozinho, mas qualquer um de vocês pode abrir uma disputa pela Sala.',
              data: { contractId: 7 },
            },
          ],
        ]);
      },
    );

    it('a trava da revisão parada não tem início: passa start null', async () => {
      facts(
        contract({
          status: 'revision_requested',
          revision_requested_at: new Date('2026-09-23T14:00:00.000Z'),
        }),
      );

      expect(await deadlineRemindersService.revisionStalled(candidate(), NOW)).toBe(true);

      expect(reminders.claim).toHaveBeenCalledWith(
        conn,
        'revision',
        expect.objectContaining({ contractId: 7, entityId: 7, seq: 0, start: null, now: NOW }),
      );
    });

    it('"há N dias" conta só os dias inteiros: 7 dias e 20 horas ainda são 7', async () => {
      facts(
        contract({
          status: 'revision_requested',
          revision_requested_at: new Date('2026-09-23T19:00:00.000Z'),
        }),
      );

      expect(await deadlineRemindersService.revisionStalled(candidate(), NOW)).toBe(true);

      expect(persisted().map(([u, input]) => [u, (input as { title: string }).title])).toEqual([
        [1, 'Revisão sem nova entrega há 7 dias: Logo nova'],
        [2, 'Revisão esperando você há 7 dias: Logo nova'],
      ]);
    });

    it('sem a hora do pedido na contratação: desfaz', async () => {
      facts(contract({ status: 'revision_requested', revision_requested_at: null }));

      expect(await deadlineRemindersService.revisionStalled(candidate(), NOW)).toBe(false);

      expectRolledBack();
    });

    it('marco: o título começa pela revisão e "há 7 dias", termina no marco, e o marco vai nos dados das duas cópias', async () => {
      facts(contract({ has_milestones: 1 }));
      milestones.listForContract.mockResolvedValue([
        milestone({ id: 30, title: 'Briefing', status: 'released' }),
        milestone({
          id: 31,
          title: 'Layout',
          status: 'funded',
          revision_requested_at: new Date('2026-09-24T15:00:00.000Z'),
        }),
      ]);
      const c = candidate({ entity_id: 31, due_at: new Date('2026-09-24T15:00:00.000Z') });

      expect(await deadlineRemindersService.milestoneRevisionStalled(c, NOW)).toBe(true);

      expect(reminders.claim).toHaveBeenCalledWith(
        conn,
        'milestone_revision',
        expect.objectContaining({
          contractId: 7,
          entityId: 31,
          due: new Date('2026-09-24T15:00:00.000Z'),
          seq: 0,
          start: null,
          now: NOW,
        }),
      );
      expect(milestones.listForContract).toHaveBeenCalledWith(7, conn);
      expect(persisted()).toEqual([
        [
          1,
          {
            type: 'contract_revision_stalled',
            title: 'Revisão sem nova entrega há 7 dias, marco «Layout»',
            body: 'Logo nova: você pediu revisão em qui, 24/09 às 12:00 e o marco ainda não foi entregue de novo. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.',
            data: { contractId: 7, milestoneId: 31 },
          },
        ],
        [
          2,
          {
            type: 'contract_revision_stalled',
            title: 'Revisão esperando você há 7 dias, marco «Layout»',
            body: 'Logo nova: o cliente pediu revisão em qui, 24/09 às 12:00. Entregue o marco de novo ou combine pelo chat; qualquer um de vocês pode abrir uma disputa pela Sala.',
            data: { contractId: 7, milestoneId: 31 },
          },
        ],
      ]);
    });

    it.each([
      ['o marco não está mais na contratação', 99],
      ['o marco não tem a hora do pedido', 30],
    ])('%s: desfaz', async (_case, entityId) => {
      facts(contract({ has_milestones: 1 }));
      milestones.listForContract.mockResolvedValue([
        milestone({ id: 30, title: 'Briefing', status: 'funded', revision_requested_at: null }),
      ]);

      expect(
        await deadlineRemindersService.milestoneRevisionStalled(
          candidate({ entity_id: entityId }),
          NOW,
        ),
      ).toBe(false);

      expectRolledBack();
    });
  });
});
