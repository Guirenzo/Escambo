import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { lockWalletRows, lockWalletUsers, lockWallets } from '../wallet/wallet.locks';
import { setClockForTests } from '../../utils/clock';
import { disputesRepository } from './disputes.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { recoverDeliveryRules } from '../contracts/delivery-snapshots';

const { ledger } = vi.hoisted(() => ({ ledger: { applyWalletEffect: vi.fn() } }));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../wallet/wallet.locks', () => ({
  lockWalletRows: vi.fn(),
  lockWalletUsers: vi.fn(),
  lockWallets: vi.fn(),
}));
vi.mock('../wallet/wallet.ledger', () => ledger);
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));
vi.mock('../contracts/delivery-snapshots', () => ({ recoverDeliveryRules: vi.fn() }));

/** Marca do ledger de R$ na sequência de instruções, para conferir a ordem junto com o SQL. */
const WALLET_EFFECT = 'ledger:applyWalletEffect';

/** As três primeiras palavras de cada instrução: a ordem do que a transação faz. */
const steps = (): string[] => fakeDb.sqls().map((s) => s.split(' ').slice(0, 3).join(' '));

/** A ordem global de chamada (a do vitest) de tudo o que a transação executou: SQL e ledger. */
const workOrder = (): number[] =>
  [fakeDb.conn.query, ledger.applyWalletEffect].flatMap((m) => m.mock.invocationCallOrder);
const orderOf = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0]!;

function expectCommitted(): void {
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
  // Tudo acontece DENTRO da transação: ela abre antes da primeira instrução, só confirma depois
  // da última, e a conexão só volta ao pool depois de confirmada.
  expect(orderOf(fakeDb.conn.beginTransaction)).toBeLessThan(Math.min(...workOrder()));
  expect(orderOf(fakeDb.conn.commit)).toBeGreaterThan(Math.max(...workOrder()));
  expect(orderOf(fakeDb.conn.release)).toBeGreaterThan(orderOf(fakeDb.conn.commit));
}

function expectRolledBack(): void {
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
  // O que já tinha sido gravado é desfeito antes de a conexão voltar ao pool.
  expect(orderOf(fakeDb.conn.beginTransaction)).toBeLessThan(Math.min(...workOrder()));
  expect(orderOf(fakeDb.conn.rollback)).toBeGreaterThan(Math.max(...workOrder()));
  expect(orderOf(fakeDb.conn.release)).toBeGreaterThan(orderOf(fakeDb.conn.rollback));
}

/**
 * Repository das disputas sem banco: o que cada método pede, em que ordem, e como fecha a
 * transação. O ledger de R$ entra mockado (tem os próprios testes); se o SQL roda no MySQL é da
 * integração.
 */
describe('disputesRepository', () => {
  beforeEach(() => {
    fakeDb.reset();
    for (const lock of [lockWalletRows, lockWalletUsers, lockWallets])
      vi.mocked(lock).mockReset().mockResolvedValue(undefined);
    vi.mocked(contractsRepository.findById).mockReset();
    vi.mocked(recoverDeliveryRules).mockReset();
    ledger.applyWalletEffect.mockReset().mockImplementation(async (_conn, effect) => {
      fakeDb.calls.push({ sql: WALLET_EFFECT, params: effect });
      return true;
    });
  });
  afterEach(() => setClockForTests(null));

  describe('createManual (RN-062): janela relida sob a trava', () => {
    const data = {
      ulid: '01JDISPUTE0000000000000000',
      contractId: 8,
      openedBy: 7,
      reason: 'quality',
      description: 'A entrega veio incompleta',
    };
    const NOW = new Date('2026-10-08T15:00:00Z');
    const facts = (extra: Record<string, unknown> = {}): ContractRow =>
      ({
        id: 8,
        client_id: 7,
        freelancer_id: 9,
        status: 'accepted',
        created_at: new Date('2026-10-01T15:00:00Z'),
        accepted_at: new Date('2026-10-06T15:00:00Z'),
        first_delivery_at: null,
        first_delivered_at: null,
        approval_due_at: null,
        next_milestone_approval_at: null,
        delivery_dispute_opens_at: null,
        next_milestone_dispute_opens_at: null,
        client_timezone: 'America/Rio_Branco',
        freelancer_timezone: 'America/Noronha',
        ...extra,
      }) as unknown as ContractRow;
    const read = vi.mocked(contractsRepository.findById);
    const recover = vi.mocked(recoverDeliveryRules);

    it.each(['pending', 'completed', 'cancelled', 'disputed', undefined])(
      'status %s recusa antes de recuperar ou reler fatos',
      async (status) => {
        fakeDb.reply(status ? [{ status }] : []);
        expect(await disputesRepository.createManual(data)).toEqual({ refused: 'not_disputable' });
        expect(read).not.toHaveBeenCalled();
        expect(recover).not.toHaveBeenCalled();
        expect(steps()).toEqual(['SELECT status FROM']);
        expectRolledBack();
      },
    );

    it('trava contrato, recupera legado, relê na mesma conexão e abre no limite exato de 48h', async () => {
      setClockForTests(NOW, { frozen: true });
      read.mockResolvedValue(facts());
      fakeDb.reply([{ status: 'accepted' }], { affectedRows: 1 }, { insertId: 55 }, {});
      expect(await disputesRepository.createManual(data)).toEqual({ id: 55 });
      expect(recover).toHaveBeenCalledWith(fakeDb.conn, 8);
      expect(read).toHaveBeenCalledWith(8, fakeDb.conn);
      expect(orderOf(fakeDb.conn.query)).toBeLessThan(orderOf(recover));
      expect(orderOf(recover)).toBeLessThan(orderOf(read));
      expect(fakeDb.calls[1]!.params).toEqual({ contractId: 8, oldStatus: 'accepted', now: NOW });
      expect(fakeDb.calls[1]!.sql).toMatch(/AND c\.status = :oldStatus$/);
      expectCommitted();
    });

    it('um segundo antes recusa com abertura e fuso da pessoa, sem atualizar status ou criar disputa', async () => {
      setClockForTests(new Date(NOW.getTime() - 1000), { frozen: true });
      read.mockResolvedValue(facts());
      fakeDb.reply([{ status: 'accepted' }]);
      expect(await disputesRepository.createManual(data)).toEqual({
        refused: 'too_early',
        opensAt: NOW,
        requesterZone: 'America/Rio_Branco',
      });
      expect(steps()).toEqual(['SELECT status FROM']);
      expectRolledBack();
    });

    it('entrega simultânea relida inaugura outra espera e usa o fuso do freelancer que pede', async () => {
      setClockForTests(NOW, { frozen: true });
      read.mockResolvedValue(
        facts({ status: 'delivered', first_delivery_at: NOW, delivery_dispute_opens_at: null }),
      );
      fakeDb.reply([{ status: 'delivered' }]);
      expect(await disputesRepository.createManual({ ...data, openedBy: 9 })).toEqual({
        refused: 'too_early',
        opensAt: new Date('2026-10-10T15:00:00Z'),
        requesterZone: 'America/Noronha',
      });
      expectRolledBack();
    });

    it.each([
      { status: 'revision_requested', delivery_dispute_opens_at: NOW },
      { status: 'in_progress', next_milestone_dispute_opens_at: NOW },
    ])('snapshot histórico abre na revisão e no marco: %j', async (snapshot) => {
      setClockForTests(NOW, { frozen: true });
      read.mockResolvedValue(facts({ first_delivery_at: NOW, ...snapshot }));
      fakeDb.reply([{ status: snapshot.status }], { affectedRows: 1 }, { insertId: 56 }, {});
      expect(await disputesRepository.createManual(data)).toEqual({ id: 56 });
      expectCommitted();
    });

    it('consulta o relógio após esperar a trava e terminar a recuperação/releitura', async () => {
      setClockForTests(new Date(NOW.getTime() - 1000), { frozen: true });
      read.mockImplementationOnce(async () => {
        setClockForTests(NOW, { frozen: true });
        return facts();
      });
      fakeDb.reply([{ status: 'accepted' }], { affectedRows: 1 }, { insertId: 57 }, {});
      expect(await disputesRepository.createManual(data)).toEqual({ id: 57 });
      expect(fakeDb.calls[1]!.params).toMatchObject({ now: NOW });
      expectCommitted();
    });

    it('falha do reparo desfaz a transação e não grava disputa', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      recover.mockRejectedValueOnce(boom);
      fakeDb.reply([{ status: 'accepted' }]);
      await expect(disputesRepository.createManual(data)).rejects.toBe(boom);
      expect(read).not.toHaveBeenCalled();
      expectRolledBack();
    });
  });

  describe('create (RN-038, ADR 57)', () => {
    const data = {
      ulid: '01JDISPUTE0000000000000000',
      contractId: 8,
      openedBy: 7,
      reason: 'quality',
      description: 'A entrega veio incompleta',
    };

    it('trava a contratação, põe em disputa, grava a disputa e o status anterior, nessa ordem', async () => {
      setClockForTests(new Date('2026-10-02T15:00:00.700Z'), { frozen: true });
      fakeDb.reply(
        [{ status: 'in_progress' }],
        { affectedRows: 1 },
        { insertId: 55, affectedRows: 1 },
        { affectedRows: 1 },
      );

      expect(await disputesRepository.create(data)).toBe(55);

      expect(steps()).toEqual([
        'SELECT status FROM',
        'UPDATE contracts c',
        'INSERT INTO disputes',
        'INSERT INTO contract_status_history',
      ]);
      // A leitura trava a linha: duas aberturas ao mesmo tempo não leem o mesmo status.
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT status FROM contracts WHERE id = :contractId FOR UPDATE',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ contractId: 8 });

      // A gravação repete o status lido; sem guarda, o WHERE termina nele.
      const update = fakeDb.calls[1]!;
      expect(update.sql).toContain("UPDATE contracts c SET c.status = 'disputed',");
      expect(update.sql).toMatch(/WHERE c\.id = :contractId AND c\.status = :oldStatus$/);
      // A hora vem do relógio do fluxo de prazos, sem a fração de segundo.
      expect(update.params).toEqual({
        contractId: 8,
        oldStatus: 'in_progress',
        now: new Date('2026-10-02T15:00:00.000Z'),
      });

      expect(fakeDb.calls[2]!.sql).toContain(
        'INSERT INTO disputes (ulid, contract_id, opened_by, reason, description) VALUES (:ulid, :contractId, :openedBy, :reason, :description)',
      );
      expect(fakeDb.calls[2]!.params).toEqual(data);

      // Linha do tempo: quem abriu, de que status saiu e para qual foi, cada valor na sua coluna.
      expect(fakeDb.calls[3]!.sql).toContain(
        'INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)',
      );
      expect(fakeDb.calls[3]!.sql).toMatch(
        /VALUES \(:contractId, :openedBy, :oldStatus, 'disputed', 'Disputa aberta'\)$/,
      );
      expect(fakeDb.calls[3]!.params).toEqual({
        contractId: 8,
        openedBy: 7,
        oldStatus: 'in_progress',
      });
      expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
      expectCommitted();
    });

    it('fecha o pedido de extensão pendente no mesmo UPDATE, com a data antes do status (ADR 57)', async () => {
      fakeDb.reply([{ status: 'accepted' }], { affectedRows: 1 }, { insertId: 1 }, {});
      await disputesRepository.create(data);

      const { sql } = fakeDb.calls[1]!;
      const resolvedAt =
        "c.extension_resolved_at = IF(c.extension_status = 'pending', :now, c.extension_resolved_at)";
      const closed =
        "c.extension_status = IF(c.extension_status = 'pending', 'closed', c.extension_status)";
      expect(sql).toContain(resolvedAt);
      expect(sql).toContain(closed);
      // O SET é avaliado da esquerda para a direita: se o status fechasse antes, a data não seria gravada.
      expect(sql.indexOf(resolvedAt)).toBeLessThan(sql.indexOf(closed));
      expect(sql.indexOf(closed)).toBeLessThan(sql.indexOf('WHERE c.id = :contractId'));
    });

    it.each(['accepted', 'in_progress', 'delivered', 'revision_requested'])(
      'contratação em %s pode entrar em disputa, e esse status vai para a linha do tempo',
      async (status) => {
        fakeDb.reply([{ status }], { affectedRows: 1 }, { insertId: 12 }, {});

        expect(await disputesRepository.create(data)).toBe(12);

        expect(fakeDb.calls[1]!.params).toMatchObject({ oldStatus: status });
        expect(fakeDb.calls[3]!.params).toEqual({ contractId: 8, openedBy: 7, oldStatus: status });
        expectCommitted();
      },
    );

    it.each(['pending', 'awaiting_payment', 'completed', 'cancelled', 'disputed'])(
      'contratação em %s não entra em disputa: devolve null e não grava nada',
      async (status) => {
        fakeDb.reply([{ status }]);

        expect(await disputesRepository.create(data)).toBeNull();

        expect(steps()).toEqual(['SELECT status FROM']);
        expectRolledBack();
      },
    );

    it('contratação que não existe: devolve null e não grava nada', async () => {
      fakeDb.reply([]);
      expect(await disputesRepository.create(data)).toBeNull();
      expect(fakeDb.calls).toHaveLength(1);
      expectRolledBack();
    });

    it('a disputa automática repete na gravação a condição que o job leu, com a hora do job (RN-029)', async () => {
      setClockForTests(new Date('2026-10-02T15:00:00.000Z'), { frozen: true });
      const now = new Date('2026-10-02T12:00:00.000Z');
      const guard = 'AND c.deadline_at < :now AND c.extension_status IS NULL';
      fakeDb.reply([{ status: 'in_progress' }], { affectedRows: 1 }, { insertId: 9 }, {});

      expect(await disputesRepository.create(data, { guard, now })).toBe(9);

      const update = fakeDb.calls[1]!;
      expect(update.sql).toMatch(
        /WHERE c\.id = :contractId AND c\.status = :oldStatus AND c\.deadline_at < :now AND c\.extension_status IS NULL$/,
      );
      // A hora é a que o job passou, não a do relógio.
      expect(update.params).toEqual({ contractId: 8, oldStatus: 'in_progress', now });
    });

    it('se a guarda deixou de valer entre a leitura e a gravação, desiste sem criar a disputa', async () => {
      fakeDb.reply([{ status: 'in_progress' }], { affectedRows: 0 });

      expect(
        await disputesRepository.create(data, { guard: 'AND c.deadline_at < :now' }),
      ).toBeNull();

      expect(steps()).toEqual(['SELECT status FROM', 'UPDATE contracts c']);
      expectRolledBack();
    });

    it('se a gravação da disputa falha, desfaz a mudança de status e devolve a conexão', async () => {
      const boom = new Error('ER_DUP_ENTRY');
      fakeDb.reply([{ status: 'delivered' }], { affectedRows: 1 }, boom);

      await expect(disputesRepository.create(data)).rejects.toBe(boom);

      expect(steps()).toEqual(['SELECT status FROM', 'UPDATE contracts c', 'INSERT INTO disputes']);
      expectRolledBack();
    });

    it('se a linha do tempo falha, a disputa já gravada também é desfeita', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([{ status: 'delivered' }], { affectedRows: 1 }, { insertId: 55 }, boom);
      await expect(disputesRepository.create(data)).rejects.toBe(boom);
      expectRolledBack();
    });

    it('se a leitura da contratação falha (espera de trava estourada), o erro sobe e a conexão volta ao pool', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply(boom);

      await expect(disputesRepository.create(data)).rejects.toBe(boom);

      expect(steps()).toEqual(['SELECT status FROM']);
      expectRolledBack();
    });

    it('linha de contratação sem status é tratada como não disputável', async () => {
      fakeDb.reply([{ status: null }]);
      expect(await disputesRepository.create(data)).toBeNull();
      expect(fakeDb.calls).toHaveLength(1);
      expectRolledBack();
    });
  });

  it('findById devolve a primeira linha, ou undefined', async () => {
    const row = { id: 31, contract_id: 8, status: 'open' };
    fakeDb.reply([row], []);

    expect(await disputesRepository.findById(31)).toBe(row);
    expect(await disputesRepository.findById(32)).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toBe('SELECT * FROM disputes WHERE id = :id LIMIT 1');
    expect(fakeDb.calls[0]!.params).toEqual({ id: 31 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 32 });
  });

  it('a lista do usuário traz as disputas das contratações em que ele é cliente ou freelancer, da mais nova para a mais antiga', async () => {
    const rows = [{ id: 2 }, { id: 1 }];
    fakeDb.reply(rows);

    expect(await disputesRepository.listForUser(7)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toBe(
      'SELECT d.* FROM disputes d JOIN contracts c ON c.id = d.contract_id WHERE c.client_id = :userId OR c.freelancer_id = :userId ORDER BY d.id DESC',
    );
    expect(params).toEqual({ userId: 7 });
  });

  it('a fila da mediação só traz disputas em aberto, da mais antiga para a mais nova', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    fakeDb.reply(rows);

    expect(await disputesRepository.listOpen()).toBe(rows);

    expect(fakeDb.calls[0]!.sql).toBe(
      "SELECT * FROM disputes WHERE status IN ('open', 'under_review', 'awaiting_parties') ORDER BY id ASC",
    );
    expect(fakeDb.calls[0]!.params).toBeUndefined();
  });

  it('sem disputas, as duas listas devolvem lista vazia; leituras simples não abrem transação', async () => {
    expect(await disputesRepository.listForUser(7)).toEqual([]);
    expect(await disputesRepository.listOpen()).toEqual([]);
    expect(await disputesRepository.findById(31)).toBeUndefined();

    expect(steps()).toEqual(['SELECT d.* FROM', 'SELECT * FROM', 'SELECT * FROM']);
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
  });

  describe('resolve (RN-063, RNF-038)', () => {
    // Leituras sob trava precedem as instruções de resolução já conferidas abaixo.
    const resolveSteps = (): string[] => steps().slice(2);
    beforeEach(() => fakeDb.reply([{ id: 8 }], [{ status: 'open' }]));
    const base = {
      disputeId: 31,
      adminId: 1,
      contractId: 8,
      freelancerId: 44,
      clientId: 7,
      paymentMode: 'cash',
      escrowNet: 850,
      releaseToFreelancer: 425,
      refundToClient: 500,
      contractFinalStatus: 'completed' as const,
      resolution: 'partial_split',
      refundPercentage: 50,
      note: 'Meio a meio',
    };

    it('em R$: resolve a disputa, encerra a contratação, move as duas carteiras e registra tudo numa transação', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 }, { affectedRows: 1 }, {});

      expect(await disputesRepository.resolve(base)).toBe(true);
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT id FROM contracts WHERE id = :contractId FOR UPDATE',
      );
      expect(fakeDb.calls[1]!.sql).toBe(
        'SELECT status FROM disputes WHERE id = :disputeId FOR UPDATE',
      );
      expect(lockWallets).toHaveBeenCalledExactlyOnceWith(fakeDb.conn, [44, 7], [1]);
      const lockedAt = vi.mocked(lockWallets).mock.invocationCallOrder[0]!;
      expect(fakeDb.conn.query.mock.invocationCallOrder[1]!).toBeLessThan(lockedAt);
      expect(lockedAt).toBeLessThan(fakeDb.conn.query.mock.invocationCallOrder[2]!);
      expect(lockedAt).toBeLessThan(ledger.applyWalletEffect.mock.invocationCallOrder[0]!);

      expect(resolveSteps()).toEqual([
        'UPDATE disputes SET',
        'UPDATE contracts SET',
        WALLET_EFFECT,
        WALLET_EFFECT,
        'INSERT INTO contract_status_history',
        'INSERT INTO admin_actions',
      ]);

      // Só resolve disputa que ainda não foi resolvida (duas decisões não se aplicam em dobro).
      expect(fakeDb.calls[2]!.sql).toContain(
        "UPDATE disputes SET status = 'resolved', resolution = :resolution, refund_percentage = :refundPercentage, resolved_by = :adminId, resolution_note = :note, resolved_at = NOW()",
      );
      expect(fakeDb.calls[2]!.sql).toMatch(/WHERE id = :disputeId AND status <> 'resolved'$/);
      expect(fakeDb.calls[2]!.params).toEqual({
        resolution: 'partial_split',
        refundPercentage: 50,
        adminId: 1,
        note: 'Meio a meio',
        disputeId: 31,
      });

      expect(fakeDb.calls[3]!.sql).toBe(
        'UPDATE contracts SET status = :status, completed_at = NOW() WHERE id = :contractId',
      );
      expect(fakeDb.calls[3]!.params).toEqual({ status: 'completed', contractId: 8 });

      // O retido do freelancer sai inteiro; o disponível recebe só a parte liberada.
      expect(fakeDb.calls[4]!.params).toEqual({
        userId: 44,
        pendingDelta: -850,
        balanceDelta: 425,
        reason: 'escrow_release',
        contractId: 8,
      });
      expect(fakeDb.calls[5]!.params).toEqual({
        userId: 7,
        pendingDelta: 0,
        balanceDelta: 500,
        reason: 'refund',
        contractId: 8,
      });
      // As carteiras mudam na conexão da transação, não fora dela.
      expect(ledger.applyWalletEffect.mock.calls.map((c) => c[0])).toEqual([
        fakeDb.conn,
        fakeDb.conn,
      ]);

      // Linha do tempo: sai de 'disputed' para o status final, em nome do admin.
      expect(fakeDb.calls[6]!.sql).toContain(
        'INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)',
      );
      expect(fakeDb.calls[6]!.sql).toMatch(
        /VALUES \(:contractId, :adminId, 'disputed', :status, :note\)$/,
      );
      expect(fakeDb.calls[6]!.params).toEqual({
        contractId: 8,
        adminId: 1,
        status: 'completed',
        note: 'Disputa resolvida: partial_split',
      });
      // Trilha das ações de admin: o alvo registrado é a DISPUTA, não a contratação.
      expect(fakeDb.calls[7]!.sql).toContain(
        'INSERT INTO admin_actions (admin_id, action, target_type, target_id, description)',
      );
      expect(fakeDb.calls[7]!.sql).toMatch(
        /VALUES \(:adminId, 'dispute_resolved', 'dispute', :disputeId, :description\)$/,
      );
      expect(fakeDb.calls[7]!.params).toEqual({
        adminId: 1,
        disputeId: 31,
        description: 'resolution=partial_split',
      });
      expectCommitted();
    });

    it('contratação cancelada pela decisão grava cancelled_at, e sem liberação o motivo do extrato é devolução', async () => {
      fakeDb.reply({ affectedRows: 1 }, {}, {}, {});

      await disputesRepository.resolve({
        ...base,
        contractFinalStatus: 'cancelled',
        resolution: 'refund_client',
        releaseToFreelancer: 0,
        refundToClient: 1000,
        refundPercentage: 100,
      });

      expect(fakeDb.calls[3]!.sql).toBe(
        'UPDATE contracts SET status = :status, cancelled_at = NOW() WHERE id = :contractId',
      );
      expect(fakeDb.calls[3]!.params).toEqual({ status: 'cancelled', contractId: 8 });
      expect(fakeDb.calls[4]!.params).toEqual({
        userId: 44,
        pendingDelta: -850,
        balanceDelta: 0,
        reason: 'escrow_refund',
        contractId: 8,
      });
      expect(fakeDb.calls[5]!.params).toEqual({
        userId: 7,
        pendingDelta: 0,
        balanceDelta: 1000,
        reason: 'refund',
        contractId: 8,
      });
      expect(fakeDb.calls[6]!.params).toEqual({
        contractId: 8,
        adminId: 1,
        status: 'cancelled',
        note: 'Disputa resolvida: refund_client',
      });
      expect(fakeDb.calls[7]!.params).toEqual({
        adminId: 1,
        disputeId: 31,
        description: 'resolution=refund_client',
      });
      expectCommitted();
    });

    it('decisão sem observação nem percentual grava os dois como nulos na disputa', async () => {
      fakeDb.reply({ affectedRows: 1 }, {}, {}, {});

      await disputesRepository.resolve({ ...base, note: null, refundPercentage: null });

      expect(fakeDb.calls[2]!.params).toEqual({
        resolution: 'partial_split',
        refundPercentage: null,
        adminId: 1,
        note: null,
        disputeId: 31,
      });
      // A linha do tempo não leva a observação do admin: leva sempre o tipo da decisão.
      expect(fakeDb.calls[6]!.params).toMatchObject({ note: 'Disputa resolvida: partial_split' });
    });

    it('troca (barter) não tem escrow: mesmo com valor informado, nenhuma carteira é movida', async () => {
      fakeDb.reply({ affectedRows: 1 }, {}, {}, {});

      expect(
        await disputesRepository.resolve({
          ...base,
          paymentMode: 'barter',
          contractFinalStatus: 'cancelled',
        }),
      ).toBe(true);

      // Só 'cash' usa o ledger de R$ e só 'credits' mexe nas carteiras de créditos.
      expect(resolveSteps()).toEqual([
        'UPDATE disputes SET',
        'UPDATE contracts SET',
        'INSERT INTO contract_status_history',
        'INSERT INTO admin_actions',
      ]);
      expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('liberação total para o freelancer não toca na carteira do cliente', async () => {
      fakeDb.reply({ affectedRows: 1 }, {}, {}, {});

      expect(
        await disputesRepository.resolve({
          ...base,
          resolution: 'release_freelancer',
          releaseToFreelancer: 850,
          refundToClient: 0,
          refundPercentage: 0,
        }),
      ).toBe(true);

      expect(ledger.applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(fakeDb.calls[4]!.params).toEqual({
        userId: 44,
        pendingDelta: -850,
        balanceDelta: 850,
        reason: 'escrow_release',
        contractId: 8,
      });
      expectCommitted();
    });

    it('disputa que já foi resolvida: devolve false e não mexe em contratação nem carteira', async () => {
      fakeDb.reset();
      fakeDb.reply([{ id: 8 }], [{ status: 'resolved' }]);

      expect(await disputesRepository.resolve(base)).toBe(false);

      expect(steps()).toEqual(['SELECT id FROM', 'SELECT status FROM']);
      expect(lockWallets).not.toHaveBeenCalled();
      expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it.each(['under_review', 'awaiting_parties', 'closed'])(
      'mantém a guarda anterior: disputa em %s ainda pode ser resolvida',
      async (status) => {
        fakeDb.reset();
        fakeDb.reply([{ id: 8 }], [{ status }], { affectedRows: 1 }, {}, {}, {});
        expect(await disputesRepository.resolve(base)).toBe(true);
        expectCommitted();
      },
    );

    it('disputa ausente recusa sem travar contas ou mover saldo', async () => {
      fakeDb.reset();
      fakeDb.reply([{ id: 8 }], []);
      expect(await disputesRepository.resolve(base)).toBe(false);
      expect(lockWallets).not.toHaveBeenCalled();
      expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('falha ao travar contas e carteiras reverte antes de registrar a decisão', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      vi.mocked(lockWallets).mockRejectedValueOnce(boom);
      await expect(disputesRepository.resolve(base)).rejects.toBe(boom);
      expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
      expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('se a carteira do freelancer não comporta o movimento, nada é aplicado', async () => {
      ledger.applyWalletEffect.mockResolvedValueOnce(false);
      fakeDb.reply({ affectedRows: 1 }, {});

      expect(await disputesRepository.resolve(base)).toBe(false);

      expect(fakeDb.sqls().some((s) => s.startsWith('INSERT INTO'))).toBe(false);
      expectRolledBack();
    });

    it('se a carteira do cliente não comporta o reembolso, nada é aplicado', async () => {
      ledger.applyWalletEffect.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      fakeDb.reply({ affectedRows: 1 }, {});

      expect(await disputesRepository.resolve(base)).toBe(false);

      expect(ledger.applyWalletEffect).toHaveBeenCalledTimes(2);
      expect(fakeDb.sqls().some((s) => s.startsWith('INSERT INTO'))).toBe(false);
      expectRolledBack();
    });

    it.each(['cash', 'credits'])(
      'sem nada retido (%s), resolve sem mover carteira nenhuma',
      async (paymentMode) => {
        fakeDb.reply({ affectedRows: 1 }, {}, {}, {});

        expect(
          await disputesRepository.resolve({
            ...base,
            paymentMode,
            escrowNet: 0,
            releaseToFreelancer: 0,
            refundToClient: 0,
          }),
        ).toBe(true);

        expect(resolveSteps()).toEqual([
          'UPDATE disputes SET',
          'UPDATE contracts SET',
          'INSERT INTO contract_status_history',
          'INSERT INTO admin_actions',
        ]);
        expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
        expectCommitted();
      },
    );

    describe('em créditos (banco de horas)', () => {
      const credits = {
        ...base,
        paymentMode: 'credits',
        escrowNet: 10,
        releaseToFreelancer: 4,
        refundToClient: 6,
      };
      const walletUpdate =
        'UPDATE wallets SET credits_pending = credits_pending + :pending, credits_balance = credits_balance + :balance WHERE user_id = :userId AND credits_pending + :pending >= 0 AND credits_balance + :balance >= 0';

      it('aplica a mesma decisão nas carteiras de créditos, com uma linha no extrato de cada parte', async () => {
        fakeDb.reply(
          { affectedRows: 1 }, // disputa
          { affectedRows: 1 }, // contratação
          { affectedRows: 1 }, // carteira do freelancer
          [{ total: '14' }],
          { affectedRows: 1 }, // extrato do freelancer
          { affectedRows: 1 }, // carteira do cliente
          [{ total: '26' }],
          { affectedRows: 1 }, // extrato do cliente
          {},
          {},
        );

        expect(await disputesRepository.resolve(credits)).toBe(true);

        expect(resolveSteps()).toEqual([
          'UPDATE disputes SET',
          'UPDATE contracts SET',
          'UPDATE wallets SET',
          'SELECT credits_balance +',
          'INSERT INTO credit_transactions',
          'UPDATE wallets SET',
          'SELECT credits_balance +',
          'INSERT INTO credit_transactions',
          'INSERT INTO contract_status_history',
          'INSERT INTO admin_actions',
        ]);
        // O ledger de R$ não entra numa contratação em créditos.
        expect(ledger.applyWalletEffect).not.toHaveBeenCalled();

        // Freelancer: o retido sai inteiro e só a parte liberada vira saldo; nenhum dos dois fica negativo.
        expect(fakeDb.calls[4]!.sql).toBe(walletUpdate);
        expect(fakeDb.calls[4]!.params).toEqual({ pending: -10, balance: 4, userId: 44 });
        expect(fakeDb.calls[5]!.sql).toBe(
          'SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId',
        );
        expect(fakeDb.calls[5]!.params).toEqual({ userId: 44 });
        expect(fakeDb.calls[6]!.sql).toContain(
          'INSERT INTO credit_transactions (user_id, amount, balance_after, reason, contract_id) VALUES (:userId, :amount, :after, :reason, :contractId)',
        );
        // O extrato guarda a variação líquida (retido + saldo) e o total lido depois dela, em número.
        expect(fakeDb.calls[6]!.params).toEqual({
          userId: 44,
          amount: -6,
          after: 14,
          reason: 'escrow_release',
          contractId: 8,
        });

        // Cliente: recebe a devolução no saldo.
        expect(fakeDb.calls[7]!.sql).toBe(walletUpdate);
        expect(fakeDb.calls[7]!.params).toEqual({ pending: 0, balance: 6, userId: 7 });
        expect(fakeDb.calls[8]!.params).toEqual({ userId: 7 });
        expect(fakeDb.calls[9]!.params).toEqual({
          userId: 7,
          amount: 6,
          after: 26,
          reason: 'refund',
          contractId: 8,
        });
        expectCommitted();
      });

      it('devolução total: o motivo do freelancer é devolução do retido', async () => {
        fakeDb.reply({ affectedRows: 1 }, {}, { affectedRows: 1 }, [{ total: 3 }], {});
        fakeDb.reply({ affectedRows: 1 }, [{ total: 30 }], {}, {}, {});

        await disputesRepository.resolve({
          ...credits,
          releaseToFreelancer: 0,
          refundToClient: 10,
        });

        expect(fakeDb.calls[4]!.params).toEqual({ pending: -10, balance: 0, userId: 44 });
        expect(fakeDb.calls[6]!.params).toEqual({
          userId: 44,
          amount: -10,
          after: 3,
          reason: 'escrow_refund',
          contractId: 8,
        });
        expect(fakeDb.calls[9]!.params).toMatchObject({ userId: 7, amount: 10, reason: 'refund' });
      });

      it('liberação total: o cliente não tem movimento nem linha de extrato', async () => {
        fakeDb.reply({ affectedRows: 1 }, {}, { affectedRows: 1 }, [{ total: 22 }], {}, {}, {});

        expect(
          await disputesRepository.resolve({
            ...credits,
            releaseToFreelancer: 10,
            refundToClient: 0,
          }),
        ).toBe(true);

        expect(resolveSteps()).toEqual([
          'UPDATE disputes SET',
          'UPDATE contracts SET',
          'UPDATE wallets SET',
          'SELECT credits_balance +',
          'INSERT INTO credit_transactions',
          'INSERT INTO contract_status_history',
          'INSERT INTO admin_actions',
        ]);
        expect(fakeDb.calls[6]!.params).toEqual({
          userId: 44,
          amount: 0,
          after: 22,
          reason: 'escrow_release',
          contractId: 8,
        });
      });

      it('se a carteira de créditos não comporta o movimento, nada é aplicado', async () => {
        fakeDb.reply({ affectedRows: 1 }, {}, { affectedRows: 0 });

        expect(await disputesRepository.resolve(credits)).toBe(false);

        expect(resolveSteps()).toEqual([
          'UPDATE disputes SET',
          'UPDATE contracts SET',
          'UPDATE wallets SET',
        ]);
        expectRolledBack();
      });

      it('se é a carteira do CLIENTE que recusa, o que já saiu do freelancer também é desfeito', async () => {
        fakeDb.reply(
          { affectedRows: 1 }, // disputa
          { affectedRows: 1 }, // contratação
          { affectedRows: 1 }, // carteira do freelancer
          [{ total: 14 }],
          { affectedRows: 1 }, // extrato do freelancer
          { affectedRows: 0 }, // carteira do cliente recusa
        );

        expect(await disputesRepository.resolve(credits)).toBe(false);

        // Para na carteira do cliente: sem extrato dele, sem linha do tempo, sem ação de admin.
        expect(resolveSteps()).toEqual([
          'UPDATE disputes SET',
          'UPDATE contracts SET',
          'UPDATE wallets SET',
          'SELECT credits_balance +',
          'INSERT INTO credit_transactions',
          'UPDATE wallets SET',
        ]);
        expect(fakeDb.calls[7]!.params).toEqual({ pending: 0, balance: 6, userId: 7 });
        expectRolledBack();
      });

      it('se o extrato de créditos falha, desfaz tudo e devolve a conexão', async () => {
        const boom = new Error('deadlock');
        fakeDb.reply({ affectedRows: 1 }, {}, { affectedRows: 1 }, [{ total: 14 }], boom);

        await expect(disputesRepository.resolve(credits)).rejects.toBe(boom);

        expect(resolveSteps().at(-1)).toBe('INSERT INTO credit_transactions');
        expectRolledBack();
      });
    });

    it('se uma gravação falha no meio, desfaz tudo e devolve a conexão', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({ affectedRows: 1 }, {}, boom);

      await expect(disputesRepository.resolve(base)).rejects.toBe(boom);

      expectRolledBack();
    });

    it('se o ledger falha, desfaz tudo e devolve a conexão', async () => {
      const boom = new Error('lock wait timeout');
      ledger.applyWalletEffect.mockRejectedValueOnce(boom);
      fakeDb.reply({ affectedRows: 1 }, {});

      await expect(disputesRepository.resolve(base)).rejects.toBe(boom);

      expectRolledBack();
    });
  });
});
