import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { rn029Eligible, zoneOf } from './deadline-sql';
import { milestonesRepository } from './milestones.repository';

const { applyWalletEffect } = vi.hoisted(() => ({ applyWalletEffect: vi.fn() }));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
// A carteira em R$ tem o próprio teste (wallet.ledger): aqui importa o que o repository pede a ela.
vi.mock('../wallet/wallet.ledger', () => ({ applyWalletEffect }));

/** Como o fakeDb guarda as instruções: espaços e quebras de linha reduzidos a um espaço. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const NOW = new Date('2026-10-06T15:00:00.000Z');
const HISTORY_INSERT =
  'INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note) VALUES (:contractId, :changedBy, :oldStatus, :newStatus, :note)';
/** Encerra o pedido de extensão pendente; a hora vem ANTES do status, que a segunda atribuição muda. */
const CLOSE_EXTENSION =
  "c.extension_resolved_at = IF(c.extension_status = 'pending', :now, c.extension_resolved_at), " +
  "c.extension_status = IF(c.extension_status = 'pending', 'closed', c.extension_status)";

/** As colunas do marco que o service mapeia para a API (prazo, entrega, aprovação tácita, notas). */
const MILESTONE_COLS =
  'SELECT id, contract_id, title, description, amount, freelancer_net, sort_order, status, due_at, overdue_notified_at, delivered_at, approval_due_at, delivery_note, revision_note, released_at, created_at FROM contract_milestones';

/** As primeiras palavras de cada instrução executada, para conferir a ordem. */
const steps = (words = 3): string[] =>
  fakeDb.sqls().map((s) => s.split(' ').slice(0, words).join(' '));

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
 * Repository do escrow por marcos (RN-069) sem banco: o que cada método pede (tabela, guardas do
 * WHERE, ordem, parâmetros), o que faz com a resposta e como trata a transação. Se o SQL roda no
 * MySQL é da integração (milestones-*.int.test.ts).
 */
describe('milestonesRepository', () => {
  beforeEach(() => {
    fakeDb.reset();
    applyWalletEffect.mockReset();
    applyWalletEffect.mockResolvedValue(true);
  });

  it('insertMany grava cada marco na conexão da criação do contrato, com o prazo como Date ou null', async () => {
    const conn = fakeDb.conn as unknown as PoolConnection;
    const specs = [
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

    await milestonesRepository.insertMany(conn, 31, specs);

    expect(fakeDb.calls).toHaveLength(2);
    expect(fakeDb.calls[0]!.sql).toBe(
      'INSERT INTO contract_milestones (contract_id, title, description, amount, freelancer_net, sort_order, due_at) VALUES (:contractId, :title, :description, :amount, :freelancerNet, :sortOrder, :dueAt)',
    );
    expect(fakeDb.calls[0]!.params).toEqual({
      ...specs[0],
      contractId: 31,
      dueAt: new Date('2026-10-12T02:59:59.000Z'),
    });
    expect(fakeDb.calls[1]!.params).toEqual({ ...specs[1], contractId: 31, dueAt: null });
    // Quem abre e fecha a transação é a criação do contrato.
    expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  });

  describe('leituras', () => {
    it('os marcos de um contrato vêm na ordem combinada', async () => {
      const rows = [
        { id: 5, sort_order: 0 },
        { id: 6, sort_order: 1 },
      ];
      fakeDb.reply(rows);

      expect(await milestonesRepository.listForContract(12)).toBe(rows);

      expect(fakeDb.calls[0]!.sql).toBe(
        `${MILESTONE_COLS} WHERE contract_id = :contractId ORDER BY sort_order ASC, id ASC`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ contractId: 12 });
    });

    it('um marco só é achado dentro do contrato a que pertence', async () => {
      const row = { id: 5, contract_id: 12 };
      fakeDb.reply([row], []);

      expect(await milestonesRepository.findById(12, 5)).toBe(row);
      expect(await milestonesRepository.findById(13, 5)).toBeUndefined();

      expect(fakeDb.calls[0]!.sql).toBe(
        `${MILESTONE_COLS} WHERE id = :id AND contract_id = :contractId LIMIT 1`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 5, contractId: 12 });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 5, contractId: 13 });
    });

    it('o escrow restante soma só os marcos que ainda prendem dinheiro, em números', async () => {
      fakeDb.reply([{ total: 3, price: '400.00', net: '340.00' }]);

      expect(await milestonesRepository.escrowRemaining(12)).toEqual({ price: 400, net: 340 });

      const { sql, params } = fakeDb.calls[0]!;
      // O total de marcos (de qualquer status) é o que distingue "sem marcos" de "tudo liberado".
      expect(sql.startsWith('SELECT COUNT(*) AS total,')).toBe(true);
      // Liberados e cancelados ficam de fora das duas somas.
      expect(sql).toContain(
        "COALESCE(SUM(CASE WHEN status IN ('pending', 'funded', 'delivered') THEN amount END), 0) AS price",
      );
      expect(sql).toContain(
        "COALESCE(SUM(CASE WHEN status IN ('pending', 'funded', 'delivered') THEN freelancer_net END), 0) AS net",
      );
      expect(sql.endsWith('FROM contract_milestones WHERE contract_id = :contractId')).toBe(true);
      expect(params).toEqual({ contractId: 12 });
    });

    it('contrato sem marcos devolve null (vale o valor cheio), e com tudo liberado devolve zero', async () => {
      fakeDb.reply([{ total: '0', price: '0', net: '0' }], [{ total: '2', price: '0', net: '0' }]);

      expect(await milestonesRepository.escrowRemaining(12)).toBeNull();
      expect(await milestonesRepository.escrowRemaining(13)).toEqual({ price: 0, net: 0 });
    });

    it('os títulos se dividem em entregues e faltando: só falta o marco financiado nunca entregue', async () => {
      fakeDb.reply([
        { title: 'Briefing', status: 'released', delivered_at: NOW },
        { title: 'Layout', status: 'delivered', delivered_at: NOW },
        // Voltou para revisão: guarda a data da entrega, então foi entregue.
        { title: 'Textos', status: 'funded', delivered_at: NOW },
        { title: 'Publicação', status: 'funded', delivered_at: null },
      ]);

      expect(await milestonesRepository.titlesByDelivery(12)).toEqual({
        delivered: ['Briefing', 'Layout', 'Textos'],
        missing: ['Publicação'],
      });

      const { sql, params } = fakeDb.calls[0]!;
      // Marco cancelado não entra na lista, e a ordem é a combinada.
      expect(sql).toBe(
        "SELECT title, status, delivered_at FROM contract_milestones WHERE contract_id = :contractId AND status <> 'cancelled' ORDER BY sort_order ASC, id ASC",
      );
      expect(params).toEqual({ contractId: 12 });
    });
  });

  describe('deliver', () => {
    const p = {
      contractId: 12,
      milestoneId: 5,
      changedBy: 44,
      message: 'Layout no Figma',
      now: NOW,
      approvalDueAt: new Date('2026-10-11T15:00:00.000Z'),
    };

    it('entrega o marco financiado, grava a hora da aprovação tácita e põe o contrato aceito em andamento', async () => {
      fakeDb.reply(
        [{ status: 'accepted' }],
        { affectedRows: 1 },
        [{ title: 'Layout' }],
        { affectedRows: 1 },
        { affectedRows: 0 },
        { affectedRows: 1 },
      );

      expect(await milestonesRepository.deliver(p)).toBe(true);

      expect(fakeDb.calls).toHaveLength(6);
      // O contrato é travado antes de mexer no marco.
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT status FROM contracts WHERE id = :contractId FOR UPDATE',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ contractId: 12 });

      const update = fakeDb.calls[1]!;
      expect(update.sql).toContain(
        "UPDATE contract_milestones SET status = 'delivered', delivered_at = :now, approval_due_at = :approvalDueAt, delivery_note = :message",
      );
      // Só o marco daquele contrato, e só se ainda estiver financiado.
      expect(
        update.sql.endsWith("WHERE id = :id AND contract_id = :contractId AND status = 'funded'"),
      ).toBe(true);
      expect(update.params).toEqual({
        id: 5,
        contractId: 12,
        message: 'Layout no Figma',
        now: NOW,
        approvalDueAt: p.approvalDueAt,
      });

      expect(fakeDb.calls[2]!.sql).toBe('SELECT title FROM contract_milestones WHERE id = :id');
      // O título é o do marco entregue (5), não o do contrato (12).
      expect(fakeDb.calls[2]!.params).toEqual({ id: 5 });
      expect(fakeDb.calls[3]!.sql).toBe(
        "UPDATE contracts SET status = 'in_progress' WHERE id = :contractId AND status = 'accepted'",
      );
      expect(fakeDb.calls[3]!.params).toEqual({ contractId: 12 });
      // O pedido de extensão pendente é conferido em toda entrega, também na primeira.
      expect(
        fakeDb.calls[4]!.sql.startsWith('UPDATE contracts c SET c.extension_resolved_at'),
      ).toBe(true);
      expect(fakeDb.calls[4]!.params).toEqual({ contractId: 12, now: NOW });

      // A linha do tempo diz qual marco foi entregue e com que mensagem.
      expect(fakeDb.calls[5]!.sql).toBe(HISTORY_INSERT);
      expect(fakeDb.calls[5]!.params).toEqual({
        contractId: 12,
        changedBy: 44,
        oldStatus: 'accepted',
        newStatus: 'in_progress',
        note: 'Marco «Layout» entregue: Layout no Figma',
      });
      expectCommitted();
    });

    it('sem marco nunca entregue sobrando, o pedido de extensão pendente se encerra: a RN-029 não alcança mais a contratação', async () => {
      fakeDb.reply(
        [{ status: 'in_progress' }],
        { affectedRows: 1 },
        [{ title: 'Publicação' }],
        { affectedRows: 1 },
        { affectedRows: 1 },
      );

      await milestonesRepository.deliver(p);

      const close = fakeDb.calls[3]!;
      expect(close.sql).toBe(
        `UPDATE contracts c SET ${CLOSE_EXTENSION} WHERE c.id = :contractId AND c.extension_status = 'pending' AND NOT ${flat(rn029Eligible('c'))}`,
      );
      expect(close.params).toEqual({ contractId: 12, now: NOW });
    });

    it('contrato que já estava em andamento não tem o status tocado', async () => {
      fakeDb.reply(
        [{ status: 'in_progress' }],
        { affectedRows: 1 },
        [{ title: 'Publicação' }],
        { affectedRows: 0 },
        { affectedRows: 1 },
      );

      expect(await milestonesRepository.deliver(p)).toBe(true);

      expect(
        fakeDb.sqls().some((s) => s.startsWith("UPDATE contracts SET status = 'in_progress'")),
      ).toBe(false);
      expect(fakeDb.calls[4]!.params).toMatchObject({
        oldStatus: 'in_progress',
        newStatus: 'in_progress',
      });
      expectCommitted();
    });

    it('contrato fora de aceito/em andamento (ou inexistente) não recebe entrega: desfaz e devolve false', async () => {
      for (const rows of [[{ status: 'cancelled' }], [{ status: 'disputed' }], []]) {
        fakeDb.reset();
        fakeDb.reply(rows);

        expect(await milestonesRepository.deliver(p)).toBe(false);

        // Só a leitura do contrato: o marco não é tocado.
        expect(fakeDb.calls).toHaveLength(1);
        expectRolledBack();
      }
    });

    it('marco que não está financiado (corrida, ou já entregue): desfaz e devolve false sem linha do tempo', async () => {
      fakeDb.reply([{ status: 'in_progress' }], { affectedRows: 0 });

      expect(await milestonesRepository.deliver(p)).toBe(false);

      expect(fakeDb.calls).toHaveLength(2);
      expectRolledBack();
    });

    it('erro no meio: desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([{ status: 'in_progress' }], boom);

      await expect(milestonesRepository.deliver(p)).rejects.toBe(boom);

      expectRolledBack();
    });
  });

  describe('approve', () => {
    const p = {
      contractId: 12,
      milestoneId: 5,
      changedBy: 7,
      freelancerId: 44,
      mode: 'cash' as const,
      note: null,
      now: NOW,
    };
    const milestone = { id: 5, contract_id: 12, title: 'Layout', freelancer_net: '283.33' };
    const failed = { ok: false, completed: false, net: 0, title: '' };

    it('libera só o líquido daquele marco ao freelancer e mantém o contrato em andamento enquanto há marco aberto', async () => {
      fakeDb.reply(
        [{ status: 'accepted' }],
        [milestone],
        { affectedRows: 1 },
        [{ open: 2 }],
        { affectedRows: 1 },
        { affectedRows: 1 },
      );

      expect(await milestonesRepository.approve(p)).toEqual({
        ok: true,
        completed: false,
        net: 283.33,
        title: 'Layout',
      });

      expect(steps()).toEqual([
        'SELECT status FROM',
        'SELECT id, contract_id,',
        'UPDATE contract_milestones SET',
        'SELECT COUNT(*) AS',
        'INSERT INTO contract_status_history',
        'UPDATE contracts SET',
      ]);
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT status FROM contracts WHERE id = :contractId FOR UPDATE',
      );

      // Só o marco entregue daquele contrato, travado; sem hora-limite na aprovação manual.
      const select = fakeDb.calls[1]!;
      expect(select.sql).toContain(
        "FROM contract_milestones WHERE id = :id AND contract_id = :contractId AND status = 'delivered'",
      );
      expect(select.sql.endsWith('FOR UPDATE')).toBe(true);
      expect(select.params).toEqual({ id: 5, contractId: 12, dueBy: null });

      expect(fakeDb.calls[2]!.sql).toBe(
        "UPDATE contract_milestones SET status = 'released', released_at = :now WHERE id = :id",
      );
      expect(fakeDb.calls[2]!.params).toEqual({ id: 5, now: NOW });

      // Do retido para o disponível do freelancer, com linha no extrato ligada à contratação.
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 44,
        pendingDelta: -283.33,
        balanceDelta: 283.33,
        reason: 'escrow_release',
        contractId: 12,
      });

      // Ainda prendem dinheiro: pendentes, financiados e entregues.
      expect(fakeDb.calls[3]!.sql).toBe(
        "SELECT COUNT(*) AS open FROM contract_milestones WHERE contract_id = :contractId AND status IN ('pending', 'funded', 'delivered')",
      );
      // A contagem é dos marcos do contrato (12), não do marco aprovado (5).
      expect(fakeDb.calls[3]!.params).toEqual({ contractId: 12 });
      expect(fakeDb.calls[4]!.sql).toBe(HISTORY_INSERT);
      expect(fakeDb.calls[4]!.params).toEqual({
        contractId: 12,
        changedBy: 7,
        oldStatus: 'accepted',
        newStatus: 'in_progress',
        note: 'Marco «Layout» aprovado: R$ 283,33 liberados',
      });
      // O contrato só aceito passa a em andamento.
      expect(fakeDb.calls[5]!.sql).toBe(
        "UPDATE contracts SET status = 'in_progress' WHERE id = :contractId AND status = 'accepted'",
      );
      expect(fakeDb.calls[5]!.params).toEqual({ contractId: 12 });
      expectCommitted();
    });

    it('contrato já em andamento e com marco aberto: o status do contrato não é tocado', async () => {
      fakeDb.reply([{ status: 'in_progress' }], [milestone], { affectedRows: 1 }, [{ open: 1 }], {
        affectedRows: 1,
      });

      expect(await milestonesRepository.approve(p)).toMatchObject({ ok: true, completed: false });

      expect(fakeDb.calls).toHaveLength(5);
      expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE contracts'))).toBe(false);
      expectCommitted();
    });

    it('o último marco conclui o contrato na mesma transação e encerra o pedido de extensão pendente', async () => {
      fakeDb.reply(
        [{ status: 'in_progress' }],
        [{ ...milestone, title: 'Publicação', freelancer_net: '283.34' }],
        { affectedRows: 1 },
        [{ open: '0' }],
        { affectedRows: 1 },
        { affectedRows: 1 },
      );

      expect(await milestonesRepository.approve(p)).toEqual({
        ok: true,
        completed: true,
        net: 283.34,
        title: 'Publicação',
      });

      expect(fakeDb.calls[4]!.params).toMatchObject({
        oldStatus: 'in_progress',
        newStatus: 'completed',
        note: 'Marco «Publicação» aprovado: R$ 283,34 liberados',
      });
      expect(fakeDb.calls[5]!.sql).toBe(
        `UPDATE contracts c SET c.status = 'completed', c.completed_at = :now, ${CLOSE_EXTENSION} WHERE c.id = :contractId`,
      );
      expect(fakeDb.calls[5]!.params).toEqual({ contractId: 12, now: NOW });
      expectCommitted();
    });

    it('marco único aprovado com o contrato ainda só aceito: conclui direto, sem passar por em andamento', async () => {
      fakeDb.reply(
        [{ status: 'accepted' }],
        [milestone],
        { affectedRows: 1 },
        [{ open: 0 }],
        { affectedRows: 1 },
        { affectedRows: 1 },
      );

      expect(await milestonesRepository.approve(p)).toMatchObject({ ok: true, completed: true });

      expect(fakeDb.calls).toHaveLength(6);
      expect(fakeDb.calls[4]!.params).toMatchObject({
        oldStatus: 'accepted',
        newStatus: 'completed',
      });
      expect(fakeDb.calls[5]!.sql.startsWith("UPDATE contracts c SET c.status = 'completed'")).toBe(
        true,
      );
      expect(
        fakeDb.sqls().some((s) => s.startsWith("UPDATE contracts SET status = 'in_progress'")),
      ).toBe(false);
      expectCommitted();
    });

    it('a aprovação tácita só pega o marco cuja hora gravada já passou, e a nota dela abre a linha do tempo (RN-024)', async () => {
      fakeDb.reply([{ status: 'in_progress' }], [milestone], { affectedRows: 1 }, [{ open: 1 }], {
        affectedRows: 1,
      });

      await milestonesRepository.approve({
        ...p,
        note: 'Aprovação tácita: sem resposta do cliente',
        dueBy: NOW,
      });

      const select = fakeDb.calls[1]!;
      expect(select.sql).toContain(
        'AND (:dueBy IS NULL OR (approval_due_at IS NOT NULL AND approval_due_at <= :dueBy)) FOR UPDATE',
      );
      expect(select.params).toEqual({ id: 5, contractId: 12, dueBy: NOW });
      expect(fakeDb.calls[4]!.params).toMatchObject({
        note: 'Aprovação tácita: sem resposta do cliente · Marco «Layout» aprovado: R$ 283,33 liberados',
      });
    });

    it('contrato fora de aceito/em andamento não libera nada: desfaz e devolve ok false', async () => {
      for (const rows of [[{ status: 'disputed' }], [{ status: 'cancelled' }], []]) {
        fakeDb.reset();
        fakeDb.reply(rows);

        expect(await milestonesRepository.approve(p)).toEqual(failed);

        expect(fakeDb.calls).toHaveLength(1);
        expect(applyWalletEffect).not.toHaveBeenCalled();
        expectRolledBack();
      }
    });

    it('marco que não está entregue (ou ainda dentro do prazo, na tácita): desfaz e não mexe na carteira', async () => {
      fakeDb.reply([{ status: 'in_progress' }], []);

      expect(await milestonesRepository.approve(p)).toEqual(failed);

      expect(fakeDb.calls).toHaveLength(2);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('se a carteira recusa (retido insuficiente), o marco não fica liberado: desfaz tudo', async () => {
      fakeDb.reply([{ status: 'in_progress' }], [milestone], { affectedRows: 1 });
      applyWalletEffect.mockResolvedValue(false);

      expect(await milestonesRepository.approve(p)).toEqual(failed);

      // Parou depois de marcar o marco: sem contagem, sem linha do tempo.
      expect(fakeDb.calls).toHaveLength(3);
      expectRolledBack();
    });

    it('erro no meio: desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([{ status: 'in_progress' }], [milestone], boom);

      await expect(milestonesRepository.approve(p)).rejects.toBe(boom);

      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    describe('em créditos (time-bank)', () => {
      const credits = { ...p, mode: 'credits' as const };
      const creditMilestone = { ...milestone, title: 'Visita 1', freelancer_net: '19.60' };

      it('libera créditos inteiros do retido para o disponível, com guarda e linha no extrato de créditos', async () => {
        fakeDb.reply(
          [{ status: 'in_progress' }],
          [creditMilestone],
          { affectedRows: 1 }, // marco liberado
          { affectedRows: 1 }, // carteira
          [{ total: '60' }], // saldo depois
          { affectedRows: 1 }, // extrato
          [{ open: 1 }],
          { affectedRows: 1 },
        );

        expect(await milestonesRepository.approve(credits)).toEqual({
          ok: true,
          completed: false,
          net: 20,
          title: 'Visita 1',
        });

        const wallet = fakeDb.calls[3]!;
        expect(wallet.sql).toContain(
          'UPDATE wallets SET credits_pending = credits_pending - :credits, credits_balance = credits_balance + :credits',
        );
        // Não libera mais do que está retido.
        expect(
          wallet.sql.endsWith('WHERE user_id = :userId AND credits_pending - :credits >= 0'),
        ).toBe(true);
        expect(wallet.params).toEqual({ credits: 20, userId: 44 });

        expect(fakeDb.calls[4]!.sql).toBe(
          'SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId',
        );
        // O total não muda (só troca de retido para disponível): a linha vale 0, com o saldo que ficou.
        expect(fakeDb.calls[5]!.sql).toBe(
          "INSERT INTO credit_transactions (user_id, amount, balance_after, reason, contract_id) VALUES (:userId, 0, :after, 'escrow_release', :contractId)",
        );
        expect(fakeDb.calls[5]!.params).toEqual({ userId: 44, after: 60, contractId: 12 });
        expect(fakeDb.calls[7]!.params).toMatchObject({
          note: 'Marco «Visita 1» aprovado: 20 créditos liberados',
        });
        // A carteira em R$ não entra.
        expect(applyWalletEffect).not.toHaveBeenCalled();
        expectCommitted();
      });

      it('sem créditos retidos suficientes: desfaz tudo, sem extrato', async () => {
        fakeDb.reply(
          [{ status: 'in_progress' }],
          [creditMilestone],
          { affectedRows: 1 },
          {
            affectedRows: 0,
          },
        );

        expect(await milestonesRepository.approve(credits)).toEqual(failed);

        expect(fakeDb.calls).toHaveLength(4);
        expectRolledBack();
      });
    });
  });

  describe('requestRevision', () => {
    const p = { contractId: 12, milestoneId: 5, changedBy: 7, note: 'Ajustar o topo' };

    it('o marco entregue volta a financiado com a nota, sem hora de aprovação tácita, e a linha do tempo registra o pedido', async () => {
      fakeDb.reply([{ status: 'in_progress' }], { affectedRows: 1 }, [{ title: 'Layout' }], {
        affectedRows: 1,
      });

      expect(await milestonesRepository.requestRevision(p)).toBe(true);

      expect(fakeDb.calls).toHaveLength(4);
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT status FROM contracts WHERE id = :contractId FOR UPDATE',
      );
      const update = fakeDb.calls[1]!;
      expect(update.sql).toContain(
        "UPDATE contract_milestones SET status = 'funded', revision_note = :note, approval_due_at = NULL",
      );
      // Só o marco daquele contrato, e só se estiver entregue.
      expect(
        update.sql.endsWith(
          "WHERE id = :id AND contract_id = :contractId AND status = 'delivered'",
        ),
      ).toBe(true);
      expect(update.params).toEqual({ id: 5, contractId: 12, note: 'Ajustar o topo' });
      // O título que vai para a linha do tempo é o do marco revisado (5), não o do contrato (12).
      expect(fakeDb.calls[2]!.sql).toBe('SELECT title FROM contract_milestones WHERE id = :id');
      expect(fakeDb.calls[2]!.params).toEqual({ id: 5 });

      // O status do contrato não muda: a linha do tempo repete o atual.
      expect(fakeDb.calls[3]!.sql).toBe(HISTORY_INSERT);
      expect(fakeDb.calls[3]!.params).toEqual({
        contractId: 12,
        changedBy: 7,
        oldStatus: 'in_progress',
        newStatus: 'in_progress',
        note: 'Revisão pedida no marco «Layout»: Ajustar o topo',
      });
      expectCommitted();
    });

    it('sem nota, a linha do tempo fica só com o título do marco', async () => {
      fakeDb.reply([{ status: 'in_progress' }], { affectedRows: 1 }, [{ title: 'Layout' }], {
        affectedRows: 1,
      });

      await milestonesRepository.requestRevision({ ...p, note: null });

      expect(fakeDb.calls[1]!.params).toMatchObject({ note: null });
      expect(fakeDb.calls[3]!.params).toMatchObject({ note: 'Revisão pedida no marco «Layout»' });
    });

    it('marco que não está entregue: desfaz e devolve false sem linha do tempo', async () => {
      fakeDb.reply([{ status: 'in_progress' }], { affectedRows: 0 });

      expect(await milestonesRepository.requestRevision(p)).toBe(false);

      expect(fakeDb.calls).toHaveLength(2);
      expectRolledBack();
    });

    it('erro no meio: desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([{ status: 'in_progress' }], { affectedRows: 1 }, [{ title: 'Layout' }], boom);

      await expect(milestonesRepository.requestRevision(p)).rejects.toBe(boom);

      expectRolledBack();
    });
  });

  describe('jobs de prazo dos marcos (ADR 57)', () => {
    const zones = ['America/Sao_Paulo' as const, 'America/Manaus' as const];

    it('marco atrasado: financiado, NUNCA entregue, com prazo vencido, ninguém avisado, em contrato ativo e com quem entrega de dia', async () => {
      const rows = [{ id: 5, contract_id: 12 }];
      fakeDb.reply(rows);

      expect(await milestonesRepository.findOverdueUnnoticed(NOW, zones)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      // O aviso precisa do marco, das duas partes e do fuso de cada uma.
      expect(
        sql.startsWith(
          'SELECT m.id, m.contract_id, m.title, m.due_at, c.client_id, c.freelancer_id, c.title AS contract_title,',
        ),
      ).toBe(true);
      expect(sql).toContain(
        'c.title AS contract_title, fu.timezone AS freelancer_timezone, cu.timezone AS client_timezone',
      );
      expect(sql).toContain(
        'FROM contract_milestones m JOIN contracts c ON c.id = m.contract_id JOIN users fu ON fu.id = c.freelancer_id JOIN users cu ON cu.id = c.client_id',
      );
      expect(sql).toContain("WHERE m.status = 'funded'");
      // Marco que voltou para revisão guarda a data da entrega e não entra.
      expect(sql).toContain('AND m.delivered_at IS NULL');
      expect(sql).toContain('AND m.due_at IS NOT NULL AND m.due_at < :now');
      expect(sql).toContain('AND m.overdue_notified_at IS NULL');
      expect(sql).toContain("AND c.status IN ('accepted', 'in_progress')");
      expect(sql).toContain(`AND ${zoneOf('fu.timezone')} IN (:zones)`);
      expect(sql.endsWith('ORDER BY m.due_at ASC, m.id ASC LIMIT 200')).toBe(true);
      expect(params).toEqual({ now: NOW, zones });
    });

    it('o aviso de atraso do marco só é marcado uma vez, e não depois de entregue', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(await milestonesRepository.markOverdueNotified(5, NOW)).toBe(true);
      // Outra instância já marcou, ou o marco foi entregue no meio.
      expect(await milestonesRepository.markOverdueNotified(5, NOW)).toBe(false);

      expect(fakeDb.calls[0]!.sql).toBe(
        "UPDATE contract_milestones SET overdue_notified_at = :now WHERE id = :id AND overdue_notified_at IS NULL AND status = 'funded' AND delivered_at IS NULL",
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 5, now: NOW });
    });

    it('aprovação tácita por marco (RN-024): entregue, com a hora gravada vencida, em contrato ativo e com o cliente de dia', async () => {
      const rows = [{ id: 5, contract_id: 12 }];
      fakeDb.reply(rows);

      expect(await milestonesRepository.findApprovalDue(NOW, zones)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      // A hora gravada vai junto: a nota da linha do tempo diz até quando o cliente tinha.
      expect(
        sql.startsWith(
          'SELECT m.id, m.contract_id, c.client_id, c.freelancer_id, m.approval_due_at FROM contract_milestones m JOIN contracts c ON c.id = m.contract_id JOIN users cu ON cu.id = c.client_id WHERE',
        ),
      ).toBe(true);
      expect(sql).toContain("WHERE m.status = 'delivered'");
      expect(sql).toContain('AND m.approval_due_at IS NOT NULL AND m.approval_due_at <= :now');
      expect(sql).toContain("AND c.status IN ('accepted', 'in_progress')");
      // Quem perde o direito é o cliente: vale o fuso dele.
      expect(sql).toContain(`AND ${zoneOf('cu.timezone')} IN (:zones)`);
      expect(sql.endsWith('ORDER BY m.approval_due_at ASC, m.id ASC LIMIT 200')).toBe(true);
      expect(params).toEqual({ now: NOW, zones });
    });

    it('sem nenhum fuso em que é dia, os jobs nem consultam o banco', async () => {
      expect(await milestonesRepository.findOverdueUnnoticed(NOW, [])).toEqual([]);
      expect(await milestonesRepository.findApprovalDue(NOW, [])).toEqual([]);
      expect(fakeDb.calls).toHaveLength(0);
    });
  });
});
