import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { gamificationRepository } from './gamification.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository da gamificação sem banco: o que cada método pede (tabela, filtro, ordem, limite,
 * parâmetros), o que devolve a partir da resposta e como o crédito de XP trata a transação. Se o
 * SQL roda no MySQL é assunto da integração.
 */
describe('gamificationRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('getOrCreateXp cria a linha zerada de quem ainda não tem e devolve a linha do usuário', async () => {
    const row = { user_id: 7, total_xp: 0, level: 1, level_name: 'Iniciante' };
    fakeDb.reply({ affectedRows: 1 }, [row]);

    expect(await gamificationRepository.getOrCreateXp(7)).toBe(row);

    expect(fakeDb.calls).toHaveLength(2);
    // INSERT IGNORE: quem já tem XP não é zerado.
    expect(fakeDb.calls[0]!.sql).toBe('INSERT IGNORE INTO user_xp (user_id) VALUES (:userId)');
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    expect(fakeDb.calls[1]!.sql).toBe(
      'SELECT user_id, total_xp, level, level_name FROM user_xp WHERE user_id = :userId LIMIT 1',
    );
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 7 });
    // Leitura simples, fora de transação: não abre conexão dedicada.
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
  });

  it('getOrCreateXp: se a criação da linha falha, o erro sobe e nada é lido', async () => {
    const boom = new Error('ER_NO_REFERENCED_ROW_2: usuário inexistente');
    fakeDb.reply(boom);

    await expect(gamificationRepository.getOrCreateXp(404)).rejects.toBe(boom);

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 404 });
  });

  describe('applyXp (extrato + total numa transação)', () => {
    const input = {
      userId: 7,
      delta: 100,
      level: 2,
      levelName: 'Aprendiz',
      reason: 'contract_completed',
      referenceId: 55,
    };

    it('registra o ganho no extrato e soma ao total, gravando o nível novo', async () => {
      fakeDb.reply({ affectedRows: 0 }, { insertId: 1, affectedRows: 1 }, { affectedRows: 1 });

      await expect(gamificationRepository.applyXp(input)).resolves.toBeUndefined();

      expect(fakeDb.calls).toHaveLength(3);
      const [ensure, ledger, total] = fakeDb.calls;

      expect(ensure!.sql).toBe('INSERT IGNORE INTO user_xp (user_id) VALUES (:userId)');
      expect(ensure!.params).toEqual({ userId: 7 });

      expect(ledger!.sql).toContain(
        'INSERT INTO xp_transactions (user_id, amount, reason, reference_id)',
      );
      expect(ledger!.sql).toContain('VALUES (:userId, :delta, :reason, :referenceId)');
      expect(ledger!.params).toEqual({
        userId: 7,
        delta: 100,
        reason: 'contract_completed',
        referenceId: 55,
      });

      // O total é incrementado no banco (não sobrescrito) e só na linha do usuário.
      expect(total!.sql).toContain(
        'UPDATE user_xp SET total_xp = total_xp + :delta, level = :level, level_name = :levelName',
      );
      expect(total!.sql).toContain('WHERE user_id = :userId');
      expect(total!.params).toEqual({ delta: 100, level: 2, levelName: 'Aprendiz', userId: 7 });

      expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);

      // Extrato e total entram juntos: a transação abre antes da primeira instrução, confirma
      // depois da última e só então a conexão volta para o pool.
      const queryOrder = fakeDb.pool.query.mock.invocationCallOrder;
      const begin = fakeDb.conn.beginTransaction.mock.invocationCallOrder[0]!;
      const commit = fakeDb.conn.commit.mock.invocationCallOrder[0]!;
      const release = fakeDb.conn.release.mock.invocationCallOrder[0]!;
      expect(begin).toBeLessThan(queryOrder[0]!);
      expect(commit).toBeGreaterThan(queryOrder[2]!);
      expect(release).toBeGreaterThan(commit);

      // As três instruções rodam na conexão que abriu a transação: pelo pool, o lançamento e a
      // soma do total deixariam de ser desfeitos juntos.
      const contexts = fakeDb.pool.query.mock.contexts;
      expect(contexts).toHaveLength(3);
      expect(contexts.every((ctx) => ctx === fakeDb.conn)).toBe(true);
    });

    it('se a transação não chega a abrir, nada é gravado e a conexão volta para o pool', async () => {
      const boom = new Error('ER_CONNECTION_LOST');
      fakeDb.conn.beginTransaction.mockRejectedValueOnce(boom);

      await expect(gamificationRepository.applyXp(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(0);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se a linha de XP não pode ser criada (usuário inexistente), nada é lançado e a transação é desfeita', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2: usuário inexistente');
      fakeDb.reply(boom);

      await expect(gamificationRepository.applyXp(input)).rejects.toBe(boom);

      expect(fakeDb.sqls()).toEqual(['INSERT IGNORE INTO user_xp (user_id) VALUES (:userId)']);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      // Desfaz antes de devolver a conexão ao pool.
      expect(fakeDb.conn.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
        fakeDb.conn.release.mock.invocationCallOrder[0]!,
      );
    });

    it('ganho sem referência grava reference_id nulo', async () => {
      await gamificationRepository.applyXp({ ...input, referenceId: null });
      expect(fakeDb.calls[1]!.params).toEqual({
        userId: 7,
        delta: 100,
        reason: 'contract_completed',
        referenceId: null,
      });
    });

    it('se a soma do total falha, o lançamento do extrato é desfeito e a conexão é devolvida', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({ affectedRows: 0 }, { insertId: 1, affectedRows: 1 }, boom);

      await expect(gamificationRepository.applyXp(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o lançamento no extrato falha, o total não é somado e a transação é desfeita', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2');
      fakeDb.reply({ affectedRows: 0 }, boom);

      await expect(gamificationRepository.applyXp(input)).rejects.toBe(boom);

      // XP sem lançamento no extrato não existe: o UPDATE do total nem chega a rodar.
      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE user_xp'))).toBe(false);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o commit falha, o erro sobe, a transação é desfeita e a conexão é devolvida', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.conn.commit.mockRejectedValueOnce(boom);

      await expect(gamificationRepository.applyXp(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('sem conexão disponível no pool, o erro sobe e nenhuma instrução é executada', async () => {
      const boom = new Error('ER_CON_COUNT_ERROR');
      fakeDb.pool.getConnection.mockRejectedValueOnce(boom);

      await expect(gamificationRepository.applyXp(input)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(0);
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).not.toHaveBeenCalled();
    });
  });

  it('listBadges traz as badges do usuário com slug e nome, da mais recente para a mais antiga', async () => {
    const rows = [{ slug: 'top-rated' }, { slug: 'first-deal' }];
    fakeDb.reply(rows);

    expect(await gamificationRepository.listBadges(7)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('SELECT b.slug, b.name, ub.awarded_at');
    expect(sql).toContain('FROM user_badges ub JOIN badges b ON b.id = ub.badge_id');
    expect(sql).toContain('WHERE ub.user_id = :userId ORDER BY ub.awarded_at DESC');
    expect(params).toEqual({ userId: 7 });
  });

  it('o catálogo avaliado pela engine só tem badges ativas (RN-053)', async () => {
    const rows = [{ id: 2, slug: 'top-rated', xp_reward: 200, criteria: null }];
    fakeDb.reply(rows);

    expect(await gamificationRepository.listActiveBadges()).toBe(rows);

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT id, slug, xp_reward, criteria FROM badges WHERE is_active = 1',
    );
    expect(fakeDb.calls[0]!.params).toBeUndefined();
  });

  it('findBadgeBySlug devolve a primeira linha, ou undefined, e ignora badge desativada', async () => {
    const row = { id: 1, slug: 'first-deal', xp_reward: 50, criteria: null };
    fakeDb.reply([row], []);

    expect(await gamificationRepository.findBadgeBySlug('first-deal')).toBe(row);
    expect(await gamificationRepository.findBadgeBySlug('nao-existe')).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT id, slug, xp_reward, criteria FROM badges WHERE slug = :slug AND is_active = 1 LIMIT 1',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ slug: 'first-deal' });
    expect(fakeDb.calls[1]!.params).toEqual({ slug: 'nao-existe' });
  });

  it('awardBadge diz se a badge foi concedida agora: true na primeira vez, false se o usuário já tinha', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await gamificationRepository.awardBadge(7, 2)).toBe(true);
    expect(await gamificationRepository.awardBadge(7, 2)).toBe(false);

    // INSERT IGNORE: a segunda concessão não dá erro de chave duplicada, só não insere.
    expect(fakeDb.calls[0]!.sql).toBe(
      'INSERT IGNORE INTO user_badges (user_id, badge_id) VALUES (:userId, :badgeId)',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, badgeId: 2 });
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 7, badgeId: 2 });
    expect(fakeDb.calls).toHaveLength(2);
  });

  it('listBadges de quem não tem badge devolve lista vazia', async () => {
    expect(await gamificationRepository.listBadges(8)).toEqual([]);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 8 });
  });

  it('getFreelancerStats devolve os números do perfil de freelancer, ou undefined para quem não tem perfil', async () => {
    const row = { total_contracts: 12, total_reviews: 9, avg_rating: '4.70' };
    fakeDb.reply([row], []);

    expect(await gamificationRepository.getFreelancerStats(7)).toBe(row);
    expect(await gamificationRepository.getFreelancerStats(8)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('SELECT total_contracts, total_reviews, avg_rating');
    expect(sql).toContain('FROM profiles_freelancer WHERE user_id = :userId LIMIT 1');
    expect(params).toEqual({ userId: 7 });
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 8 });
  });

  it('incrementContracts soma um contrato só no perfil do freelancer informado', async () => {
    fakeDb.reply({ affectedRows: 1 });

    await expect(gamificationRepository.incrementContracts(7)).resolves.toBeUndefined();

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE profiles_freelancer SET total_contracts = total_contracts + 1 WHERE user_id = :userId',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });

  it('recentEvents traz os últimos ganhos do usuário, do mais novo para o mais antigo, no limite pedido', async () => {
    const rows = [{ amount: 100, reason: 'contract_completed' }];
    fakeDb.reply(rows);

    expect(await gamificationRepository.recentEvents(7, 20)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toBe(
      'SELECT amount, reason, created_at FROM xp_transactions WHERE user_id = :userId ORDER BY id DESC LIMIT 20',
    );
    expect(params).toEqual({ userId: 7 });

    // O tamanho da página é o que foi pedido, não um número fixo; sem ganhos, lista vazia.
    expect(await gamificationRepository.recentEvents(8, 5)).toEqual([]);
    expect(fakeDb.calls[1]!.sql).toMatch(/WHERE user_id = :userId ORDER BY id DESC LIMIT 5$/);
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 8 });
    expect(fakeDb.calls).toHaveLength(2);
  });

  it('activityDates devolve os dias distintos com atividade (texto YYYY-MM-DD), do mais recente para trás', async () => {
    fakeDb.reply([{ d: '2026-03-10' }, { d: '2026-03-09' }, { d: '2026-03-07' }]);

    expect(await gamificationRepository.activityDates(7, 60)).toEqual([
      '2026-03-10',
      '2026-03-09',
      '2026-03-07',
    ]);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain("SELECT DISTINCT DATE_FORMAT(created_at, '%Y-%m-%d') AS d");
    expect(sql).toContain('FROM xp_transactions WHERE user_id = :userId');
    expect(sql).toContain('ORDER BY d DESC LIMIT 60');
    expect(params).toEqual({ userId: 7 });
  });

  it('activityDates sem atividade devolve lista vazia, e a janela de dias é a que foi pedida', async () => {
    expect(await gamificationRepository.activityDates(8, 7)).toEqual([]);

    expect(fakeDb.calls[0]!.sql).toMatch(/WHERE user_id = :userId ORDER BY d DESC LIMIT 7$/);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 8 });
    expect(fakeDb.calls).toHaveLength(1);
  });

  describe('rankOf', () => {
    it('a posição é quantos têm mais XP que o usuário, mais um', async () => {
      fakeDb.reply([{ rnk: '5' }]);

      // O COUNT chega como texto ou BigInt conforme o driver: sai como número.
      expect(await gamificationRepository.rankOf(7)).toBe(5);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT COUNT(*) + 1 AS rnk FROM user_xp');
      expect(sql).toContain(
        'WHERE total_xp > (SELECT total_xp FROM user_xp WHERE user_id = :userId)',
      );
      expect(params).toEqual({ userId: 7 });
    });

    it('sem linha (ou com rnk nulo) o usuário fica em primeiro', async () => {
      fakeDb.reply([], [{ rnk: null }]);
      expect(await gamificationRepository.rankOf(7)).toBe(1);
      expect(await gamificationRepository.rankOf(7)).toBe(1);
    });
  });

  it('leaderboard ordena por XP (empate: o cadastro mais antigo primeiro), no limite pedido, e expõe o ulid, não o id', async () => {
    const rows = [{ ulid: '01HXA', name: 'Ana', total_xp: 900, level: 3 }];
    fakeDb.reply(rows);

    expect(await gamificationRepository.leaderboard(10)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'SELECT u.ulid, pf.full_name AS name, ux.total_xp, ux.level, ux.level_name',
    );
    expect(sql).toContain('FROM user_xp ux JOIN users u ON u.id = ux.user_id');
    // Quem não tem perfil de freelancer continua no ranking, sem nome.
    expect(sql).toContain('LEFT JOIN profiles_freelancer pf ON pf.user_id = ux.user_id');
    expect(sql).toMatch(/ORDER BY ux\.total_xp DESC, ux\.user_id ASC LIMIT 10$/);
    expect(params).toBeUndefined();

    // O tamanho do ranking é o que foi pedido, não um número fixo; sem ninguém, lista vazia.
    expect(await gamificationRepository.leaderboard(3)).toEqual([]);
    expect(fakeDb.calls[1]!.sql).toMatch(/ORDER BY ux\.total_xp DESC, ux\.user_id ASC LIMIT 3$/);
    expect(fakeDb.calls).toHaveLength(2);
  });
});
