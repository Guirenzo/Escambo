import type { PoolConnection } from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { setClockForTests } from '../../utils/clock';
import { contractsRepository, OVERDUE_DISPUTE_GUARD } from './contracts.repository';
import { rn029Eligible, zoneOf } from './deadline-sql';

const { applyWalletEffect, recoverDeliveryRules, lockWalletUsers, lockWalletRows } = vi.hoisted(
  () => ({
    applyWalletEffect: vi.fn(),
    recoverDeliveryRules: vi.fn(),
    lockWalletUsers: vi.fn(),
    lockWalletRows: vi.fn(),
  }),
);
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
// A carteira em R$ tem o próprio teste (wallet.ledger): aqui importa o que o repository pede a ela.
vi.mock('../wallet/wallet.ledger', () => ({ applyWalletEffect }));
vi.mock('../wallet/wallet.locks', () => ({ lockWalletUsers, lockWalletRows }));
// A recuperação histórica tem provas com SQL real em delivery-snapshots.test.ts e nas INT.
vi.mock('./delivery-snapshots', () => ({ recoverDeliveryRules }));

/** Como o fakeDb guarda as instruções: espaços e quebras de linha reduzidos a um espaço. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/** A RN-029 alcança a contratação: prazo correndo e trabalho nunca entregue (deadline-sql.ts). */
const ELIGIBLE = flat(rn029Eligible('c'));
/** Encerra o pedido de extensão pendente; a hora vem ANTES do status, que a segunda atribuição muda. */
const CLOSE_EXTENSION =
  "c.extension_resolved_at = IF(c.extension_status = 'pending', :now, c.extension_resolved_at), " +
  "c.extension_status = IF(c.extension_status = 'pending', 'closed', c.extension_status)";
/** Pedidos de extensão já feitos, contando o pedido de uma linha de antes do ADR 57. */
const REQUESTS_USED =
  "GREATEST(c.extension_requests, c.extension_status IN ('pending', 'accepted', 'declined'))";

/** A consulta principal de uma leitura, sem as colunas calculadas (que têm os próprios FROM). */
const mainQuery = (sql: string): string => sql.slice(sql.lastIndexOf('FROM contracts c'));
/** As colunas de uma leitura: tudo o que vem antes da consulta principal. */
const columns = (sql: string): string => sql.slice(0, sql.lastIndexOf('FROM contracts c'));

const NOW = new Date('2026-10-06T15:00:00.000Z');

function expectCommitted(): void {
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
}

function expectRolledBack(): void {
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
}

/**
 * Repository das contratações sem banco: o que cada método pede (tabela, guardas do WHERE, ordem,
 * parâmetros), o que faz com a resposta e como trata a transação. Se o SQL roda no MySQL, e se as
 * guardas pegam a corrida de verdade, é da integração (contracts-*.int.test.ts).
 */
describe('contractsRepository', () => {
  beforeEach(() => {
    fakeDb.reset();
    lockWalletUsers.mockReset();
    lockWalletRows.mockReset();
    applyWalletEffect.mockReset();
    applyWalletEffect.mockResolvedValue(true);
    recoverDeliveryRules
      .mockReset()
      .mockResolvedValue({ firstDeliveryAt: null, deliveryDisputeOpensAt: null, milestones: [] });
    setClockForTests(NOW, { frozen: true });
  });
  afterEach(() => setClockForTests(null));

  describe('create', () => {
    const data = {
      ulid: '01PROPOSTA0000000000000000',
      clientId: 7,
      freelancerId: 44,
      serviceId: null,
      title: 'Landing page',
      description: 'Página de vendas responsiva',
      price: 500,
      platformFee: 75,
      freelancerNet: 425,
      paymentMode: 'cash' as const,
      deadlineAt: '2026-10-20T02:59:59.000Z',
      proposalExpiresAt: new Date('2026-10-09T15:00:00.000Z'),
      // O relógio do fluxo, não o do banco: o lembrete da proposta conta a idade daqui (ADR 58).
      createdAt: NOW,
    };
    const milestones = [
      {
        title: 'Layout',
        description: null,
        amount: 200,
        freelancerNet: 170,
        sortOrder: 0,
        dueAt: '2026-10-12T02:59:59.000Z',
      },
      {
        title: 'Publicação',
        description: 'No ar',
        amount: 300,
        freelancerNet: 255,
        sortOrder: 1,
        dueAt: null,
      },
    ];

    it('grava a proposta, o início da linha do tempo, a reserva do cliente e os marcos numa transação só', async () => {
      fakeDb.reply(
        [],
        { insertId: 31, affectedRows: 1 },
        { affectedRows: 1 },
        { affectedRows: 1 },
        { affectedRows: 1 },
        [
          {
            id: 81,
            title: 'Layout',
            amount: '200.00',
            freelancer_net: '170.00',
            due_at: new Date('2026-10-12T02:59:59.000Z'),
          },
          { id: 82, title: 'Publicação', amount: '300.00', freelancer_net: '255.00', due_at: null },
        ],
        { affectedRows: 1 },
      );

      const id = await contractsRepository.create({
        ...data,
        hold: { userId: 7, amount: 500 },
        milestones,
      });

      expect(id).toBe(31);
      expect(lockWalletUsers).toHaveBeenCalledWith(fakeDb.conn, [7, 44], [7]);
      expect(lockWalletRows).toHaveBeenCalledWith(fakeDb.conn, [7]);
      expect(lockWalletUsers.mock.invocationCallOrder[0]).toBeLessThan(
        fakeDb.conn.query.mock.invocationCallOrder[0]!,
      );
      expect(lockWalletRows.mock.invocationCallOrder[0]).toBeLessThan(
        applyWalletEffect.mock.invocationCallOrder[0]!,
      );
      expect(fakeDb.sqls().map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
        'SELECT id FROM',
        'INSERT INTO contracts',
        'INSERT INTO contract_status_history',
        'INSERT INTO contract_milestones',
        'INSERT INTO contract_milestones',
        'SELECT id, contract_id,',
        'INSERT INTO contract_offers',
      ]);
      // O prazo chega em ISO e é gravado como Date; a reserva e os marcos não são colunas.
      expect(fakeDb.calls[1]!.sql).toContain(
        '(ulid, client_id, freelancer_id, service_id, title, description, price, platform_fee, freelancer_net, fee_percentage, revision_limit, payment_mode, deadline_at, proposal_expires_at, created_at)',
      );
      expect(fakeDb.calls[1]!.sql).toContain(':deadlineAt, :proposalExpiresAt, :createdAt)');
      expect(fakeDb.calls[1]!.params).toEqual({
        ...data,
        feePercentage: 15,
        revisionLimit: 2,
        deadlineAt: new Date('2026-10-20T02:59:59.000Z'),
      });
      // RN-022: a linha do tempo começa em NULL -> pending, em nome do cliente.
      expect(fakeDb.calls[2]!.sql).toContain(
        "VALUES (:id, :changedBy, NULL, 'pending', 'Proposta enviada')",
      );
      expect(fakeDb.calls[2]!.params).toEqual({ id: 31, changedBy: 7 });
      // O valor sai do saldo disponível e fica reservado, ligado à contratação criada.
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 7,
        balanceDelta: -500,
        pendingDelta: 500,
        reason: 'hold',
        contractId: 31,
      });
      expect(fakeDb.calls[3]!.params).toEqual({
        contractId: 31,
        title: 'Layout',
        description: null,
        amount: 200,
        freelancerNet: 170,
        sortOrder: 0,
        dueAt: new Date('2026-10-12T02:59:59.000Z'),
        revisionLimit: 2,
      });
      expect(fakeDb.calls[4]!.params).toMatchObject({ contractId: 31, sortOrder: 1, dueAt: null });
      expect(fakeDb.calls[5]!.params).toEqual({ contractId: 31 });
      expect(fakeDb.calls[6]!.params).toEqual({
        contractId: 31,
        seq: 1,
        madeBy: 'client',
        price: 500,
        fee: 75,
        net: 425,
        deadlineAt: new Date('2026-10-20T02:59:59.000Z'),
        respondBy: new Date('2026-10-09T15:00:00.000Z'),
        now: NOW,
        milestones: JSON.stringify([
          {
            id: 81,
            title: 'Layout',
            amount: 200,
            freelancerNet: 170,
            dueAt: '2026-10-12T02:59:59.000Z',
          },
          { id: 82, title: 'Publicação', amount: 300, freelancerNet: 255, dueAt: null },
        ]),
        message: null,
      });
      expectCommitted();
    });

    it.each(['cash', 'credits'] as const)(
      'RN-020 recusa outra proposta em %s antes de qualquer gravação ou movimento de carteira',
      async (paymentMode) => {
        fakeDb.reply([{ id: 18 }]);

        await expect(
          contractsRepository.create({
            ...data,
            paymentMode,
            hold: paymentMode === 'cash' ? { userId: 7, amount: 500 } : null,
            milestones,
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          code: 'active_contract_exists',
          publicData: { contractId: 18 },
        });

        expect(lockWalletUsers).toHaveBeenCalledWith(fakeDb.conn, [7, 44], [7]);
        expect(lockWalletUsers.mock.invocationCallOrder[0]).toBeLessThan(
          fakeDb.conn.query.mock.invocationCallOrder[0]!,
        );
        expect(fakeDb.calls).toEqual([
          {
            sql: flat(`SELECT id FROM contracts
              WHERE client_id = :clientId AND freelancer_id = :freelancerId
                AND barter_agreement_id IS NULL AND payment_mode IN ('cash', 'credits')
                AND status IN ('pending', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')
              ORDER BY id LIMIT 1`),
            params: { clientId: 7, freelancerId: 44 },
          },
        ]);
        expect(lockWalletRows).not.toHaveBeenCalled();
        expect(applyWalletEffect).not.toHaveBeenCalled();
        expectRolledBack();
      },
    );

    it('não consulta contratos nem grava se não consegue adquirir a guarda da conta', async () => {
      const boom = new Error('lock wait timeout');
      lockWalletUsers.mockRejectedValue(boom);

      await expect(contractsRepository.create(data)).rejects.toBe(boom);

      expect(fakeDb.calls).toEqual([]);
      expect(lockWalletRows).not.toHaveBeenCalled();
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('sem saldo para reservar, nada é criado: desfaz e devolve null', async () => {
      fakeDb.reply([], { insertId: 31, affectedRows: 1 }, { affectedRows: 1 });
      applyWalletEffect.mockResolvedValue(false);

      const id = await contractsRepository.create({
        ...data,
        hold: { userId: 7, amount: 500 },
        milestones,
      });

      expect(id).toBeNull();
      // Os marcos nem chegam a ser gravados.
      expect(fakeDb.calls).toHaveLength(3);
      expectRolledBack();
    });

    it('em créditos não há reserva, e proposta sem prazo grava o prazo como null', async () => {
      fakeDb.reply([], { insertId: 32, affectedRows: 1 }, { affectedRows: 1 });

      const id = await contractsRepository.create({
        ...data,
        paymentMode: 'credits',
        platformFee: 0,
        freelancerNet: 500,
        feePercentage: 0,
        deadlineAt: null,
        hold: null,
        milestones: [],
      });

      expect(id).toBe(32);
      expect(fakeDb.calls[1]!.params).toMatchObject({ paymentMode: 'credits', deadlineAt: null });
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expect(fakeDb.calls).toHaveLength(4);
      expect(fakeDb.calls[3]!.params).toEqual({
        contractId: 32,
        seq: 1,
        madeBy: 'client',
        price: 500,
        fee: 0,
        net: 500,
        deadlineAt: null,
        respondBy: new Date('2026-10-09T15:00:00.000Z'),
        now: NOW,
        milestones: null,
        message: null,
      });
      expectCommitted();
    });

    it('se a gravação falha no meio, desfaz tudo, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([], { insertId: 31, affectedRows: 1 }, boom);

      await expect(contractsRepository.create(data)).rejects.toBe(boom);

      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });
  });

  describe('leituras', () => {
    it('findById devolve a primeira linha, ou undefined', async () => {
      const row = { id: 12, status: 'accepted' };
      fakeDb.reply([row], []);

      expect(await contractsRepository.findById(12)).toBe(row);
      expect(await contractsRepository.findById(13)).toBeUndefined();

      expect(mainQuery(fakeDb.calls[0]!.sql)).toBe('FROM contracts c WHERE c.id = :id LIMIT 1');
      expect(fakeDb.calls[0]!.params).toEqual({ id: 12 });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 13 });
    });

    it('findById com a conexão de quem chama lê dentro daquela transação, não pelo pool (ADR 58)', async () => {
      const row = { id: 12, status: 'delivered' };
      const own = { query: vi.fn(async () => [[row], []]) };

      expect(await contractsRepository.findById(12, own as unknown as PoolConnection)).toBe(row);

      expect(fakeDb.calls).toHaveLength(0);
      expect(own.query).toHaveBeenCalledTimes(1);
      const [sql, params] = own.query.mock.calls[0] as unknown as [string, unknown];
      expect(mainQuery(flat(sql))).toBe('FROM contracts c WHERE c.id = :id LIMIT 1');
      expect(params).toEqual({ id: 12 });
    });

    it('toda leitura traz o que o prazo e o cancelamento precisam: marcos por situação, entregas e os fusos das partes (ADR 57)', async () => {
      await contractsRepository.findById(12);
      const { sql } = fakeDb.calls[0]!;

      expect(sql).toContain(
        'EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id = c.id) AS has_review',
      );
      expect(sql).toContain(
        'EXISTS(SELECT 1 FROM contract_milestones m WHERE m.contract_id = c.id) AS has_milestones',
      );
      expect(sql).toContain(
        '(SELECT COUNT(*) FROM contract_milestones mt WHERE mt.contract_id = c.id) AS total_milestones',
      );
      // Nunca entregue: financiado e sem data de entrega.
      expect(sql).toContain(
        "mu.contract_id = c.id AND mu.status = 'funded' AND mu.delivered_at IS NULL) AS undelivered_milestones",
      );
      // Esperando o cliente: entregue.
      expect(sql).toContain(
        "ma.contract_id = c.id AND ma.status = 'delivered') AS delivered_awaiting",
      );
      // Em revisão: voltou a financiado, mas guarda a data da entrega.
      expect(sql).toContain(
        "mr.contract_id = c.id AND mr.status = 'funded' AND mr.delivered_at IS NOT NULL) AS in_revision",
      );
      expect(sql).toContain(
        '(SELECT COUNT(*) FROM deliveries dc WHERE dc.contract_id = c.id) AS deliveries_count',
      );
      // A primeira entrega prevalece e o DATETIME explícito preserva UTC no driver mysql2.
      expect(sql).toContain(
        "CAST(COALESCE(c.first_delivery_at, NULLIF(LEAST( COALESCE((SELECT MIN(dd.created_at) FROM deliveries dd WHERE dd.contract_id = c.id), CAST('9999-12-31 23:59:59' AS DATETIME)), COALESCE((SELECT MIN(md.delivered_at) FROM contract_milestones md WHERE md.contract_id = c.id), CAST('9999-12-31 23:59:59' AS DATETIME)), COALESCE((SELECT MIN(hd.created_at) FROM contract_status_history hd WHERE hd.contract_id = c.id AND (hd.new_status = 'delivered' OR hd.note LIKE 'Marco «%» entregue:%')), CAST('9999-12-31 23:59:59' AS DATETIME)) ), CAST('9999-12-31 23:59:59' AS DATETIME))) AS DATETIME) AS first_delivered_at",
      );
      expect(sql).toContain("mt.status = 'delivered') AS next_milestone_approval_at");
      expect(sql).toContain(
        "ms.status = 'delivered' OR (ms.status = 'funded' AND ms.delivered_at IS NOT NULL))) AS next_milestone_dispute_opens_at",
      );
      expect(sql).toContain(
        '(SELECT uf.timezone FROM users uf WHERE uf.id = c.freelancer_id) AS freelancer_timezone',
      );
      expect(sql).toContain(
        '(SELECT uc.timezone FROM users uc WHERE uc.id = c.client_id) AS client_timezone',
      );
    });

    it('a lista é de quem participa (cliente ou freelancer), da mais nova para a mais antiga, paginada', async () => {
      const rows = [{ id: 2 }, { id: 1 }];
      fakeDb.reply(rows);

      expect(await contractsRepository.listForUser(7, 20, 40)).toBe(rows);

      // O id desempata as criadas no mesmo segundo: "carregar mais" não repete nem pula nenhuma.
      expect(mainQuery(fakeDb.calls[0]!.sql)).toBe(
        'FROM contracts c WHERE (c.client_id = :userId OR c.freelancer_id = :userId) ORDER BY c.created_at DESC, c.id DESC LIMIT 20 OFFSET 40',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
      // A lista traz as mesmas colunas calculadas do detalhe (o prazo de cada cartão sai delas).
      await contractsRepository.findById(12);
      expect(columns(fakeDb.calls[0]!.sql)).toBe(columns(fakeDb.calls[1]!.sql));
      expect(columns(fakeDb.calls[0]!.sql)).toContain('AS client_timezone');
    });

    it('com filtro de status, a lista só traz esses status, ainda só de quem participa (RF-040)', async () => {
      await contractsRepository.listForUser(7, 10, 0, ['accepted', 'in_progress']);
      // Lista vazia é o mesmo que sem filtro (IN () seria SQL inválido).
      await contractsRepository.listForUser(7, 10, 0, []);

      expect(mainQuery(fakeDb.calls[0]!.sql)).toBe(
        'FROM contracts c WHERE (c.client_id = :userId OR c.freelancer_id = :userId) AND c.status IN (:statuses) ORDER BY c.created_at DESC, c.id DESC LIMIT 10 OFFSET 0',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, statuses: ['accepted', 'in_progress'] });
      expect(mainQuery(fakeDb.calls[1]!.sql)).not.toContain('c.status IN');
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 7 });
    });

    it('o total conta todas as contratações de quem participa, com o mesmo filtro da lista', async () => {
      fakeDb.reply([{ total: 23 }], [{ total: '4' }], []);

      expect(await contractsRepository.countForUser(7)).toBe(23);
      expect(await contractsRepository.countForUser(7, ['completed'])).toBe(4);
      // Sem linha (não acontece com COUNT, mas o tipo permite): zero.
      expect(await contractsRepository.countForUser(7)).toBe(0);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT COUNT(*) AS total FROM contracts c WHERE (c.client_id = :userId OR c.freelancer_id = :userId)',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
      expect(fakeDb.calls[1]!.sql).toBe(
        'SELECT COUNT(*) AS total FROM contracts c WHERE (c.client_id = :userId OR c.freelancer_id = :userId) AND c.status IN (:statuses)',
      );
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 7, statuses: ['completed'] });
    });

    it('as entregas únicas vêm da primeira à reentrega mais recente (RF-035)', async () => {
      const rows = [{ id: 1, message: 'Primeira versão' }];
      fakeDb.reply(rows);

      expect(await contractsRepository.listDeliveries(12)).toBe(rows);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT id, message, files, delivered_at FROM deliveries WHERE contract_id = :contractId ORDER BY delivered_at ASC, id ASC',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ contractId: 12 });
    });

    it('a linha do tempo vem na ordem em que foi gravada (RN-022)', async () => {
      const rows = [{ old_status: null, new_status: 'pending' }];
      fakeDb.reply(rows);

      expect(await contractsRepository.listHistory(12)).toBe(rows);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT old_status, new_status, note, created_at FROM contract_status_history WHERE contract_id = :contractId ORDER BY id ASC',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ contractId: 12 });
    });
  });

  describe('leituras dos jobs de prazo (ADR 57)', () => {
    type JobFinder =
      | 'findApprovalDue'
      | 'findProposalsDue'
      | 'findOverdueUnnoticed'
      | 'findGraceEnded'
      | 'findExtensionsToExpire';

    const jobs: {
      finder: JobFinder;
      rule: string;
      /** De quem é o fuso que precisa estar de dia. */
      join: string;
      zoneColumn: string;
      where: string[];
      order: string;
    }[] = [
      {
        finder: 'findApprovalDue',
        rule: 'RN-024: entregas com a aprovação tácita vencida, com o cliente num fuso em que é dia',
        join: 'JOIN users cu ON cu.id = c.client_id',
        zoneColumn: 'cu.timezone',
        where: [
          "WHERE c.status = 'delivered'",
          'AND c.approval_due_at IS NOT NULL AND c.approval_due_at <= :now',
        ],
        order: 'ORDER BY c.approval_due_at ASC, c.id ASC LIMIT 200',
      },
      {
        finder: 'findProposalsDue',
        rule: 'RN-021/RN-030: propostas vencidas, com quem tem a vez num fuso em que é dia; troca não expira',
        join: 'JOIN users fu ON fu.id = c.freelancer_id JOIN users cu ON cu.id = c.client_id',
        zoneColumn: 'IF(MOD(c.offer_seq, 2) = 0, cu.timezone, fu.timezone)',
        where: [
          "WHERE c.status = 'pending'",
          'AND c.barter_agreement_id IS NULL',
          'AND c.proposal_expires_at IS NOT NULL AND c.proposal_expires_at <= :now',
        ],
        order: 'ORDER BY c.proposal_expires_at ASC, c.id ASC LIMIT 200',
      },
      {
        finder: 'findOverdueUnnoticed',
        rule: 'RN-029, fase 1: prazo vencido sem nenhuma entrega, ninguém avisado e sem pedido pendente',
        join: 'JOIN users fu ON fu.id = c.freelancer_id',
        zoneColumn: 'fu.timezone',
        where: [
          `WHERE ${ELIGIBLE}`,
          'AND c.deadline_at < :now',
          'AND c.overdue_notified_at IS NULL',
          "AND c.extension_status <> 'pending'",
        ],
        order: 'ORDER BY c.deadline_at ASC, c.id ASC LIMIT 200',
      },
      {
        finder: 'findGraceEnded',
        rule: 'RN-029, fase 2: carência gravada vencida, com a mesma guarda da abertura da disputa',
        join: 'JOIN users fu ON fu.id = c.freelancer_id',
        zoneColumn: 'fu.timezone',
        where: [`WHERE c.status IN ('accepted', 'in_progress') ${flat(OVERDUE_DISPUTE_GUARD)}`],
        order: 'ORDER BY c.grace_ends_at ASC, c.id ASC LIMIT 200',
      },
      {
        finder: 'findExtensionsToExpire',
        rule: 'RN-028: pedidos de extensão sem resposta até a hora dita, com o cliente num fuso em que é dia',
        join: 'JOIN users cu ON cu.id = c.client_id',
        zoneColumn: 'cu.timezone',
        where: [
          "WHERE c.extension_status = 'pending'",
          'AND c.extension_respond_by IS NOT NULL AND c.extension_respond_by <= :now',
        ],
        order: 'ORDER BY c.extension_respond_by ASC, c.id ASC LIMIT 200',
      },
    ];

    it.each(jobs)('$finder — $rule', async ({ finder, join, zoneColumn, where, order }) => {
      const rows = [{ id: 12 }];
      const zones = ['America/Sao_Paulo' as const, 'America/Manaus' as const];
      fakeDb.reply(rows);

      expect(await contractsRepository[finder](NOW, zones)).toBe(rows);

      const query = mainQuery(fakeDb.calls[0]!.sql);
      // A linha vem inteira, com as colunas calculadas: o job decide o aviso a partir delas.
      const cols = columns(fakeDb.calls[0]!.sql);
      expect(cols.startsWith('SELECT c.*, EXISTS(SELECT 1 FROM reviews r')).toBe(true);
      expect(cols).toContain('AS undelivered_milestones');
      expect(cols).toContain('AS deliveries_count');
      expect(cols).toContain('AS freelancer_timezone');
      expect(cols).toContain('AS client_timezone');
      expect(query).toContain(`FROM contracts c ${join} WHERE`);
      for (const predicate of where) expect(query).toContain(predicate);
      // Só entra quem está num fuso em que é dia; fuso vazio ou fora da lista vale como Brasília.
      expect(query).toContain(`AND ${zoneOf(zoneColumn)} IN (:zones) ORDER BY`);
      // Os mais antigos primeiro, em lotes de 200.
      expect(query.endsWith(order)).toBe(true);
      expect(fakeDb.calls[0]!.params).toEqual({ now: NOW, zones });
    });

    it.each(jobs)('$finder — sem nenhum fuso em que é dia, nem consulta o banco', async (job) => {
      expect(await contractsRepository[job.finder](NOW, [])).toEqual([]);
      expect(fakeDb.calls).toHaveLength(0);
    });

    it('o fuso que não está na lista do Brasil vale como Brasília', () => {
      expect(zoneOf('fu.timezone')).toBe(
        "(CASE WHEN fu.timezone IN ('America/Noronha', 'America/Sao_Paulo', 'America/Cuiaba', 'America/Manaus', 'America/Rio_Branco') THEN fu.timezone ELSE 'America/Sao_Paulo' END)",
      );
    });
  });

  describe('guardas do prazo (RN-029, ADR 57)', () => {
    it('a RN-029 só alcança prazo correndo e trabalho nunca entregue (por marcos, algum financiado sem entrega)', () => {
      expect(ELIGIBLE).toContain("c.status IN ('accepted', 'in_progress')");
      expect(ELIGIBLE).toContain('AND c.deadline_at IS NOT NULL');
      expect(ELIGIBLE).toContain(
        "WHERE m1.contract_id = c.id AND m1.status = 'funded' AND m1.delivered_at IS NULL)",
      );
      expect(ELIGIBLE).toContain(
        'ELSE NOT EXISTS (SELECT 1 FROM deliveries d0 WHERE d0.contract_id = c.id)',
      );
    });

    it('a disputa automática repete na gravação o que o job leu: elegível, avisada, carência vencida e sem pedido pendente', () => {
      const guard = flat(OVERDUE_DISPUTE_GUARD);
      expect(guard.startsWith(`AND ${ELIGIBLE}`)).toBe(true);
      expect(guard).toContain('AND c.overdue_notified_at IS NOT NULL');
      expect(guard).toContain('AND c.grace_ends_at IS NOT NULL AND c.grace_ends_at <= :now');
      expect(guard.endsWith("AND c.extension_status <> 'pending'")).toBe(true);
    });

    describe('markOverdueNotified', () => {
      const p = {
        id: 12,
        deadlineAt: new Date('2026-10-06T02:59:59.000Z'),
        now: NOW,
        graceEndsAt: new Date('2026-10-07T15:00:00.000Z'),
      };

      it('marca o aviso e o fim da carência só se ninguém avisou e a contratação continua como o job leu', async () => {
        fakeDb.reply({ affectedRows: 1 });

        expect(await contractsRepository.markOverdueNotified(p)).toBe(true);

        const { sql, params } = fakeDb.calls[0]!;
        expect(sql).toContain(
          'UPDATE contracts c SET c.overdue_notified_at = :now, c.grace_ends_at = :graceEndsAt WHERE c.id = :id',
        );
        // Outra instância do job já avisou.
        expect(sql).toContain('AND c.overdue_notified_at IS NULL');
        // Uma extensão aceita no meio muda o prazo.
        expect(sql).toContain('AND c.deadline_at = :deadlineAt');
        expect(sql).toContain("AND c.extension_status <> 'pending'");
        expect(sql.endsWith(`AND ${ELIGIBLE}`)).toBe(true);
        expect(params).toEqual(p);
      });

      it('devolve false quando a contratação mudou entre a leitura e a gravação', async () => {
        fakeDb.reply({ affectedRows: 0 });
        expect(await contractsRepository.markOverdueNotified(p)).toBe(false);
      });
    });
  });

  describe('extensão de prazo (RN-028)', () => {
    describe('requestExtension', () => {
      const p = {
        id: 12,
        deadlineAt: new Date('2026-10-17T02:59:59.000Z'),
        reason: 'O material chegou depois do combinado',
        now: NOW,
        respondBy: new Date('2026-10-08T15:00:00.000Z'),
      };

      it('registra o pedido contando-o antes de mudar o status que o contador lê', async () => {
        fakeDb.reply({ affectedRows: 1 });

        expect(await contractsRepository.requestExtension(p)).toBe(true);

        const { sql, params } = fakeDb.calls[0]!;
        const set = sql.slice(sql.indexOf(' SET '), sql.indexOf(' WHERE '));
        // O contador vem PRIMEIRO: a atribuição seguinte já muda o status que ele lê.
        expect(set.startsWith(` SET c.extension_requests = ${REQUESTS_USED} + 1,`)).toBe(true);
        expect(set).toContain("c.extension_status = 'pending'");
        expect(set).toContain('c.extension_deadline_at = :deadlineAt');
        expect(set).toContain('c.extension_reason = :reason');
        expect(set).toContain('c.extension_requested_at = :now');
        expect(set).toContain('c.extension_respond_by = :respondBy');
        expect(set).toContain('c.extension_resolved_at = NULL');
        expect(params).toEqual(p);
      });

      it('o WHERE repete as regras do service para a concorrência: nada entregue, nenhuma extensão aceita, nenhum pedido pendente, menos de 2 pedidos e carência aberta', async () => {
        fakeDb.reply({ affectedRows: 1 });
        await contractsRepository.requestExtension(p);

        const { sql } = fakeDb.calls[0]!;
        const where = sql.slice(sql.indexOf(' WHERE '));
        expect(where.startsWith(` WHERE c.id = :id AND ${ELIGIBLE}`)).toBe(true);
        expect(where).toContain('AND c.deadline_extended_at IS NULL');
        expect(where).toContain("AND c.extension_status <> 'pending'");
        expect(where).toContain(`AND ${REQUESTS_USED} < 2`);
        expect(where.endsWith('AND (c.grace_ends_at IS NULL OR c.grace_ends_at > :now)')).toBe(
          true,
        );
      });

      it('devolve false quando alguma regra deixou de valer no meio', async () => {
        fakeDb.reply({ affectedRows: 0 });
        expect(await contractsRepository.requestExtension(p)).toBe(false);
      });
    });

    describe('acceptExtension', () => {
      const p = {
        id: 12,
        seq: 1,
        now: NOW,
        changedBy: 7,
        status: 'accepted',
        note: 'Prazo estendido de 09/10/2026 para 16/10/2026 (RN-028): material atrasou',
      };

      it('o prazo muda de uma vez, zera o aviso e a carência e deixa a mudança na linha do tempo', async () => {
        fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });

        expect(await contractsRepository.acceptExtension(p)).toBe(true);

        const { sql, params } = fakeDb.calls[0]!;
        const set = sql.slice(sql.indexOf(' SET '), sql.indexOf(' WHERE '));
        expect(set).toContain('c.deadline_at = c.extension_deadline_at');
        // Trava novas extensões: só uma é aceita por contratação.
        expect(set).toContain('c.deadline_extended_at = :now');
        expect(set).toContain('c.extension_resolved_at = :now');
        expect(set).toContain("c.extension_status = 'accepted'");
        // O prazo novo recomeça a contagem.
        expect(set).toContain('c.overdue_notified_at = NULL');
        expect(set).toContain('c.grace_ends_at = NULL');
        expect(params).toEqual({ id: 12, seq: 1, now: NOW });

        // A linha do tempo registra a mudança sem trocar o status.
        expect(fakeDb.calls[1]!.sql).toContain('INSERT INTO contract_status_history');
        expect(fakeDb.calls[1]!.sql).toContain('VALUES (:id, :changedBy, :status, :status, :note)');
        expect(fakeDb.calls[1]!.params).toEqual({
          id: 12,
          changedBy: 7,
          status: 'accepted',
          note: p.note,
        });
        expectCommitted();
      });

      it('só aceita o pedido que o cliente viu, dentro da hora, com a data pedida ainda no futuro e trabalho por entregar', async () => {
        fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });
        await contractsRepository.acceptExtension(p);

        const { sql } = fakeDb.calls[0]!;
        const where = sql.slice(sql.indexOf(' WHERE '));
        expect(where.startsWith(" WHERE c.id = :id AND c.extension_status = 'pending'")).toBe(true);
        // CAS pelo número do pedido: outro pedido no meio não é aceito por engano.
        expect(where).toContain('AND (:seq IS NULL OR c.extension_requests = :seq)');
        expect(where).toContain(
          'AND (c.extension_respond_by IS NULL OR c.extension_respond_by > :now)',
        );
        expect(where).toContain('AND c.extension_deadline_at > :now');
        expect(where.endsWith(`AND ${ELIGIBLE}`)).toBe(true);
      });

      it('se o pedido mudou ou expirou, desfaz, não escreve na linha do tempo e devolve false', async () => {
        fakeDb.reply({ affectedRows: 0 });

        expect(await contractsRepository.acceptExtension(p)).toBe(false);

        expect(fakeDb.calls).toHaveLength(1);
        expectRolledBack();
      });

      it('se a linha do tempo falha, o prazo não muda: desfaz e repassa o erro', async () => {
        const boom = new Error('lock wait timeout');
        fakeDb.reply({ affectedRows: 1 }, boom);

        await expect(contractsRepository.acceptExtension(p)).rejects.toBe(boom);

        expectRolledBack();
      });
    });

    describe('settleExtension', () => {
      const p = {
        id: 12,
        seq: 1,
        now: NOW,
        graceEndsAt: new Date('2026-10-07T12:00:00.000Z'),
      };

      it('a recusa só passa enquanto o pedido está pendente e dentro da hora de responder', async () => {
        fakeDb.reply({ affectedRows: 1 });

        expect(await contractsRepository.settleExtension({ ...p, outcome: 'declined' })).toBe(true);

        const { sql, params } = fakeDb.calls[0]!;
        expect(sql).toContain(
          'SET c.extension_resolved_at = :now, c.extension_status = :outcome, c.grace_ends_at = COALESCE(:graceEndsAt, c.grace_ends_at)',
        );
        expect(sql).toContain("WHERE c.id = :id AND c.extension_status = 'pending'");
        expect(sql).toContain('AND (:seq IS NULL OR c.extension_requests = :seq)');
        expect(
          sql.endsWith('AND (c.extension_respond_by IS NULL OR c.extension_respond_by > :now)'),
        ).toBe(true);
        expect(params).toEqual({ ...p, outcome: 'declined' });
      });

      it('a expiração (job) só passa depois da hora de responder', async () => {
        fakeDb.reply({ affectedRows: 1 });

        expect(
          await contractsRepository.settleExtension({
            ...p,
            outcome: 'expired',
            graceEndsAt: null,
          }),
        ).toBe(true);

        const { sql, params } = fakeDb.calls[0]!;
        expect(sql).toContain("AND c.extension_status = 'pending'");
        expect(
          sql.endsWith('AND c.extension_respond_by IS NOT NULL AND c.extension_respond_by <= :now'),
        ).toBe(true);
        expect(params).toEqual({ ...p, outcome: 'expired', graceEndsAt: null });
      });

      it('recusa e expiração disputam a mesma linha: quem perde recebe false', async () => {
        fakeDb.reply({ affectedRows: 0 });
        expect(await contractsRepository.settleExtension({ ...p, outcome: 'declined' })).toBe(
          false,
        );
      });
    });
  });

  describe('transition', () => {
    const base = { id: 12, changedBy: 44, from: 'pending', to: 'accepted', note: null };

    it('troca o status só se ele ainda for o que foi lido e grava a linha do tempo na mesma transação (RN-022)', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });

      expect(await contractsRepository.transition(base)).toBe(true);

      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE contracts c SET c.status = :to WHERE c.id = :id AND c.status = :from',
      );
      // Sem instante informado, vale o relógio do fluxo.
      expect(fakeDb.calls[0]!.params).toEqual({
        to: 'accepted',
        id: 12,
        from: 'pending',
        now: NOW,
      });
      expect(fakeDb.calls[1]!.sql).toContain(
        'INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)',
      );
      expect(fakeDb.calls[1]!.sql).toContain('VALUES (:id, :changedBy, :from, :to, :note)');
      expect(fakeDb.calls[1]!.params).toEqual(base);
      expectCommitted();
    });

    it('se o status já mudou (corrida), desfaz e devolve false sem linha do tempo nem carteira', async () => {
      fakeDb.reply({ affectedRows: 0 });

      const ok = await contractsRepository.transition({
        ...base,
        milestonesTo: { from: ['pending'], to: 'funded' },
        walletEffects: [{ userId: 7, pendingDelta: -500, balanceDelta: 0, reason: 'payment' }],
        creditsEffects: [{ userId: 7, pendingDelta: 0, balanceDelta: -40 }],
      });

      expect(ok).toBe(false);
      expect(fakeDb.calls).toHaveLength(1);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('grava a data da etapa, encerra o pedido de extensão pendente e repete a guarda da leitura (ADR 57)', async () => {
      const at = new Date('2026-10-06T18:30:00.000Z');
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });

      await contractsRepository.transition({
        ...base,
        from: 'accepted',
        to: 'cancelled',
        note: 'Reembolso: 50% (contratação sem prazo)',
        timestampColumn: 'cancelled_at',
        now: at,
        closePendingExtension: true,
        // Um parâmetro da guarda com nome de parâmetro da transição não troca o alvo.
        guard: { sql: 'AND c.deadline_at <=> :gDeadline', params: { gDeadline: null, id: 999 } },
      });

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(`SET c.status = :to, c.cancelled_at = :now, ${CLOSE_EXTENSION} WHERE`);
      expect(
        sql.endsWith('WHERE c.id = :id AND c.status = :from AND c.deadline_at <=> :gDeadline'),
      ).toBe(true);
      expect(params).toEqual({
        gDeadline: null,
        to: 'cancelled',
        id: 12,
        from: 'accepted',
        now: at,
      });
      expect(fakeDb.calls[1]!.params).toMatchObject({
        id: 12,
        note: 'Reembolso: 50% (contratação sem prazo)',
      });
    });

    it('encerrar o pedido de extensão não depende de gravar a data da etapa, e sem pedir não encerra', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });
      await contractsRepository.transition({ ...base, closePendingExtension: true });
      expect(fakeDb.calls[0]!.sql).toBe(
        `UPDATE contracts c SET c.status = :to, ${CLOSE_EXTENSION} WHERE c.id = :id AND c.status = :from`,
      );

      fakeDb.reset();
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });
      await contractsRepository.transition({ ...base, closePendingExtension: false });
      expect(fakeDb.calls[0]!.sql).not.toContain('extension_status');
    });

    it('a data gravada é a da etapa pedida (aceite, conclusão, cancelamento ou pedido de revisão)', async () => {
      for (const column of [
        'accepted_at',
        'completed_at',
        'cancelled_at',
        'revision_requested_at',
      ] as const) {
        fakeDb.reset();
        fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });
        await contractsRepository.transition({ ...base, timestampColumn: column });
        expect(fakeDb.calls[0]!.sql).toBe(
          `UPDATE contracts c SET c.status = :to, c.${column} = :now WHERE c.id = :id AND c.status = :from`,
        );
      }
    });

    it('os marcos mudam de status junto com a contratação (financiados no aceite, RN-069)', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 }, { affectedRows: 2 });

      const ok = await contractsRepository.transition({
        ...base,
        milestonesTo: { from: ['pending'], to: 'funded' },
      });

      expect(ok).toBe(true);
      expect(fakeDb.calls[2]!.sql).toBe(
        'UPDATE contract_milestones SET status = :to WHERE contract_id = :id AND status IN (:from)',
      );
      expect(fakeDb.calls[2]!.params).toEqual({ to: 'funded', id: 12, from: ['pending'] });
      expectCommitted();
    });

    describe('carteira em R$', () => {
      const payment = {
        userId: 7,
        pendingDelta: -500,
        balanceDelta: 0,
        reason: 'payment' as const,
      };
      const escrow = {
        userId: 44,
        pendingDelta: 425,
        balanceDelta: 0,
        reason: 'escrow_in' as const,
      };

      it('cada movimento é aplicado na mesma transação, ligado à contratação', async () => {
        fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });

        const ok = await contractsRepository.transition({
          ...base,
          walletEffects: [payment, escrow],
        });

        expect(ok).toBe(true);
        expect(lockWalletUsers).toHaveBeenCalledWith(fakeDb.conn, [7, 44, base.changedBy]);
        expect(lockWalletRows).toHaveBeenCalledWith(fakeDb.conn, [7, 44]);
        expect(lockWalletUsers.mock.invocationCallOrder[0]).toBeLessThan(
          lockWalletRows.mock.invocationCallOrder[0]!,
        );
        expect(lockWalletRows.mock.invocationCallOrder[0]).toBeLessThan(
          applyWalletEffect.mock.invocationCallOrder[0]!,
        );
        expect(applyWalletEffect).toHaveBeenCalledTimes(2);
        expect(applyWalletEffect).toHaveBeenNthCalledWith(1, fakeDb.conn, {
          ...payment,
          contractId: 12,
        });
        expect(applyWalletEffect).toHaveBeenNthCalledWith(2, fakeDb.conn, {
          ...escrow,
          contractId: 12,
        });
        expectCommitted();
      });

      it('se uma carteira ficaria negativa, a transição inteira é desfeita e devolve false', async () => {
        fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });
        applyWalletEffect.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        const ok = await contractsRepository.transition({
          ...base,
          walletEffects: [payment, escrow],
          creditsEffects: [{ userId: 7, pendingDelta: 0, balanceDelta: -40 }],
        });

        expect(ok).toBe(false);
        // Os créditos nem são tocados: só o status e a linha do tempo foram tentados.
        expect(fakeDb.calls).toHaveLength(2);
        expectRolledBack();
      });
    });

    it('se a carteira em R$ falha com erro, desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('carteira fora do ar');
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });
      applyWalletEffect.mockRejectedValueOnce(boom);

      await expect(
        contractsRepository.transition({
          ...base,
          walletEffects: [{ userId: 7, pendingDelta: -500, balanceDelta: 0, reason: 'payment' }],
        }),
      ).rejects.toBe(boom);

      expectRolledBack();
    });

    describe('carteira em créditos (time-bank)', () => {
      const hold = { userId: 7, pendingDelta: 0, balanceDelta: -40, reason: 'escrow_hold' };
      const escrowIn = { userId: 44, pendingDelta: 40, balanceDelta: 0, reason: 'escrow_in' };
      const release = { userId: 44, pendingDelta: -40, balanceDelta: 40 };

      it('move os créditos com guarda contra saldo negativo e grava o extrato só de quem tem motivo', async () => {
        fakeDb.reply(
          { affectedRows: 1 }, // status
          { affectedRows: 1 }, // linha do tempo
          { affectedRows: 1 }, // carteira do cliente
          [{ total: '60' }], // saldo dele depois
          { affectedRows: 1 }, // extrato
          { affectedRows: 1 }, // carteira do freelancer (sem motivo: sem extrato)
        );

        const ok = await contractsRepository.transition({
          ...base,
          creditsEffects: [hold, release],
        });

        expect(ok).toBe(true);
        expect(fakeDb.calls).toHaveLength(6);
        const wallet = fakeDb.calls[2]!;
        expect(wallet.sql).toContain(
          'UPDATE wallets SET credits_pending = credits_pending + :pending, credits_balance = credits_balance + :balance WHERE user_id = :userId',
        );
        // Nenhum dos dois saldos pode ficar negativo.
        expect(wallet.sql).toContain('AND credits_pending + :pending >= 0');
        expect(wallet.sql).toContain('AND credits_balance + :balance >= 0');
        expect(wallet.params).toEqual({ pending: 0, balance: -40, userId: 7 });

        expect(fakeDb.calls[3]!.sql).toBe(
          'SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId',
        );
        expect(fakeDb.calls[3]!.params).toEqual({ userId: 7 });
        // O extrato guarda a variação total e o saldo que ficou, ligados à contratação.
        expect(fakeDb.calls[4]!.sql).toContain(
          'INSERT INTO credit_transactions (user_id, amount, balance_after, reason, contract_id)',
        );
        expect(fakeDb.calls[4]!.params).toEqual({
          userId: 7,
          amount: -40,
          after: 60,
          reason: 'escrow_hold',
          contractId: 12,
        });
        expect(fakeDb.calls[5]!.sql).toContain('UPDATE wallets SET credits_pending');
        expect(fakeDb.calls[5]!.params).toEqual({ pending: -40, balance: 40, userId: 44 });
        expect(applyWalletEffect).not.toHaveBeenCalled();
        expectCommitted();
      });

      it('o valor do extrato é a variação total da carteira: o que entra no retido também conta', async () => {
        fakeDb.reply(
          { affectedRows: 1 },
          { affectedRows: 1 },
          { affectedRows: 1 },
          [{ total: 100 }],
          { affectedRows: 1 },
        );

        await contractsRepository.transition({ ...base, creditsEffects: [escrowIn] });

        expect(fakeDb.calls[4]!.params).toEqual({
          userId: 44,
          amount: 40,
          after: 100,
          reason: 'escrow_in',
          contractId: 12,
        });
      });

      it('créditos insuficientes: desfaz tudo, sem extrato, e devolve false', async () => {
        fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 }, { affectedRows: 0 });

        const ok = await contractsRepository.transition({
          ...base,
          creditsEffects: [hold, release],
        });

        expect(ok).toBe(false);
        expect(fakeDb.calls).toHaveLength(3);
        expectRolledBack();
      });
    });

    it('créditos: se o segundo movimento não cabe, o primeiro (já com extrato) é desfeito junto', async () => {
      fakeDb.reply(
        { affectedRows: 1 }, // status
        { affectedRows: 1 }, // linha do tempo
        { affectedRows: 1 }, // carteira do cliente
        [{ total: 60 }],
        { affectedRows: 1 }, // extrato do cliente
        { affectedRows: 0 }, // carteira do freelancer: a guarda não deixou
      );

      const ok = await contractsRepository.transition({
        ...base,
        creditsEffects: [
          { userId: 7, pendingDelta: 0, balanceDelta: -40, reason: 'escrow_hold' },
          { userId: 44, pendingDelta: 40, balanceDelta: 0, reason: 'escrow_in' },
        ],
      });

      expect(ok).toBe(false);
      expect(fakeDb.calls).toHaveLength(6);
      expectRolledBack();
    });

    it('erro no meio da transação: desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({ affectedRows: 1 }, boom);

      await expect(contractsRepository.transition(base)).rejects.toBe(boom);

      expectRolledBack();
    });
  });

  describe('grantRevision', () => {
    const p = {
      id: 12,
      changedBy: 44,
      now: NOW,
      expectedRevisionsUsed: 2,
      expectedRevisionLimit: 2,
    };
    const row = { id: 12, status: 'delivered', revisions_used: 2, revision_limit: 2 };

    it.each([2, 255])(
      'libera %s→%s+1 sem alterar entrega, aprovação tácita ou carteira',
      async (limit) => {
        fakeDb.reply(
          [{ ...row, revisions_used: limit, revision_limit: limit }],
          { affectedRows: 1 },
          { affectedRows: 1 },
        );
        expect(
          await contractsRepository.grantRevision({
            ...p,
            expectedRevisionsUsed: limit,
            expectedRevisionLimit: limit,
          }),
        ).toBe(true);
        expect(fakeDb.calls).toHaveLength(3);
        expect(fakeDb.calls[0]).toEqual({
          sql: 'SELECT * FROM contracts WHERE id = :id FOR UPDATE',
          params: { id: 12 },
        });
        const update = fakeDb.calls[1]!;
        expect(update.sql.split(' WHERE ')[0]).toBe(
          'UPDATE contracts SET revision_limit = revision_limit + 1',
        );
        expect(update.sql).toContain(
          'AND revisions_used = :expectedRevisionsUsed AND revision_limit = :expectedRevisionLimit',
        );
        expect(update.params).toEqual({
          id: 12,
          expectedRevisionsUsed: limit,
          expectedRevisionLimit: limit,
        });
        expect(fakeDb.calls[2]!.params).toMatchObject({
          changedBy: 44,
          now: NOW,
          note: `O freelancer liberou mais uma revisão sem custo (RN-023): agora são ${limit + 1}`,
        });
        expect(recoverDeliveryRules).not.toHaveBeenCalled();
        expect(applyWalletEffect).not.toHaveBeenCalled();
        expectCommitted();
      },
    );

    it.each([
      { status: 'revision_requested' },
      { revision_limit: null },
      { revisions_used: 1 },
      { revisions_used: 4294967295, revision_limit: 4294967295 },
    ])('recusa estado ou orçamento incompatível sob trava: %j', async (state) => {
      fakeDb.reply([{ ...row, ...state }]);
      expect(await contractsRepository.grantRevision(p)).toBe(false);
      expect(fakeDb.calls).toHaveLength(1);
      expectRolledBack();
    });

    it.each([
      { revisions_used: 3, revision_limit: 3 },
      { revisions_used: 3, revision_limit: 2 },
    ])('budget antigo não passa mesmo quando o novo orçamento está esgotado: %j', async (state) => {
      fakeDb.reply([{ ...row, ...state }]);
      expect(await contractsRepository.grantRevision(p)).toBe(false);
      expect(fakeDb.calls).toHaveLength(1);
      expectRolledBack();
    });

    it('UPDATE recusado reverte sem escrever histórico', async () => {
      fakeDb.reply([row], { affectedRows: 0 });
      expect(await contractsRepository.grantRevision(p)).toBe(false);
      expect(fakeDb.calls).toHaveLength(2);
      expectRolledBack();
    });

    it('falha no histórico reverte a liberação inteira', async () => {
      const boom = new Error('history failed');
      fakeDb.reply([row], { affectedRows: 1 }, boom);
      await expect(contractsRepository.grantRevision(p)).rejects.toBe(boom);
      expect(fakeDb.calls).toHaveLength(3);
      expectRolledBack();
    });
  });

  describe('deliver (entrega única)', () => {
    const p = {
      id: 12,
      changedBy: 44,
      from: 'in_progress',
      message: 'Pronto para revisar',
      files: ['https://cdn.escambo.test/entrega.zip'],
      now: NOW,
      approvalDueAt: new Date('2026-10-11T15:00:00.000Z'),
    };

    it('vai para delivered gravando a hora da aprovação tácita (RN-024), encerra o pedido de extensão e registra a entrega e a linha do tempo', async () => {
      fakeDb.reply(
        [{ id: 12, status: p.from }],
        { affectedRows: 1 },
        { affectedRows: 1 },
        { affectedRows: 1 },
      );

      expect(await contractsRepository.deliver(p)).toBe(true);

      expect(fakeDb.calls).toHaveLength(4);
      expect(fakeDb.calls[0]!.sql).toBe('SELECT * FROM contracts WHERE id = :id FOR UPDATE');
      expect(recoverDeliveryRules).toHaveBeenCalledWith(fakeDb.conn, 12, {
        id: 12,
        status: p.from,
      });
      const update = fakeDb.calls[1]!;
      expect(update.sql).toContain(
        `UPDATE contracts c SET c.status = 'delivered', c.approval_due_at = :approvalDueAt, c.first_delivery_at = COALESCE(c.first_delivery_at, :first), c.delivery_dispute_opens_at = :opens, ${CLOSE_EXTENSION} WHERE`,
      );
      // Só entrega se o status ainda for o lido.
      expect(update.sql.endsWith('WHERE c.id = :id AND c.status = :from')).toBe(true);
      expect(update.params).toEqual({
        id: 12,
        from: 'in_progress',
        now: NOW,
        approvalDueAt: p.approvalDueAt,
        first: NOW,
        opens: new Date(NOW.getTime() + 48 * 3_600_000),
      });

      expect(fakeDb.calls[2]!.sql).toContain(
        'INSERT INTO deliveries (contract_id, message, files, delivered_at, created_at) VALUES (:id, :message, :files, :now, :now)',
      );
      // Os arquivos vão como JSON, e as duas datas da entrega são o instante do fluxo.
      expect(fakeDb.calls[2]!.params).toEqual({
        id: 12,
        message: 'Pronto para revisar',
        files: '["https://cdn.escambo.test/entrega.zip"]',
        now: NOW,
      });

      expect(fakeDb.calls[3]!.sql).toContain(
        "VALUES (:id, :changedBy, :from, 'delivered', NULL, :now)",
      );
      expect(fakeDb.calls[3]!.params).toEqual({
        id: 12,
        changedBy: 44,
        from: 'in_progress',
        now: NOW,
      });
      expectCommitted();
    });

    it('entrega sem arquivos grava null, não a string "null"', async () => {
      fakeDb.reply(
        [{ id: 12, status: p.from }],
        { affectedRows: 1 },
        { affectedRows: 1 },
        { affectedRows: 1 },
      );
      await contractsRepository.deliver({ ...p, files: null });
      expect(fakeDb.calls[2]!.params).toMatchObject({ files: null });
    });

    it('se o status já mudou, desfaz e devolve false sem registrar entrega', async () => {
      fakeDb.reply({ affectedRows: 0 });

      expect(await contractsRepository.deliver(p)).toBe(false);

      expect(fakeDb.calls).toHaveLength(1);
      expectRolledBack();
    });

    it('se o registro da entrega falha, o status não muda: desfaz e repassa o erro', async () => {
      const boom = new Error('data too long');
      fakeDb.reply([{ id: 12, status: p.from }], { affectedRows: 1 }, boom);

      await expect(contractsRepository.deliver(p)).rejects.toBe(boom);

      expectRolledBack();
    });
  });
});
