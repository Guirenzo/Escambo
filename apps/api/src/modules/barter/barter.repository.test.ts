import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { barterRepository, type BarterRow } from './barter.repository';

const { applyWalletEffect } = vi.hoisted(() => ({ applyWalletEffect: vi.fn() }));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../wallet/wallet.ledger', () => ({ applyWalletEffect }));

/** Marca do movimento de carteira na sequência das instruções, para conferir a ordem. */
const ledger = (reason: string): string => `ledger:${reason}`;

/**
 * A carteira entra mockada (o ledger tem o teste dele): cada efeito pedido fica registrado na
 * mesma lista das instruções SQL, e `refuse` diz quais motivos a carteira recusa (sem saldo).
 */
function walletAccepts(refuse: string[] = []): void {
  applyWalletEffect.mockImplementation(async (_conn: unknown, eff: { reason: string }) => {
    fakeDb.calls.push({ sql: ledger(eff.reason), params: eff });
    return !refuse.includes(eff.reason);
  });
}

/** Linha de barter_agreements como o MySQL devolve (DECIMAL em texto). */
function barterRow(o: Partial<Record<keyof BarterRow, unknown>> = {}): BarterRow {
  return {
    id: 5,
    proposer_id: 1,
    receiver_id: 2,
    cash_difference: '200.00',
    cash_payer_id: 2,
    platform_fee: '30.00',
    torna_status: 'held',
    status: 'proposed',
    ...o,
  } as unknown as BarterRow;
}

type Spy = { mock: { invocationCallOrder: number[] } };
/** Posição da primeira chamada do mock na ordem global do Vitest (entre todos os mocks). */
const firstOrder = (fn: Spy): number => fn.mock.invocationCallOrder[0] ?? Number.NaN;
/** Posição da última chamada entre os mocks dados. */
const lastOrder = (...fns: Spy[]): number =>
  Math.max(0, ...fns.flatMap((fn) => fn.mock.invocationCallOrder));

/**
 * A transação envolve o trabalho todo: abre antes da primeira instrução, e o desfecho (commit ou
 * rollback) vem depois da última instrução e do último movimento de carteira; a conexão só volta
 * ao pool depois do desfecho.
 */
function expectWrapped(outcome: Spy): void {
  expect(firstOrder(fakeDb.conn.beginTransaction)).toBeLessThan(firstOrder(fakeDb.pool.query));
  expect(firstOrder(outcome)).toBeGreaterThan(lastOrder(fakeDb.pool.query, applyWalletEffect));
  expect(firstOrder(fakeDb.conn.release)).toBeGreaterThan(firstOrder(outcome));
}

/**
 * Toda instrução da transação sai pela conexão dela (`conn.query`), nunca pelo pool: pelo pool
 * ela rodaria em outra conexão, fora do FOR UPDATE e do commit/rollback. O fakeDb usa a mesma
 * função nos dois, então o que distingue é em quem ela foi chamada.
 */
function expectAllOnConnection(): void {
  const contexts = fakeDb.pool.query.mock.contexts;
  expect(contexts).toHaveLength(fakeDb.pool.query.mock.calls.length);
  for (const ctx of contexts) expect(ctx).toBe(fakeDb.conn);
  // Todo movimento de carteira usa a conexão da transação, senão escaparia do rollback.
  for (const call of applyWalletEffect.mock.calls) expect(call[0]).toBe(fakeDb.conn);
}

function expectCommitted(): void {
  expectAllOnConnection();
  expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
  expectWrapped(fakeDb.conn.commit);
}

function expectRolledBack(): void {
  expectAllOnConnection();
  expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
  expectWrapped(fakeDb.conn.rollback);
}

/**
 * Repository das trocas sem banco: o que cada método pede (tabela, filtro, parâmetros), em que
 * ordem mexe na carteira, o que devolve e como fecha a transação. Se o SQL roda no MySQL é da
 * integração.
 */
describe('barterRepository', () => {
  beforeEach(() => {
    fakeDb.reset();
    applyWalletEffect.mockReset();
    walletAccepts();
  });

  describe('create', () => {
    const data = {
      ulid: '01HZX0000000000000000000AA',
      proposerId: 1,
      receiverId: 2,
      offeredServiceId: 31,
      requestedServiceId: null,
      offeredDescription: null,
      requestedDescription: 'Landing page',
      estimatedValueOffered: 600,
      estimatedValueRequested: 800,
      cashDifference: 200,
      cashPayerId: 1,
      platformFee: 30,
      tornaStatus: 'none' as const,
    };

    it('sem torna a reservar: grava a proposta, não toca na carteira e devolve o id gerado', async () => {
      fakeDb.reply({ insertId: 77, affectedRows: 1 });

      expect(await barterRepository.create({ ...data, tornaStatus: 'pending' }, null)).toBe(77);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('INSERT INTO barter_agreements');
      expect(sql).toContain(
        '(ulid, proposer_id, receiver_id, offered_service_id, requested_service_id, offered_description, requested_description, estimated_value_offered, estimated_value_requested, cash_difference, cash_payer_id, platform_fee, torna_status)',
      );
      expect(sql).toContain(
        '(:ulid, :proposerId, :receiverId, :offeredServiceId, :requestedServiceId, :offeredDescription, :requestedDescription, :estimatedValueOffered, :estimatedValueRequested, :cashDifference, :cashPayerId, :platformFee, :tornaStatus)',
      );
      expect(params).toEqual({ ...data, tornaStatus: 'pending' });
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('proponente paga a torna: reserva o valor (disponível → retido) e marca held, na mesma transação', async () => {
      fakeDb.reply({ insertId: 77, affectedRows: 1 });

      expect(await barterRepository.create(data, { userId: 1, amount: 200 })).toBe(77);

      expect(fakeDb.sqls()).toEqual([
        expect.stringContaining('INSERT INTO barter_agreements'),
        'INSERT IGNORE INTO wallets (user_id) VALUES (:userId)',
        ledger('barter_hold'),
        `UPDATE barter_agreements SET torna_status = 'held' WHERE id = :id`,
      ]);
      // A carteira é criada antes, se não existir; a reserva sai do disponível e entra no retido.
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 1 });
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 1,
        balanceDelta: -200,
        pendingDelta: 200,
        reason: 'barter_hold',
      });
      // O held vai para a proposta recém-criada.
      expect(fakeDb.calls[3]!.params).toEqual({ id: 77 });
      expectCommitted();
    });

    it('sem saldo para a torna: devolve null, desfaz a proposta e não marca held', async () => {
      walletAccepts(['barter_hold']);
      fakeDb.reply({ insertId: 77, affectedRows: 1 });

      expect(await barterRepository.create(data, { userId: 1, amount: 200 })).toBeNull();

      // Para na recusa da carteira: a proposta inserida some no rollback, e o held não é gravado.
      expect(fakeDb.sqls()).toEqual([
        expect.stringContaining('INSERT INTO barter_agreements'),
        'INSERT IGNORE INTO wallets (user_id) VALUES (:userId)',
        ledger('barter_hold'),
      ]);
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 1,
        balanceDelta: -200,
        pendingDelta: 200,
        reason: 'barter_hold',
      });
      expectRolledBack();
    });

    it('a reserva é de quem o service mandou e no valor mandado, não lida da proposta', async () => {
      fakeDb.reply({ insertId: 78, affectedRows: 1 });

      expect(await barterRepository.create(data, { userId: 9, amount: 12.34 })).toBe(78);

      expect(fakeDb.calls[1]!.params).toEqual({ userId: 9 });
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 9,
        balanceDelta: -12.34,
        pendingDelta: 12.34,
        reason: 'barter_hold',
      });
      expect(fakeDb.calls[3]!.params).toEqual({ id: 78 });
      expectCommitted();
    });

    it('erro do banco depois da reserva (ao marcar held): desfaz tudo e repassa o erro', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply({ insertId: 77, affectedRows: 1 }, { affectedRows: 1 }, boom);

      await expect(barterRepository.create(data, { userId: 1, amount: 200 })).rejects.toBe(boom);

      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expectRolledBack();
    });

    it('se o INSERT falha, desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2');
      fakeDb.reply(boom);

      await expect(barterRepository.create(data, { userId: 1, amount: 200 })).rejects.toBe(boom);

      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });
  });

  describe('leitura', () => {
    it('findById traz o acordo com os títulos dos serviços e devolve a primeira linha, ou undefined', async () => {
      const row = { id: 5, offered_title: 'Logo', requested_title: null };
      fakeDb.reply([row], []);

      expect(await barterRepository.findById(5)).toBe(row);
      expect(await barterRepository.findById(6)).toBeUndefined();

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'SELECT b.*, so.title AS offered_title, sr.title AS requested_title FROM barter_agreements b',
      );
      // LEFT JOIN: o serviço pode ter sido removido e a troca continua aparecendo.
      expect(sql).toContain('LEFT JOIN services so ON so.id = b.offered_service_id');
      expect(sql).toContain('LEFT JOIN services sr ON sr.id = b.requested_service_id');
      expect(sql).toContain('WHERE b.id = :id LIMIT 1');
      expect(params).toEqual({ id: 5 });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 6 });
      // Leitura simples: vai direto ao pool, sem abrir transação.
      expect(fakeDb.pool.query.mock.contexts[0]).toBe(fakeDb.pool);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
    });

    it('a lista traz só as trocas em que o usuário é proponente ou receptor, da mais nova para a mais antiga, paginada', async () => {
      const rows = [{ id: 9 }, { id: 5 }];
      fakeDb.reply(rows);

      expect(await barterRepository.listForUser(7, 20, 40)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('FROM barter_agreements b');
      expect(sql).toContain('LEFT JOIN services so ON so.id = b.offered_service_id');
      expect(sql).toContain('LEFT JOIN services sr ON sr.id = b.requested_service_id');
      expect(sql).toContain('WHERE b.proposer_id = :userId OR b.receiver_id = :userId');
      expect(sql).toContain('ORDER BY b.created_at DESC LIMIT 20 OFFSET 40');
      expect(params).toEqual({ userId: 7 });
      // Uma consulta só, sem transação.
      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    });

    it('lista vazia devolve um array vazio', async () => {
      fakeDb.reply([]);
      expect(await barterRepository.listForUser(7, 100, 0)).toEqual([]);
      expect(fakeDb.calls[0]!.sql).toContain('LIMIT 100 OFFSET 0');
    });

    it('canReceiveProposal confere o destinatário pelo id: conta não excluída, nem suspensa nem banida, e que não é de administrador (como na contratação, ADR 60)', async () => {
      fakeDb.reply([{ id: 2 }], []);

      expect(await barterRepository.canReceiveProposal(2)).toBe(true);
      expect(await barterRepository.canReceiveProposal(999)).toBe(false);

      const sql =
        "SELECT id FROM users WHERE id = :id AND deleted_at IS NULL AND status NOT IN ('suspended', 'banned') AND role <> 'admin' LIMIT 1";
      expect(fakeDb.calls).toEqual([
        { sql, params: { id: 2 } },
        { sql, params: { id: 999 } },
      ]);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    });

    it('findCatalogService devolve o dono em número e se o serviço está no ar, ou null se não existe ou foi removido', async () => {
      // BIGINT pode vir em texto do driver: o dono sai em número para comparar com o id do usuário.
      // is_active é TINYINT: 1 no ar, 0 pausado (às vezes em texto).
      fakeDb.reply([{ user_id: '7', is_active: 1 }], [{ user_id: 8, is_active: '0' }], []);

      expect(await barterRepository.findCatalogService(31)).toEqual({ userId: 7, isActive: true });
      expect(await barterRepository.findCatalogService(32)).toEqual({ userId: 8, isActive: false });
      expect(await barterRepository.findCatalogService(33)).toBeNull();

      const sql =
        'SELECT user_id, is_active FROM services WHERE id = :id AND deleted_at IS NULL LIMIT 1';
      expect(fakeDb.calls).toEqual([
        { sql, params: { id: 31 } },
        { sql, params: { id: 32 } },
        { sql, params: { id: 33 } },
      ]);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    });
  });

  describe('setStatusFromProposed (recusar / cancelar)', () => {
    it('trava a linha, muda o status e devolve a torna reservada ao pagador', async () => {
      fakeDb.reply([barterRow({ status: 'proposed', torna_status: 'held', cash_payer_id: 1 })]);

      expect(await barterRepository.setStatusFromProposed(5, 'rejected')).toBe(true);

      expect(fakeDb.sqls()).toEqual([
        'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        'UPDATE barter_agreements SET status = :to WHERE id = :id',
        ledger('refund'),
        `UPDATE barter_agreements SET torna_status = 'refunded' WHERE id = :id`,
      ]);
      expect(fakeDb.calls[0]!.params).toEqual({ id: 5 });
      expect(fakeDb.calls[1]!.params).toEqual({ to: 'rejected', id: 5 });
      // O valor sai do retido e volta ao disponível de quem pagou.
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 1,
        balanceDelta: 200,
        pendingDelta: -200,
        reason: 'refund',
      });
      expect(fakeDb.calls[3]!.params).toEqual({ id: 5 });
      expectCommitted();
    });

    it('torna que não chegou a ser reservada (pendente ou sem torna) não mexe na carteira', async () => {
      for (const torna_status of ['pending', 'none']) {
        fakeDb.reset();
        fakeDb.reply([barterRow({ torna_status })]);

        expect(await barterRepository.setStatusFromProposed(5, 'cancelled')).toBe(true);

        expect(fakeDb.sqls()).toEqual([
          'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
          'UPDATE barter_agreements SET status = :to WHERE id = :id',
        ]);
        expect(fakeDb.calls[1]!.params).toEqual({ to: 'cancelled', id: 5 });
        expectCommitted();
      }
      expect(applyWalletEffect).not.toHaveBeenCalled();
    });

    it('reserva sem pagador registrado não gera devolução', async () => {
      fakeDb.reply([barterRow({ torna_status: 'held', cash_payer_id: null })]);
      expect(await barterRepository.setStatusFromProposed(5, 'cancelled')).toBe(true);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('troca que não existe ou já saiu de proposed: devolve false sem alterar nada', async () => {
      for (const reply of [
        [],
        [barterRow({ status: 'active' })],
        [barterRow({ status: 'rejected' })],
      ]) {
        fakeDb.reset();
        fakeDb.reply(reply);

        expect(await barterRepository.setStatusFromProposed(5, 'rejected')).toBe(false);

        expect(fakeDb.sqls()).toEqual([
          'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        ]);
        expectRolledBack();
      }
      expect(applyWalletEffect).not.toHaveBeenCalled();
    });

    it('se a carteira recusa a devolução, desfaz a mudança de status e lança erro (não é o false de "o status mudou")', async () => {
      walletAccepts(['refund']);
      fakeDb.reply([barterRow({ torna_status: 'held' })]);

      await expect(barterRepository.setStatusFromProposed(5, 'cancelled')).rejects.toThrow(
        'Troca 5: a carteira do usuário 2 recusou a devolução da torna de 200 (retido inconsistente)',
      );

      // Para na recusa da carteira: o status trocado some no rollback, e o refunded não é gravado.
      expect(fakeDb.sqls()).toEqual([
        'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        'UPDATE barter_agreements SET status = :to WHERE id = :id',
        ledger('refund'),
      ]);
      expectRolledBack();
    });

    it('a devolução é do valor da torna do acordo, para o pagador do acordo', async () => {
      fakeDb.reply([
        barterRow({ id: 8, torna_status: 'held', cash_payer_id: 2, cash_difference: '49.90' }),
      ]);

      expect(await barterRepository.setStatusFromProposed(8, 'cancelled')).toBe(true);

      expect(fakeDb.calls[0]!.params).toEqual({ id: 8 });
      expect(fakeDb.calls[1]!.params).toEqual({ to: 'cancelled', id: 8 });
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 2,
        balanceDelta: 49.9,
        pendingDelta: -49.9,
        reason: 'refund',
      });
      expect(fakeDb.calls[3]!.params).toEqual({ id: 8 });
      expectCommitted();
    });

    it('erro do banco no meio: desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([barterRow({ torna_status: 'none' })], boom);

      await expect(barterRepository.setStatusFromProposed(5, 'rejected')).rejects.toBe(boom);

      expectRolledBack();
    });
  });

  describe('accept (RNF-038 / RN-066 / RN-067)', () => {
    const contractOffered = {
      ulid: '01HZX00000000000000000000A',
      clientId: 2,
      freelancerId: 1,
      serviceId: 31,
      title: 'Troca — entrega do proponente',
      description: 'Logo da marca',
      price: 1000,
    };
    const contractRequested = {
      ulid: '01HZX00000000000000000000B',
      clientId: 1,
      freelancerId: 2,
      serviceId: null,
      title: 'Troca — entrega do receptor',
      description: 'Landing page',
      price: 800,
    };
    const params = { agreementId: 5, acceptorId: 2, contractOffered, contractRequested };

    /** Respostas de um aceite completo: ativação, [reserva], contrato 1 + histórico, contrato 2 + histórico, vínculo. */
    const replyAccept = (withHold: boolean): void => {
      fakeDb.reply({ affectedRows: 1 });
      if (withHold) fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });
      fakeDb.reply(
        { insertId: 101, affectedRows: 1 },
        { affectedRows: 1 },
        { insertId: 102, affectedRows: 1 },
        { affectedRows: 1 },
        { affectedRows: 1 },
      );
    };

    it('ativa a troca, gera os dois contratos com o histórico e grava o vínculo, em uma transação', async () => {
      replyAccept(false);

      expect(await barterRepository.accept({ ...params, hold: null })).toEqual({
        ok: true,
        contractOfferedId: 101,
        contractRequestedId: 102,
      });

      expect(fakeDb.calls).toHaveLength(6);
      const [activate, c1, h1, c2, h2, link] = fakeDb.calls;
      // Só ativa quem ainda está proposed: é a trava contra o aceite em dobro.
      expect(activate!.sql).toBe(
        `UPDATE barter_agreements SET status = 'active', accepted_at = NOW() WHERE id = :id AND status = 'proposed'`,
      );
      expect(activate!.params).toEqual({ id: 5 });

      // Contrato de troca: já aceito, sem taxa (o líquido é o preço cheio) e preso ao acordo.
      for (const c of [c1!, c2!]) {
        expect(c.sql).toContain('INSERT INTO contracts');
        expect(c.sql).toContain(
          '(ulid, client_id, freelancer_id, service_id, title, description, price, platform_fee, freelancer_net, status, payment_mode, barter_agreement_id, accepted_at)',
        );
        expect(c.sql).toContain(
          `(:ulid, :clientId, :freelancerId, :serviceId, :title, :description, :price, 0, :price, 'accepted', 'barter', :agreementId, NOW())`,
        );
      }
      expect(c1!.params).toEqual({ ...contractOffered, agreementId: 5 });
      expect(c2!.params).toEqual({ ...contractRequested, agreementId: 5 });

      // O histórico de cada contrato nasce em 'accepted', assinado por quem aceitou.
      for (const h of [h1!, h2!]) {
        expect(h.sql).toContain(
          'INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)',
        );
        expect(h.sql).toContain(
          `VALUES (:contractId, :acceptorId, NULL, 'accepted', 'Contrato gerado pela troca')`,
        );
      }
      expect(h1!.params).toEqual({ contractId: 101, acceptorId: 2 });
      expect(h2!.params).toEqual({ contractId: 102, acceptorId: 2 });

      expect(link!.sql).toBe(
        'UPDATE barter_agreements SET contract_offered_id = :offeredId, contract_requested_id = :requestedId WHERE id = :id',
      );
      expect(link!.params).toEqual({ offeredId: 101, requestedId: 102, id: 5 });

      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('torna ainda pendente: reserva na carteira do pagador antes de gerar os contratos', async () => {
      replyAccept(true);

      const result = await barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } });

      expect(result).toEqual({ ok: true, contractOfferedId: 101, contractRequestedId: 102 });
      expect(fakeDb.sqls().map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
        'UPDATE barter_agreements SET',
        'INSERT IGNORE INTO',
        ledger('barter_hold'),
        'UPDATE barter_agreements SET',
        'INSERT INTO contracts',
        'INSERT INTO contract_status_history',
        'INSERT INTO contracts',
        'INSERT INTO contract_status_history',
        'UPDATE barter_agreements SET',
      ]);
      expect(fakeDb.calls[1]!.sql).toBe('INSERT IGNORE INTO wallets (user_id) VALUES (:userId)');
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 2 });
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 2,
        balanceDelta: -200,
        pendingDelta: 200,
        reason: 'barter_hold',
      });
      expect(fakeDb.calls[3]!.sql).toBe(
        `UPDATE barter_agreements SET torna_status = 'held' WHERE id = :id`,
      );
      expect(fakeDb.calls[3]!.params).toEqual({ id: 5 });
      expectCommitted();
    });

    it('troca que já não está proposed (aceite em corrida): conflito, sem contrato e sem reserva', async () => {
      fakeDb.reply({ affectedRows: 0 });

      expect(
        await barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).toEqual({ ok: false, reason: 'conflict' });

      expect(fakeDb.calls).toHaveLength(1);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('pagador sem saldo para a torna: desfaz a ativação e não gera contrato', async () => {
      walletAccepts(['barter_hold']);
      fakeDb.reply({ affectedRows: 1 });

      expect(
        await barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).toEqual({ ok: false, reason: 'insufficient_balance' });

      // Para na recusa da carteira: nem held, nem contrato, nem vínculo.
      expect(fakeDb.sqls()).toEqual([
        expect.stringContaining(`SET status = 'active'`),
        'INSERT IGNORE INTO wallets (user_id) VALUES (:userId)',
        ledger('barter_hold'),
      ]);
      expectRolledBack();
    });

    it('se o primeiro contrato falha, desfaz a ativação e a reserva já feita', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2');
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 }, { affectedRows: 1 }, boom);

      await expect(
        barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).rejects.toBe(boom);

      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(fakeDb.sqls().filter((s) => s.startsWith('INSERT INTO contracts'))).toHaveLength(1);
      expect(fakeDb.sqls().some((s) => s.includes('contract_status_history'))).toBe(false);
      expectRolledBack();
    });

    it('se o segundo contrato falha, desfaz tudo (nenhuma troca fica com um contrato só)', async () => {
      const boom = new Error('ER_DUP_ENTRY');
      fakeDb.reply(
        { affectedRows: 1 },
        { insertId: 101, affectedRows: 1 },
        { affectedRows: 1 },
        boom,
      );

      await expect(barterRepository.accept({ ...params, hold: null })).rejects.toBe(boom);

      expect(fakeDb.sqls().some((s) => s.includes('contract_offered_id = :offeredId'))).toBe(false);
      expectRolledBack();
    });

    it('se o histórico de um contrato falha, desfaz o contrato já inserido e a ativação', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply({ affectedRows: 1 }, { insertId: 101, affectedRows: 1 }, boom);

      await expect(barterRepository.accept({ ...params, hold: null })).rejects.toBe(boom);

      // Para no histórico do primeiro contrato: o segundo nem é tentado.
      expect(fakeDb.sqls().map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
        'UPDATE barter_agreements SET',
        'INSERT INTO contracts',
        'INSERT INTO contract_status_history',
      ]);
      expectRolledBack();
    });

    it('se gravar o vínculo falha no fim, os dois contratos e a reserva somem no rollback', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 }, { affectedRows: 1 });
      fakeDb.reply(
        { insertId: 101, affectedRows: 1 },
        { affectedRows: 1 },
        { insertId: 102, affectedRows: 1 },
        { affectedRows: 1 },
        boom,
      );

      await expect(
        barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).rejects.toBe(boom);

      // Chegou até o vínculo (última instrução) com a reserva e os dois contratos feitos.
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(fakeDb.sqls().filter((s) => s.startsWith('INSERT INTO contracts'))).toHaveLength(2);
      expect(fakeDb.sqls().at(-1)).toContain('contract_offered_id = :offeredId');
      expectRolledBack();
    });

    it('sem reserva a fazer, o aceite em corrida também é conflito e nada é gravado', async () => {
      fakeDb.reply({ affectedRows: 0 });

      expect(await barterRepository.accept({ ...params, hold: null })).toEqual({
        ok: false,
        reason: 'conflict',
      });

      expect(fakeDb.sqls()).toEqual([
        `UPDATE barter_agreements SET status = 'active', accepted_at = NOW() WHERE id = :id AND status = 'proposed'`,
      ]);
      expectRolledBack();
    });

    it('se a carteira lança erro na reserva, desfaz a ativação e repassa o erro', async () => {
      const boom = new Error('ER_LOCK_DEADLOCK');
      applyWalletEffect.mockRejectedValue(boom);
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });

      await expect(
        barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).rejects.toBe(boom);

      expect(fakeDb.sqls().some((s) => s.startsWith('INSERT INTO contracts'))).toBe(false);
      expect(fakeDb.sqls().some((s) => s.includes(`torna_status = 'held'`))).toBe(false);
      expectRolledBack();
    });
  });

  describe('completeAndRelease (liquidação da torna)', () => {
    it('receptor pagou a torna: tira do retido dele e credita torna − taxa ao proponente', async () => {
      fakeDb.reply([barterRow({ status: 'active', cash_payer_id: 2 })]);

      expect(await barterRepository.completeAndRelease(5)).toBe(true);

      expect(fakeDb.sqls()).toEqual([
        'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        `UPDATE barter_agreements SET status = 'completed', completed_at = NOW() WHERE id = :id`,
        ledger('barter_payment'),
        'INSERT IGNORE INTO wallets (user_id) VALUES (:userId)',
        ledger('barter_in'),
        `UPDATE barter_agreements SET torna_status = 'paid' WHERE id = :id`,
      ]);
      expect(fakeDb.calls[0]!.params).toEqual({ id: 5 });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 5 });
      expect(applyWalletEffect).toHaveBeenCalledTimes(2);
      // O pagador só deixa de ter o valor retido: o disponível dele já saiu na reserva.
      expect(applyWalletEffect).toHaveBeenNthCalledWith(1, fakeDb.conn, {
        userId: 2,
        balanceDelta: 0,
        pendingDelta: -200,
        reason: 'barter_payment',
      });
      // A carteira de quem recebe é criada se faltar; entra a torna menos a taxa (RN-066).
      expect(fakeDb.calls[3]!.params).toEqual({ userId: 1 });
      expect(applyWalletEffect).toHaveBeenNthCalledWith(2, fakeDb.conn, {
        userId: 1,
        balanceDelta: 170,
        pendingDelta: 0,
        reason: 'barter_in',
      });
      expect(fakeDb.calls[5]!.params).toEqual({ id: 5 });
      expectCommitted();
    });

    it('proponente pagou a torna: quem recebe é o receptor', async () => {
      fakeDb.reply([barterRow({ status: 'active', cash_payer_id: 1 })]);

      expect(await barterRepository.completeAndRelease(5)).toBe(true);

      expect(applyWalletEffect).toHaveBeenNthCalledWith(
        1,
        fakeDb.conn,
        expect.objectContaining({ userId: 1, pendingDelta: -200, reason: 'barter_payment' }),
      );
      expect(fakeDb.calls[3]!.params).toEqual({ userId: 2 });
      expect(applyWalletEffect).toHaveBeenNthCalledWith(
        2,
        fakeDb.conn,
        expect.objectContaining({ userId: 2, balanceDelta: 170, reason: 'barter_in' }),
      );
      expect(applyWalletEffect).toHaveBeenCalledTimes(2);
      expect(fakeDb.sqls().at(-1)).toBe(
        `UPDATE barter_agreements SET torna_status = 'paid' WHERE id = :id`,
      );
      expectCommitted();
    });

    it('o crédito é arredondado em centavos e nunca fica negativo', async () => {
      // 0.30 − 0.10 em ponto flutuante dá 0.19999999999999998: o crédito tem de ser 0.2.
      fakeDb.reply([
        barterRow({ status: 'active', cash_difference: '0.30', platform_fee: '0.10' }),
      ]);
      await barterRepository.completeAndRelease(5);
      expect(applyWalletEffect.mock.calls[1]![1]).toMatchObject({ balanceDelta: 0.2 });

      // Taxa maior que a torna (acordo inconsistente): credita zero, não debita quem recebe.
      fakeDb.reset();
      applyWalletEffect.mockClear();
      fakeDb.reply([
        barterRow({ status: 'active', cash_difference: '10.00', platform_fee: '15.00' }),
      ]);
      await barterRepository.completeAndRelease(5);
      expect(applyWalletEffect.mock.calls[0]![1]).toMatchObject({ pendingDelta: -10 });
      expect(applyWalletEffect.mock.calls[1]![1]).toMatchObject({ balanceDelta: 0 });
    });

    it('troca sem torna reservada: só conclui, sem mexer em carteira', async () => {
      for (const o of [
        { torna_status: 'none', cash_payer_id: null, cash_difference: '0.00' },
        { torna_status: 'pending', cash_payer_id: 2 },
        { torna_status: 'held', cash_payer_id: null },
      ]) {
        fakeDb.reset();
        fakeDb.reply([barterRow({ status: 'active', ...o })]);

        expect(await barterRepository.completeAndRelease(5)).toBe(true);

        expect(fakeDb.sqls()).toEqual([
          'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
          `UPDATE barter_agreements SET status = 'completed', completed_at = NOW() WHERE id = :id`,
        ]);
        expectCommitted();
      }
      expect(applyWalletEffect).not.toHaveBeenCalled();
    });

    it('troca que não existe ou não está ativa: devolve false sem concluir (não liquida duas vezes)', async () => {
      for (const reply of [
        [],
        [barterRow({ status: 'completed' })],
        [barterRow({ status: 'proposed' })],
      ]) {
        fakeDb.reset();
        fakeDb.reply(reply);

        expect(await barterRepository.completeAndRelease(5)).toBe(false);

        expect(fakeDb.sqls()).toEqual([
          'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        ]);
        expectRolledBack();
      }
      expect(applyWalletEffect).not.toHaveBeenCalled();
    });

    it('se a carteira recusa a baixa do pagador ou o crédito de quem recebe, desfaz e lança erro (não é o false de "já concluída")', async () => {
      for (const refused of ['barter_payment', 'barter_in']) {
        fakeDb.reset();
        walletAccepts([refused]);
        fakeDb.reply([barterRow({ status: 'active' })]);

        await expect(barterRepository.completeAndRelease(5), refused).rejects.toThrow(
          'Troca 5: a carteira recusou a liquidação da torna de 200 (retido inconsistente)',
        );

        // A conclusão já gravada some no rollback, e o paid não chega a ser gravado.
        expect(fakeDb.sqls()).toEqual([
          'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
          `UPDATE barter_agreements SET status = 'completed', completed_at = NOW() WHERE id = :id`,
          ledger('barter_payment'),
          'INSERT IGNORE INTO wallets (user_id) VALUES (:userId)',
          ledger('barter_in'),
        ]);
        expectRolledBack();
      }
    });

    it('erro do banco no meio: desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply([barterRow({ status: 'active' })], boom);

      await expect(barterRepository.completeAndRelease(5)).rejects.toBe(boom);

      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });
  });

  describe('disputeAndRefund (RN-067)', () => {
    it('põe a troca ativa em disputa e devolve a torna reservada ao pagador', async () => {
      fakeDb.reply([barterRow({ status: 'active', torna_status: 'held', cash_payer_id: 2 })]);

      expect(await barterRepository.disputeAndRefund(5)).toBe(true);

      expect(fakeDb.sqls()).toEqual([
        'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        `UPDATE barter_agreements SET status = 'disputed' WHERE id = :id`,
        ledger('refund'),
        `UPDATE barter_agreements SET torna_status = 'refunded' WHERE id = :id`,
      ]);
      expect(fakeDb.calls[0]!.params).toEqual({ id: 5 });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 5 });
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 2,
        balanceDelta: 200,
        pendingDelta: -200,
        reason: 'refund',
      });
      expect(fakeDb.calls[3]!.params).toEqual({ id: 5 });
      expectCommitted();
    });

    it('troca sem torna reservada entra em disputa sem mexer em carteira', async () => {
      fakeDb.reply([barterRow({ status: 'active', torna_status: 'none', cash_payer_id: null })]);

      expect(await barterRepository.disputeAndRefund(5)).toBe(true);

      expect(fakeDb.sqls()).toEqual([
        'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        `UPDATE barter_agreements SET status = 'disputed' WHERE id = :id`,
      ]);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('troca que não existe ou não está ativa: devolve false sem alterar nada', async () => {
      for (const reply of [
        [],
        [barterRow({ status: 'disputed' })],
        [barterRow({ status: 'proposed' })],
      ]) {
        fakeDb.reset();
        fakeDb.reply(reply);

        expect(await barterRepository.disputeAndRefund(5)).toBe(false);

        expect(fakeDb.sqls()).toEqual([
          'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        ]);
        expectRolledBack();
      }
      expect(applyWalletEffect).not.toHaveBeenCalled();
    });

    it('se a carteira recusa a devolução, a troca não entra em disputa e o erro sobe (não é o false de "não está ativa")', async () => {
      walletAccepts(['refund']);
      fakeDb.reply([barterRow({ status: 'active' })]);

      await expect(barterRepository.disputeAndRefund(5)).rejects.toThrow(
        'Troca 5: a carteira do usuário 2 recusou a devolução da torna de 200 (retido inconsistente)',
      );

      expect(fakeDb.sqls()).toEqual([
        'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
        `UPDATE barter_agreements SET status = 'disputed' WHERE id = :id`,
        ledger('refund'),
      ]);
      expectRolledBack();
    });

    it('torna ainda pendente (nunca reservada) não é devolvida: a carteira não tem o que soltar', async () => {
      fakeDb.reply([barterRow({ status: 'active', torna_status: 'pending', cash_payer_id: 2 })]);

      expect(await barterRepository.disputeAndRefund(5)).toBe(true);

      expect(applyWalletEffect).not.toHaveBeenCalled();
      expect(fakeDb.sqls().some((s) => s.includes('torna_status'))).toBe(false);
      expectCommitted();
    });

    it('erro do banco no meio: desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([barterRow({ status: 'active' })], boom);

      await expect(barterRepository.disputeAndRefund(5)).rejects.toBe(boom);

      expectRolledBack();
    });
  });
});
