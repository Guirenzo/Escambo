import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { boostsRepository } from './boosts.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository dos impulsionamentos sem banco: o que cada método pede (tabela, filtro, ordem,
 * parâmetros), o que devolve a partir da resposta e como a compra trata a transação. Se o SQL
 * roda no MySQL é assunto da integração.
 */
describe('boostsRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('a vitrine de planos só traz os ativos, do mais curto para o mais longo', async () => {
    const rows = [
      { id: 1, duration_days: 7 },
      { id: 2, duration_days: 30 },
    ];
    fakeDb.reply(rows);

    expect(await boostsRepository.listPlans()).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'SELECT id, name, description, duration_days, price, features, is_active',
    );
    expect(sql).toContain('FROM boost_plans WHERE is_active = 1 ORDER BY duration_days ASC');
    expect(params).toBeUndefined();
    expect(fakeDb.calls).toHaveLength(1);
  });

  it('findPlan devolve a primeira linha, ou undefined, e não enxerga plano desativado', async () => {
    const row = { id: 2, price: '99.90', duration_days: 30 };
    fakeDb.reply([row], []);

    expect(await boostsRepository.findPlan(2)).toBe(row);
    expect(await boostsRepository.findPlan(77)).toBeUndefined();

    // O preço e a duração saem daqui para a cobrança: precisam estar entre as colunas lidas.
    expect(fakeDb.calls[0]!.sql).toContain(
      'SELECT id, name, description, duration_days, price, features, is_active',
    );
    expect(fakeDb.calls[0]!.sql).toContain(
      'FROM boost_plans WHERE id = :id AND is_active = 1 LIMIT 1',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 2 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 77 });
    expect(fakeDb.calls).toHaveLength(2);
  });

  describe('purchase (débito + extrato + impulsionamento numa transação)', () => {
    const input = { userId: 7, serviceId: 3, planId: 2, cost: 30, durationDays: 7 };
    /**
     * A carteira já existente (o INSERT IGNORE não insere), a trava dela e a conferência do
     * impulsionamento ativo, sem nenhum ativo (RN-017).
     */
    const ready = [{ affectedRows: 0 }, [{ credits_balance: '100.00' }], []];

    it('debita os créditos, lança no extrato, cria o impulsionamento e devolve o id dele', async () => {
      fakeDb.reply(
        ...ready,
        { affectedRows: 1 }, // débito
        [{ total: '70.00' }], // saldo depois do débito
        { insertId: 500, affectedRows: 1 }, // extrato
        { insertId: 91, affectedRows: 1 }, // boost
      );

      expect(await boostsRepository.purchase(input)).toEqual({ boostId: 91 });

      expect(fakeDb.calls).toHaveLength(7);
      const [wallet, lock, active, debit, balance, ledger, boost] = fakeDb.calls;

      // Quem nunca teve carteira ganha uma zerada antes de tudo (e quem tem não é tocado).
      expect(wallet!.sql).toBe('INSERT IGNORE INTO wallets (user_id) VALUES (:userId)');
      expect(wallet!.params).toEqual({ userId: 7 });

      // RN-017: a carteira de quem compra é travada antes de tudo, e só então se procura um ativo.
      expect(lock!.sql).toBe(
        'SELECT credits_balance FROM wallets WHERE user_id = :userId FOR UPDATE',
      );
      expect(lock!.params).toEqual({ userId: 7 });
      expect(active!.sql).toBe(
        "SELECT expires_at FROM boosts WHERE service_id = :serviceId AND status = 'active' AND expires_at > NOW() " +
          'ORDER BY expires_at DESC LIMIT 1',
      );
      expect(active!.params).toEqual({ serviceId: 3 });
      // A linha do serviço não é travada: segurá-la esperando a carteira fechava um ciclo com o
      // aceite da troca e com a exclusão da conta (deadlock).
      expect(fakeDb.sqls().some((s) => s.includes('services'))).toBe(false);

      // O débito só passa se o saldo cobre o custo: é a trava contra saldo negativo.
      expect(debit!.sql).toContain('UPDATE wallets SET credits_balance = credits_balance - :cost');
      expect(debit!.sql).toContain('WHERE user_id = :userId AND credits_balance >= :cost');
      expect(debit!.params).toEqual({ cost: 30, userId: 7 });

      expect(balance!.sql).toBe(
        'SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId',
      );
      expect(balance!.params).toEqual({ userId: 7 });

      // O extrato registra a saída (valor negativo) com o saldo que ficou, como número.
      expect(ledger!.sql).toContain(
        'INSERT INTO credit_transactions (user_id, amount, balance_after, reason)',
      );
      expect(ledger!.sql).toContain("VALUES (:userId, :amount, :after, 'boost')");
      expect(ledger!.params).toEqual({ userId: 7, amount: -30, after: 70 });

      // O impulsionamento nasce ativo, valendo de agora até a duração do plano.
      expect(boost!.sql).toContain(
        'INSERT INTO boosts (user_id, service_id, plan_id, status, starts_at, expires_at)',
      );
      expect(boost!.sql).toContain(
        "VALUES (:userId, :serviceId, :planId, 'active', NOW(), NOW() + INTERVAL :days DAY)",
      );
      expect(boost!.params).toEqual({ userId: 7, serviceId: 3, planId: 2, days: 7 });

      expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);

      // A carteira é criada FORA da transação: o INSERT IGNORE que acha a linha deixaria nela uma
      // trava compartilhada, e duas compras com essa trava pedindo o FOR UPDATE se travariam. Do
      // FOR UPDATE em diante tudo acontece dentro da transação, que confirma depois da última
      // instrução; só então a conexão volta para o pool.
      const queryOrder = fakeDb.pool.query.mock.invocationCallOrder;
      const begin = fakeDb.conn.beginTransaction.mock.invocationCallOrder[0]!;
      const commit = fakeDb.conn.commit.mock.invocationCallOrder[0]!;
      const release = fakeDb.conn.release.mock.invocationCallOrder[0]!;
      expect(queryOrder[0]!).toBeLessThan(begin);
      expect(begin).toBeLessThan(queryOrder[1]!);
      expect(commit).toBeGreaterThan(queryOrder[6]!);
      expect(release).toBeGreaterThan(commit);

      // Nenhuma instrução da compra pode ir pelo pool: outra conexão ficaria fora da transação e
      // o débito não seria desfeito junto com o resto. As sete rodam na conexão que a abriu.
      const contexts = fakeDb.pool.query.mock.contexts;
      expect(contexts).toHaveLength(7);
      expect(contexts.every((ctx) => ctx === fakeDb.conn)).toBe(true);
    });

    it('serviço com impulsionamento ativo: recusa com o fim do atual, sem debitar, e desfaz a transação (RN-017)', async () => {
      const until = new Date('2026-03-17T12:00:00Z');
      fakeDb.reply({ affectedRows: 0 }, [{ credits_balance: '100.00' }], [{ expires_at: until }]);

      const result = await boostsRepository.purchase(input);

      expect(result).toEqual({ refused: 'boost_active', activeUntil: until });
      // Nem débito, nem extrato, nem boost novo sobreposto ao atual.
      expect(fakeDb.sqls()).toEqual([
        'INSERT IGNORE INTO wallets (user_id) VALUES (:userId)',
        'SELECT credits_balance FROM wallets WHERE user_id = :userId FOR UPDATE',
        "SELECT expires_at FROM boosts WHERE service_id = :serviceId AND status = 'active' AND expires_at > NOW() " +
          'ORDER BY expires_at DESC LIMIT 1',
      ]);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
        fakeDb.conn.release.mock.invocationCallOrder[0]!,
      );
      // A conferência roda na transação que travou a carteira, depois da trava, e não numa
      // leitura solta do pool.
      const contexts = fakeDb.pool.query.mock.contexts;
      expect(contexts).toHaveLength(3);
      expect(contexts.every((ctx) => ctx === fakeDb.conn)).toBe(true);
      const queryOrder = fakeDb.pool.query.mock.invocationCallOrder;
      expect(fakeDb.conn.beginTransaction.mock.invocationCallOrder[0]!).toBeLessThan(
        queryOrder[1]!,
      );
    });

    it('o fim do impulsionamento ativo que chega como texto vira data', async () => {
      fakeDb.reply(
        { affectedRows: 0 },
        [{ credits_balance: '100.00' }],
        [{ expires_at: '2026-03-17T12:00:00Z' }],
      );

      expect(await boostsRepository.purchase(input)).toEqual({
        refused: 'boost_active',
        activeUntil: new Date('2026-03-17T12:00:00Z'),
      });
    });

    it('gastar o saldo inteiro grava saldo zero no extrato (o saldo conta o disponível mais o retido)', async () => {
      fakeDb.reply(...ready, { affectedRows: 1 }, [{ total: 0 }], {}, { insertId: 92 });

      expect(await boostsRepository.purchase({ ...input, cost: 100, durationDays: 30 })).toEqual({
        boostId: 92,
      });

      expect(fakeDb.calls[3]!.params).toEqual({ cost: 100, userId: 7 });
      expect(fakeDb.calls[4]!.sql).toContain('credits_balance + credits_pending AS total');
      expect(fakeDb.calls[5]!.params).toEqual({ userId: 7, amount: -100, after: 0 });
      expect(fakeDb.calls[6]!.params).toEqual({ userId: 7, serviceId: 3, planId: 2, days: 30 });
    });

    it('sem créditos suficientes recusa, desfaz a transação e não grava extrato nem impulsionamento', async () => {
      fakeDb.reply({ affectedRows: 1 }, [{ credits_balance: '0.00' }], [], { affectedRows: 0 });

      expect(await boostsRepository.purchase(input)).toEqual({ refused: 'insufficient_credits' });

      expect(fakeDb.sqls().map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
        'INSERT IGNORE INTO',
        'SELECT credits_balance FROM',
        'SELECT expires_at FROM',
        'UPDATE wallets SET',
      ]);
      // A recusa vem do próprio débito condicionado ao saldo, não de uma leitura anterior.
      expect(fakeDb.calls[3]!.sql).toContain('AND credits_balance >= :cost');
      expect(fakeDb.calls[3]!.params).toEqual({ cost: 30, userId: 7 });
      expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      // A transação é desfeita antes de a conexão voltar para o pool: devolvida ainda aberta, a
      // próxima requisição que pegasse essa conexão herdaria a transação.
      expect(fakeDb.conn.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
        fakeDb.conn.release.mock.invocationCallOrder[0]!,
      );
      // A criação da carteira e a tentativa de débito rodam na conexão da compra, não no pool.
      const contexts = fakeDb.pool.query.mock.contexts;
      expect(contexts).toHaveLength(4);
      expect(contexts.every((ctx) => ctx === fakeDb.conn)).toBe(true);
    });

    it('se a transação não chega a abrir, nada é travado nem cobrado e a conexão volta para o pool', async () => {
      const boom = new Error('ER_CONNECTION_LOST');
      fakeDb.conn.beginTransaction.mockRejectedValueOnce(boom);

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      // Só a carteira foi garantida (sozinha, sem cobrar nada). Sem transação aberta não pode
      // haver débito: ele ficaria gravado sem extrato nem boost.
      expect(fakeDb.sqls()).toEqual(['INSERT IGNORE INTO wallets (user_id) VALUES (:userId)']);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se a leitura do saldo falha depois do débito, nada é lançado e o débito é desfeito', async () => {
      const boom = new Error('ER_QUERY_INTERRUPTED');
      fakeDb.reply(...ready, { affectedRows: 1 }, boom);

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(5);
      expect(fakeDb.sqls().some((s) => s.startsWith('INSERT INTO credit_transactions'))).toBe(
        false,
      );
      expect(fakeDb.sqls().some((s) => s.startsWith('INSERT INTO boosts'))).toBe(false);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se a criação da carteira falha, a transação nem abre e nada é travado nem cobrado', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply(boom);

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.sqls()).toEqual(['INSERT IGNORE INTO wallets (user_id) VALUES (:userId)']);
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o lançamento no extrato falha, o impulsionamento não é criado e o débito é desfeito', async () => {
      const boom = new Error('ER_DATA_TOO_LONG');
      fakeDb.reply(...ready, { affectedRows: 1 }, [{ total: '70.00' }], boom);

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(6);
      expect(fakeDb.sqls().some((s) => s.startsWith('INSERT INTO boosts'))).toBe(false);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o commit falha, o erro sobe, a transação é desfeita e a conexão é devolvida', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply(...ready, { affectedRows: 1 }, [{ total: '70.00' }], {}, { insertId: 91 });
      fakeDb.conn.commit.mockRejectedValueOnce(boom);

      // Sem o commit não há compra: quem chama não pode receber o id de um impulsionamento.
      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(7);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('sem conexão disponível no pool, o erro sobe e nenhuma instrução é executada', async () => {
      const boom = new Error('ER_CON_COUNT_ERROR');
      fakeDb.pool.getConnection.mockRejectedValueOnce(boom);

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(0);
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
      // Não há conexão para desfazer nem para devolver.
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).not.toHaveBeenCalled();
    });

    it('se a criação do impulsionamento falha, o débito é desfeito e a conexão é devolvida', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2');
      fakeDb.reply(...ready, { affectedRows: 1 }, [{ total: '70.00' }], {}, boom);

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(7);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o débito falha, nada mais é executado e a transação é desfeita', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply(...ready, boom);

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(4);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se a trava da carteira falha, nada é conferido nem cobrado', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply({ affectedRows: 0 }, boom);

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.calls[1]!.sql).toBe(
        'SELECT credits_balance FROM wallets WHERE user_id = :userId FOR UPDATE',
      );
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('um rollback que falha não troca o erro original: quem chama recebe o erro da compra', async () => {
      const boom = new Error('ER_DATA_TOO_LONG');
      fakeDb.reply(...ready, { affectedRows: 1 }, [{ total: '70.00' }], boom);
      fakeDb.conn.rollback.mockRejectedValueOnce(new Error('conexão caiu no rollback'));

      await expect(boostsRepository.purchase(input)).rejects.toBe(boom);

      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });
  });

  it('listForUser traz só os impulsionamentos do usuário, com o nome do plano, do mais novo para o mais antigo', async () => {
    const rows = [{ id: 9 }, { id: 4 }];
    fakeDb.reply(rows);

    expect(await boostsRepository.listForUser(7)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'SELECT b.id, b.service_id, b.plan_id, bp.name AS plan_name, b.status, b.starts_at, b.expires_at, b.created_at',
    );
    expect(sql).toContain('FROM boosts b JOIN boost_plans bp ON bp.id = b.plan_id');
    expect(sql).toContain('WHERE b.user_id = :userId ORDER BY b.id DESC');
    // A lista é o histórico de quem pede: os expirados e cancelados também aparecem.
    expect(sql).not.toContain('b.status =');
    expect(params).toEqual({ userId: 7 });
    expect(fakeDb.calls).toHaveLength(1);
  });

  it('listForUser de quem nunca impulsionou devolve lista vazia', async () => {
    expect(await boostsRepository.listForUser(8)).toEqual([]);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 8 });
  });

  it('findById devolve a primeira linha com o nome do plano, ou undefined', async () => {
    const row = { id: 91, plan_name: 'Destaque 7 dias' };
    fakeDb.reply([row], []);

    expect(await boostsRepository.findById(91)).toBe(row);
    expect(await boostsRepository.findById(404)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'SELECT b.id, b.service_id, b.plan_id, bp.name AS plan_name, b.status, b.starts_at, b.expires_at, b.created_at',
    );
    expect(sql).toContain('FROM boosts b JOIN boost_plans bp ON bp.id = b.plan_id');
    expect(sql).toContain('WHERE b.id = :id LIMIT 1');
    expect(params).toEqual({ id: 91 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 404 });
  });
});
