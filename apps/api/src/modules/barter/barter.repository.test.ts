import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { lockWalletRows, lockWalletUsers, lockWallets } from '../wallet/wallet.locks';
import { barterRepository, type BarterRow } from './barter.repository';

const { applyWalletEffect } = vi.hoisted(() => ({ applyWalletEffect: vi.fn() }));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../wallet/wallet.locks', () => ({
  lockWalletRows: vi.fn(),
  lockWalletUsers: vi.fn(),
  lockWallets: vi.fn(),
}));
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
  const firstWork = fakeDb.pool.query.mock.invocationCallOrder.find(
    (order) => order > firstOrder(fakeDb.conn.beginTransaction),
  );
  expect(firstWork).toBeDefined();
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
  contexts.forEach((ctx, i) => {
    const order = fakeDb.pool.query.mock.invocationCallOrder[i]!;
    expect(ctx).toBe(order < firstOrder(fakeDb.conn.beginTransaction) ? fakeDb.pool : fakeDb.conn);
  });
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
    for (const lock of [lockWalletRows, lockWalletUsers, lockWallets])
      vi.mocked(lock).mockReset().mockResolvedValue(undefined);
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
      offeredValueSource: 'catalog' as const,
      requestedValueSource: 'informed' as const,
      cashDifference: 200,
      cashPayerId: 1,
      platformFee: 30,
      tornaStatus: 'none' as const,
    };

    it('grava de onde veio o valor de cada lado (RF-084)', async () => {
      fakeDb.reply({ insertId: 77 });
      await barterRepository.create(data, null);
      expect(fakeDb.calls[0]!.sql).toContain(
        'estimated_value_offered, estimated_value_requested, offered_value_source, requested_value_source,',
      );
      expect(fakeDb.calls[0]!.sql).toContain(
        ':estimatedValueOffered, :estimatedValueRequested, :offeredValueSource, :requestedValueSource,',
      );
    });

    it('sem torna: grava só a proposta, sem criar nem tocar carteira', async () => {
      fakeDb.reply({ insertId: 77 });
      expect(await barterRepository.create(data, null)).toBe(77);
      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.params).toEqual(data);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('torna: garante a carteira antes da conexão e reserva proposta e saldo juntos', async () => {
      fakeDb.reply({}, { insertId: 77 }, { affectedRows: 1 });
      expect(await barterRepository.create(data, { userId: 9, amount: 12.34 })).toBe(77);
      expect(lockWalletUsers).toHaveBeenCalledExactlyOnceWith(
        fakeDb.conn,
        expect.arrayContaining([1, 2, 9]),
      );
      expect(lockWalletRows).toHaveBeenCalledExactlyOnceWith(fakeDb.conn, [9]);
      expect(firstOrder(vi.mocked(lockWalletUsers))).toBeLessThan(
        fakeDb.conn.query.mock.invocationCallOrder[1]!,
      );
      expect(firstOrder(vi.mocked(lockWalletUsers))).toBeLessThan(
        firstOrder(vi.mocked(lockWalletRows)),
      );
      expect(firstOrder(vi.mocked(lockWalletRows))).toBeLessThan(firstOrder(applyWalletEffect));
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 9 });
      expect(fakeDb.sqls().map((sql) => sql.split(' ').slice(0, 3).join(' '))).toEqual([
        'INSERT IGNORE INTO',
        'INSERT INTO barter_agreements',
        ledger('barter_hold'),
        'UPDATE barter_agreements SET',
      ]);
      expect(fakeDb.pool.query.mock.invocationCallOrder[0]!).toBeLessThan(
        firstOrder(fakeDb.pool.getConnection),
      );
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 9,
        balanceDelta: -12.34,
        pendingDelta: 12.34,
        reason: 'barter_hold',
      });
      expect(fakeDb.calls[3]!.params).toEqual({ id: 77 });
      expectCommitted();
    });

    it('sem saldo: desfaz a proposta e não marca held nem grava contrato', async () => {
      walletAccepts(['barter_hold']);
      fakeDb.reply({}, { insertId: 77 });
      expect(await barterRepository.create(data, { userId: 1, amount: 200 })).toBeNull();
      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.sqls().some((sql) => sql.startsWith('UPDATE'))).toBe(false);
      expectRolledBack();
    });

    it('erro depois da reserva desfaz proposta e movimento juntos', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply({}, { insertId: 77 }, boom);
      await expect(barterRepository.create(data, { userId: 1, amount: 200 })).rejects.toBe(boom);
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expectRolledBack();
    });

    it('erro ao inserir proposta desfaz a transação e devolve a conexão', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2');
      fakeDb.reply({}, boom);
      await expect(barterRepository.create(data, { userId: 1, amount: 200 })).rejects.toBe(boom);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('falha ao garantir carteira não ocupa conexão nem inicia transação', async () => {
      const boom = new Error('ensure');
      fakeDb.reply(boom);
      await expect(barterRepository.create(data, { userId: 1, amount: 200 })).rejects.toBe(boom);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
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

    it('findCatalogService devolve o dono em número, se o serviço está no ar e o preço, ou null se não existe ou foi removido', async () => {
      // BIGINT pode vir em texto do driver: o dono sai em número para comparar com o id do usuário.
      // is_active é TINYINT: 1 no ar, 0 pausado (às vezes em texto). DECIMAL vem em texto.
      fakeDb.reply(
        [{ user_id: '7', is_active: 1, price_type: 'fixed', price: '300.50' }],
        [{ user_id: 8, is_active: '0', price_type: 'negotiable', price: null }],
        [],
      );

      expect(await barterRepository.findCatalogService(31)).toEqual({
        userId: 7,
        isActive: true,
        priceType: 'fixed',
        price: 300.5,
      });
      expect(await barterRepository.findCatalogService(32)).toEqual({
        userId: 8,
        isActive: false,
        priceType: 'negotiable',
        price: null,
      });
      expect(await barterRepository.findCatalogService(33)).toBeNull();

      const sql =
        'SELECT user_id, is_active, price_type, price FROM services WHERE id = :id AND deleted_at IS NULL LIMIT 1';
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
    const params = {
      agreementId: 5,
      acceptorId: 2,
      contractOffered,
      contractRequested,
      source: 'user' as const,
    };

    const replyAccept = (withHold: boolean): void => {
      if (withHold) fakeDb.reply({});
      fakeDb.reply({ affectedRows: 1 });
      if (withHold) fakeDb.reply({ affectedRows: 1 });
      fakeDb.reply({ insertId: 101 }, {}, { insertId: 102 }, {}, {});
    };

    it('sem reserva nova: ativa, cria dois contratos com histórico e vincula tudo na mesma transação', async () => {
      replyAccept(false);
      expect(await barterRepository.accept({ ...params, hold: null })).toEqual({
        ok: true,
        contractOfferedId: 101,
        contractRequestedId: 102,
      });
      expect(fakeDb.calls).toHaveLength(6);
      expect(fakeDb.calls[0]!.sql).toContain("WHERE id = :id AND status = 'proposed'");
      expect(fakeDb.calls[1]!.params).toEqual({
        ...contractOffered,
        agreementId: 5,
        revisionLimit: 2,
      });
      expect(fakeDb.calls[3]!.params).toEqual({
        ...contractRequested,
        agreementId: 5,
        revisionLimit: 2,
      });
      // Os dois contratos nascem no histórico em nome de quem aceitou, como ação dele.
      expect(fakeDb.calls[2]!.sql).toContain(
        "VALUES (:contractId, :acceptorId, NULL, 'accepted', 'Contrato gerado pela troca', :source)",
      );
      expect(fakeDb.calls[2]!.params).toEqual({ contractId: 101, acceptorId: 2, source: 'user' });
      expect(fakeDb.calls[4]!.params).toEqual({ contractId: 102, acceptorId: 2, source: 'user' });
      expect(fakeDb.calls[5]!.params).toEqual({ offeredId: 101, requestedId: 102, id: 5 });
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('torna pendente: garante carteira antes da conexão, reserva antes dos contratos', async () => {
      replyAccept(true);
      expect(
        await barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).toEqual({ ok: true, contractOfferedId: 101, contractRequestedId: 102 });
      expect(fakeDb.calls).toHaveLength(9);
      expect(lockWalletUsers).toHaveBeenCalledExactlyOnceWith(
        fakeDb.conn,
        expect.arrayContaining([1, 2]),
      );
      expect(lockWalletRows).toHaveBeenCalledExactlyOnceWith(fakeDb.conn, [2]);
      expect(fakeDb.conn.query.mock.invocationCallOrder[1]!).toBeLessThan(
        firstOrder(vi.mocked(lockWalletUsers)),
      );
      expect(firstOrder(vi.mocked(lockWalletUsers))).toBeLessThan(
        firstOrder(vi.mocked(lockWalletRows)),
      );
      expect(firstOrder(vi.mocked(lockWalletRows))).toBeLessThan(firstOrder(applyWalletEffect));
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 2 });
      expect(firstOrder(fakeDb.pool.query)).toBeLessThan(firstOrder(fakeDb.pool.getConnection));
      expect(fakeDb.calls[3]!.params).toEqual({ id: 5 });
      expect(applyWalletEffect).toHaveBeenCalledWith(fakeDb.conn, {
        userId: 2,
        balanceDelta: -200,
        pendingDelta: 200,
        reason: 'barter_hold',
      });
      expectCommitted();
    });

    it('aceite concorrente não ativa duas vezes nem reserva a torna duas vezes', async () => {
      fakeDb.reply({}, { affectedRows: 0 });
      expect(
        await barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).toEqual({ ok: false, reason: 'conflict' });
      expect(fakeDb.calls).toHaveLength(2);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('pagador sem saldo desfaz a ativação e não gera contrato', async () => {
      walletAccepts(['barter_hold']);
      fakeDb.reply({}, { affectedRows: 1 });
      expect(
        await barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).toEqual({ ok: false, reason: 'insufficient_balance' });
      expect(fakeDb.calls).toHaveLength(3);
      expectRolledBack();
    });

    it('erro na reserva, contrato ou vínculo desfaz todo o aceite', async () => {
      for (const stage of ['hold', 'contract', 'link']) {
        fakeDb.reset();
        walletAccepts();
        const boom = new Error(stage);
        if (stage === 'hold') {
          fakeDb.reply({}, { affectedRows: 1 });
          applyWalletEffect.mockRejectedValueOnce(boom);
        } else {
          fakeDb.reply({}, { affectedRows: 1 }, {});
          if (stage === 'link') fakeDb.reply({ insertId: 101 }, {}, { insertId: 102 }, {});
          fakeDb.reply(boom);
        }
        await expect(
          barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
        ).rejects.toBe(boom);
        expectRolledBack();
      }
    });

    it('falha ao garantir carteira não inicia a transação de aceite', async () => {
      const boom = new Error('ensure');
      fakeDb.reply(boom);
      await expect(
        barterRepository.accept({ ...params, hold: { userId: 2, amount: 200 } }),
      ).rejects.toBe(boom);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    });
  });

  describe('completeAndRelease (liquidação da torna)', () => {
    const ready = (row: BarterRow) => {
      fakeDb.reply([row]);
      if (row.cash_payer_id) fakeDb.reply({});
      fakeDb.reply([row], {});
    };

    it('as partes imutáveis e a carteira de quem recebe são preparadas antes da conexão', async () => {
      ready(barterRow({ status: 'active' }));
      expect(await barterRepository.completeAndRelease(5)).toBe(true);
      expect(lockWallets).toHaveBeenCalledExactlyOnceWith(fakeDb.conn, [2, 1]);
      expect(fakeDb.conn.query.mock.invocationCallOrder[2]!).toBeLessThan(
        firstOrder(vi.mocked(lockWallets)),
      );
      expect(firstOrder(vi.mocked(lockWallets))).toBeLessThan(firstOrder(applyWalletEffect));
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT proposer_id, receiver_id, cash_payer_id FROM barter_agreements WHERE id = :id',
      );
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 1 });
      expect(fakeDb.pool.query.mock.invocationCallOrder[1]!).toBeLessThan(
        firstOrder(fakeDb.pool.getConnection),
      );
      expect(fakeDb.calls[2]!.sql).toBe(
        'SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE',
      );
      expect(applyWalletEffect).toHaveBeenNthCalledWith(1, fakeDb.conn, {
        userId: 2,
        balanceDelta: 0,
        pendingDelta: -200,
        reason: 'barter_payment',
      });
      expect(applyWalletEffect).toHaveBeenNthCalledWith(2, fakeDb.conn, {
        userId: 1,
        balanceDelta: 170,
        pendingDelta: 0,
        reason: 'barter_in',
      });
      expect(fakeDb.sqls().at(-1)).toContain("torna_status = 'paid'");
      expectCommitted();
    });

    it('se proponente paga, o receptor recebe a torna menos a taxa', async () => {
      ready(barterRow({ status: 'active', cash_payer_id: 1 }));
      expect(await barterRepository.completeAndRelease(5)).toBe(true);
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 2 });
      expect(applyWalletEffect).toHaveBeenNthCalledWith(
        1,
        fakeDb.conn,
        expect.objectContaining({ userId: 1, pendingDelta: -200 }),
      );
      expect(applyWalletEffect).toHaveBeenNthCalledWith(
        2,
        fakeDb.conn,
        expect.objectContaining({ userId: 2, balanceDelta: 170 }),
      );
      expectCommitted();
    });

    it('arredonda o crédito em centavos e não debita o destinatário quando a taxa é inconsistente', async () => {
      for (const [amount, fee, net] of [
        ['0.30', '0.10', 0.2],
        ['10.00', '15.00', 0],
      ] as const) {
        fakeDb.reset();
        applyWalletEffect.mockClear();
        ready(barterRow({ status: 'active', cash_difference: amount, platform_fee: fee }));
        expect(await barterRepository.completeAndRelease(5)).toBe(true);
        expect(applyWalletEffect.mock.calls[1]![1]).toMatchObject({ balanceDelta: net });
      }
    });

    it('sem pagador ou torna não retida, conclui sem movimentar saldo', async () => {
      for (const overrides of [
        { cash_payer_id: null, torna_status: 'none' },
        { cash_payer_id: 2, torna_status: 'pending' },
      ]) {
        fakeDb.reset();
        ready(barterRow({ status: 'active', ...overrides }));
        expect(await barterRepository.completeAndRelease(5)).toBe(true);
        expect(applyWalletEffect).not.toHaveBeenCalled();
        expectCommitted();
      }
    });

    it('acordo ausente não ocupa conexão', async () => {
      fakeDb.reply([]);
      expect(await barterRepository.completeAndRelease(5)).toBe(false);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
      expect(applyWalletEffect).not.toHaveBeenCalled();
    });

    it('confere o estado novamente sob trava e não liquida duas vezes', async () => {
      fakeDb.reply([barterRow({ status: 'active' })], {}, [barterRow({ status: 'completed' })]);
      expect(await barterRepository.completeAndRelease(5)).toBe(false);
      expect(applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('recusa do débito ou do crédito desfaz conclusão e os dois movimentos', async () => {
      for (const reason of ['barter_payment', 'barter_in']) {
        fakeDb.reset();
        walletAccepts([reason]);
        ready(barterRow({ status: 'active' }));
        await expect(barterRepository.completeAndRelease(5)).rejects.toThrow(
          'retido inconsistente',
        );
        expect(fakeDb.sqls().at(-1)).toBe(ledger('barter_in'));
        expectRolledBack();
      }
    });

    it('falha na preparação não ocupa conexão; falha na trava desfaz a transação', async () => {
      for (const stage of ['read', 'ensure', 'lock']) {
        fakeDb.reset();
        const boom = new Error(stage);
        if (stage !== 'read') fakeDb.reply([barterRow({ status: 'active' })]);
        if (stage === 'lock') fakeDb.reply({});
        fakeDb.reply(boom);
        await expect(barterRepository.completeAndRelease(5)).rejects.toBe(boom);
        if (stage === 'lock') expectRolledBack();
        else expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
      }
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
