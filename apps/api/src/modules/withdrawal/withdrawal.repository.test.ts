import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { withdrawalRepository } from './withdrawal.repository';

const { ledger } = vi.hoisted(() => ({
  ledger: { applyWalletEffect: vi.fn(), recordWalletTx: vi.fn() },
}));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../wallet/wallet.ledger', () => ledger);

/** Marcas do ledger de R$ na sequência de instruções, para conferir a ordem junto com o SQL. */
const WALLET_EFFECT = 'ledger:applyWalletEffect';
const WALLET_TX = 'ledger:recordWalletTx';

/** As três primeiras palavras de cada instrução: a ordem do que a transação faz. */
const steps = (): string[] => fakeDb.sqls().map((s) => s.split(' ').slice(0, 3).join(' '));

const COLUMNS =
  'w.id, w.user_id, w.amount, w.status, w.pix_key, w.bank_name, w.bank_agency, w.bank_account, w.gateway_ref, w.created_at, w.processed_at';
const HOLDER_JOINS =
  'FROM withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN profiles_freelancer fp ON fp.user_id = w.user_id LEFT JOIN profiles_client cp ON cp.user_id = w.user_id';

/** A ordem global de chamada (a do vitest) de tudo o que a transação executou: SQL e ledger. */
const workOrder = (): number[] =>
  [fakeDb.conn.query, ledger.applyWalletEffect, ledger.recordWalletTx].flatMap(
    (m) => m.mock.invocationCallOrder,
  );
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
 * Repository dos saques sem banco: o que cada método pede, em que ordem, e como fecha a transação.
 * O ledger de R$ entra mockado (tem os próprios testes); se o SQL roda no MySQL é da integração.
 */
describe('withdrawalRepository', () => {
  beforeEach(() => {
    fakeDb.reset();
    ledger.applyWalletEffect.mockReset().mockImplementation(async (_conn, effect) => {
      fakeDb.calls.push({ sql: WALLET_EFFECT, params: effect });
      return true;
    });
    ledger.recordWalletTx.mockReset().mockImplementation(async (_conn, effect) => {
      fakeDb.calls.push({ sql: WALLET_TX, params: effect });
    });
  });

  describe('createIfSufficient (RN-034, RNF-038)', () => {
    const params = {
      userId: 7,
      amount: 100,
      pixKey: 'chave@escambo.test',
      bankName: null,
      bankAgency: null,
      bankAccount: null,
    };

    it('debita o saldo, grava o saque e a linha do extrato na mesma transação, nessa ordem', async () => {
      fakeDb.reply({ affectedRows: 0 }, [{ id: 31 }], { insertId: 77, affectedRows: 1 });

      expect(await withdrawalRepository.createIfSufficient(params)).toBe(77);

      expect(steps()).toEqual([
        'INSERT IGNORE INTO',
        'SELECT id FROM',
        WALLET_EFFECT,
        'INSERT INTO withdrawals',
        WALLET_TX,
      ]);
      // Garante a carteira de quem nunca teve uma, sem duplicar a de quem já tem.
      expect(fakeDb.calls[0]!.sql).toBe('INSERT IGNORE INTO wallets (user_id) VALUES (:userId)');
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
      expect(fakeDb.calls[1]!.sql).toBe('SELECT id FROM wallets WHERE user_id = :userId LIMIT 1');
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 7 });

      // O débito sai do disponível, sem mexer no retido; a linha do extrato vem depois, com o id do saque.
      expect(fakeDb.calls[2]!.params).toStrictEqual({
        userId: 7,
        balanceDelta: -100,
        pendingDelta: 0,
      });

      expect(fakeDb.calls[3]!.sql).toContain(
        'INSERT INTO withdrawals (user_id, wallet_id, amount, bank_name, bank_agency, bank_account, pix_key) VALUES (:userId, :walletId, :amount, :bankName, :bankAgency, :bankAccount, :pixKey)',
      );
      expect(fakeDb.calls[3]!.params).toEqual({
        userId: 7,
        walletId: 31,
        amount: 100,
        bankName: null,
        bankAgency: null,
        bankAccount: null,
        pixKey: 'chave@escambo.test',
      });

      expect(fakeDb.calls[4]!.params).toEqual({
        userId: 7,
        balanceDelta: -100,
        pendingDelta: 0,
        reason: 'withdrawal',
        withdrawalId: 77,
      });
      // Débito e extrato usam a conexão da transação.
      expect(ledger.applyWalletEffect.mock.calls[0]![0]).toBe(fakeDb.conn);
      expect(ledger.recordWalletTx.mock.calls[0]![0]).toBe(fakeDb.conn);
      expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
      expectCommitted();
    });

    it('saque para conta bancária grava os dados do banco e a chave PIX nula', async () => {
      fakeDb.reply({}, [{ id: '31' }], { insertId: 78 });

      await withdrawalRepository.createIfSufficient({
        userId: 7,
        amount: 250.75,
        pixKey: null,
        bankName: 'Banco do Brasil',
        bankAgency: '0001',
        bankAccount: '12345-6',
      });

      // O id da carteira vai como número, mesmo que o driver devolva texto.
      expect(fakeDb.calls[3]!.params).toEqual({
        userId: 7,
        walletId: 31,
        amount: 250.75,
        bankName: 'Banco do Brasil',
        bankAgency: '0001',
        bankAccount: '12345-6',
        pixKey: null,
      });
      expect(fakeDb.calls[2]!.params).toMatchObject({ balanceDelta: -250.75 });
      expect(fakeDb.calls[4]!.params).toMatchObject({ balanceDelta: -250.75, withdrawalId: 78 });
    });

    it('saldo insuficiente: devolve null, não cria o saque nem a linha do extrato', async () => {
      ledger.applyWalletEffect.mockResolvedValueOnce(false);
      fakeDb.reply({}, [{ id: 31 }]);

      expect(await withdrawalRepository.createIfSufficient(params)).toBeNull();

      expect(steps()).toEqual(['INSERT IGNORE INTO', 'SELECT id FROM']);
      expect(ledger.recordWalletTx).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('se a gravação do saque falha, o débito é desfeito e a conexão volta', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({}, [{ id: 31 }], boom);

      await expect(withdrawalRepository.createIfSufficient(params)).rejects.toBe(boom);

      expect(ledger.recordWalletTx).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('se o extrato falha, o saque já gravado também é desfeito', async () => {
      const boom = new Error('lock wait timeout');
      ledger.recordWalletTx.mockRejectedValueOnce(boom);
      fakeDb.reply({}, [{ id: 31 }], { insertId: 77 });

      await expect(withdrawalRepository.createIfSufficient(params)).rejects.toBe(boom);

      expectRolledBack();
    });

    it('se o débito falha por erro do banco (não por saldo), o erro sobe e nenhum saque é criado', async () => {
      const boom = new Error('deadlock');
      ledger.applyWalletEffect.mockRejectedValueOnce(boom);
      fakeDb.reply({}, [{ id: 31 }]);

      await expect(withdrawalRepository.createIfSufficient(params)).rejects.toBe(boom);

      expect(steps()).toEqual(['INSERT IGNORE INTO', 'SELECT id FROM']);
      expect(ledger.recordWalletTx).not.toHaveBeenCalled();
      expectRolledBack();
    });
  });

  it('findById devolve a primeira linha, ou undefined', async () => {
    const row = { id: 42, user_id: 7, status: 'requested' };
    fakeDb.reply([row], []);

    expect(await withdrawalRepository.findById(42)).toBe(row);
    expect(await withdrawalRepository.findById(43)).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toBe(
      `SELECT ${COLUMNS} FROM withdrawals w WHERE w.id = :id LIMIT 1`,
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 42 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 43 });
  });

  it('a lista do titular só traz os saques dele, do mais novo para o mais antigo, paginada', async () => {
    const rows = [{ id: 2 }, { id: 1 }];
    fakeDb.reply(rows);

    expect(await withdrawalRepository.listForUser(7, 20, 40)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    // O id desempata saques criados no mesmo segundo, para a paginação não repetir nem pular linha.
    expect(sql.startsWith(`SELECT ${COLUMNS} FROM withdrawals w `)).toBe(true);
    expect(sql).toMatch(
      /FROM withdrawals w WHERE w\.user_id = :userId ORDER BY w\.created_at DESC, w\.id DESC LIMIT 20 OFFSET 40$/,
    );
    expect(params).toEqual({ userId: 7 });
    expect(fakeDb.calls).toHaveLength(1);
  });

  it('a lista do titular sem saques devolve lista vazia; a primeira página não tem deslocamento', async () => {
    expect(await withdrawalRepository.listForUser(8, 50, 0)).toEqual([]);
    expect(fakeDb.calls[0]!.sql).toMatch(/WHERE w\.user_id = :userId .* LIMIT 50 OFFSET 0$/);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 8 });
  });

  describe('listForAdmin (fila do admin)', () => {
    it('traz os saques nos status pedidos, do mais antigo para o mais novo, com o titular', async () => {
      const rows = [{ id: 1 }, { id: 2 }];
      fakeDb.reply(rows);

      expect(await withdrawalRepository.listForAdmin(['requested', 'processing'], 200)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(HOLDER_JOINS);
      // O nome vem do perfil de freelancer, ou do de cliente quando não há.
      expect(sql).toContain(
        'u.ulid AS user_ulid, u.email AS user_email, COALESCE(fp.full_name, cp.full_name) AS user_name',
      );
      expect(sql).toMatch(
        /WHERE w\.status IN \(:statuses\) ORDER BY w\.created_at ASC, w\.id ASC LIMIT 200$/,
      );
      expect(params).toEqual({ statuses: ['requested', 'processing'] });
    });

    it('sem nenhum status pedido, devolve lista vazia sem consultar o banco (IN () é erro no MySQL)', async () => {
      expect(await withdrawalRepository.listForAdmin([], 200)).toEqual([]);
      expect(fakeDb.calls).toHaveLength(0);
    });
  });

  it('findForAdmin busca um saque com o titular: primeira linha, ou undefined', async () => {
    const row = { id: 42, user_email: 'f@escambo.test' };
    fakeDb.reply([row], []);

    expect(await withdrawalRepository.findForAdmin(42)).toBe(row);
    expect(await withdrawalRepository.findForAdmin(43)).toBeUndefined();

    const { sql } = fakeDb.calls[0]!;
    expect(sql).toContain(`SELECT ${COLUMNS}, u.ulid AS user_ulid`);
    expect(sql).toContain('COALESCE(fp.full_name, cp.full_name) AS user_name FROM withdrawals w');
    // O filtro é só o id: o admin abre o saque em qualquer status.
    expect(sql.endsWith(`${HOLDER_JOINS} WHERE w.id = :id LIMIT 1`)).toBe(true);
    expect(fakeDb.calls[0]!.params).toEqual({ id: 42 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 43 });
  });

  describe('advance (concorrência otimista)', () => {
    it('só avança o saque que ainda está num dos status de origem, e diz se avançou', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(
        await withdrawalRepository.advance(42, ['requested', 'processing'], 'completed', 'E2E-1'),
      ).toBe(true);
      expect(await withdrawalRepository.advance(42, ['requested'], 'processing', null)).toBe(false);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('UPDATE withdrawals SET status = :to,');
      // Sem referência nova, a que já estava gravada fica.
      expect(sql).toContain('gateway_ref = COALESCE(:gatewayRef, gateway_ref)');
      // A data de processamento só é gravada quando o saque é concluído.
      expect(sql).toContain(
        "processed_at = CASE WHEN :to = 'completed' THEN NOW() ELSE processed_at END",
      );
      expect(sql).toMatch(/WHERE id = :id AND status IN \(:from\)$/);
      expect(params).toEqual({
        to: 'completed',
        gatewayRef: 'E2E-1',
        id: 42,
        from: ['requested', 'processing'],
      });
      expect(fakeDb.calls[1]!.params).toEqual({
        to: 'processing',
        gatewayRef: null,
        id: 42,
        from: ['requested'],
      });
    });
  });

  describe('closeAndRefund', () => {
    const row = { id: 42, user_id: 4, amount: '120.50', status: 'requested' };

    it('trava o saque, encerra sem pagar e devolve o valor ao saldo com linha no extrato', async () => {
      fakeDb.reply([row], { affectedRows: 1 });

      expect(await withdrawalRepository.closeAndRefund(42, ['requested'], 'cancelled')).toBe(true);

      expect(steps()).toEqual(['SELECT w.id, w.user_id,', 'UPDATE withdrawals SET', WALLET_EFFECT]);
      // A leitura trava a linha: cancelamento e processamento ao mesmo tempo não devolvem em dobro.
      expect(fakeDb.calls[0]!.sql).toBe(
        `SELECT ${COLUMNS} FROM withdrawals w WHERE w.id = :id FOR UPDATE`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 42 });
      expect(fakeDb.calls[1]!.sql).toBe(
        'UPDATE withdrawals SET status = :to, processed_at = NOW() WHERE id = :id',
      );
      expect(fakeDb.calls[1]!.params).toEqual({ to: 'cancelled', id: 42 });
      // O valor volta para o titular DO SAQUE, em número, no disponível.
      expect(fakeDb.calls[2]!.params).toEqual({
        userId: 4,
        balanceDelta: 120.5,
        pendingDelta: 0,
        reason: 'withdrawal_refund',
        withdrawalId: 42,
      });
      expect(ledger.applyWalletEffect.mock.calls[0]![0]).toBe(fakeDb.conn);
      expectCommitted();
    });

    it('a falha do pagamento (admin) alcança também o saque em processamento', async () => {
      fakeDb.reply([{ ...row, status: 'processing' }], { affectedRows: 1 });

      expect(
        await withdrawalRepository.closeAndRefund(42, ['requested', 'processing'], 'failed'),
      ).toBe(true);

      expect(fakeDb.calls[1]!.params).toEqual({ to: 'failed', id: 42 });
      expectCommitted();
    });

    it.each(['processing', 'completed', 'failed', 'cancelled'])(
      'saque em %s não é cancelado pelo titular: devolve false, sem mudar status nem saldo',
      async (status) => {
        fakeDb.reply([{ ...row, status }]);

        expect(await withdrawalRepository.closeAndRefund(42, ['requested'], 'cancelled')).toBe(
          false,
        );

        expect(fakeDb.calls).toHaveLength(1);
        expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
        expectRolledBack();
      },
    );

    it('saque que não existe: devolve false, sem mudar nada', async () => {
      fakeDb.reply([]);

      expect(await withdrawalRepository.closeAndRefund(42, ['requested'], 'cancelled')).toBe(false);

      expect(fakeDb.calls).toHaveLength(1);
      expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('se a carteira recusa a devolução, o encerramento é desfeito', async () => {
      ledger.applyWalletEffect.mockResolvedValueOnce(false);
      fakeDb.reply([row], { affectedRows: 1 });

      expect(await withdrawalRepository.closeAndRefund(42, ['requested'], 'cancelled')).toBe(false);

      expect(steps()).toEqual(['SELECT w.id, w.user_id,', 'UPDATE withdrawals SET']);
      expectRolledBack();
    });

    it('se uma gravação falha, desfaz tudo e devolve a conexão', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([row], boom);

      await expect(
        withdrawalRepository.closeAndRefund(42, ['requested'], 'cancelled'),
      ).rejects.toBe(boom);

      expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('se a devolução falha por erro do banco, o status volta atrás junto: o saque não fica encerrado sem o dinheiro', async () => {
      const boom = new Error('lock wait timeout');
      ledger.applyWalletEffect.mockRejectedValueOnce(boom);
      fakeDb.reply([row], { affectedRows: 1 });

      await expect(withdrawalRepository.closeAndRefund(42, ['requested'], 'failed')).rejects.toBe(
        boom,
      );

      expect(steps()).toEqual(['SELECT w.id, w.user_id,', 'UPDATE withdrawals SET']);
      expectRolledBack();
    });

    it.each(['completed', 'failed', 'cancelled'])(
      'saque já %s não é dado como falho pelo admin: o mesmo valor não é devolvido duas vezes',
      async (status) => {
        fakeDb.reply([{ ...row, status }]);

        expect(
          await withdrawalRepository.closeAndRefund(42, ['requested', 'processing'], 'failed'),
        ).toBe(false);

        expect(fakeDb.calls).toHaveLength(1);
        expect(ledger.applyWalletEffect).not.toHaveBeenCalled();
        expectRolledBack();
      },
    );
  });
});
