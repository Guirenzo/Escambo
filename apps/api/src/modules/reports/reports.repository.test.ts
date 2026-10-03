import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { reportsRepository } from './reports.repository';

const {
  referencesTo,
  clearReferences,
  blocklistAdd,
  reviewSetRemoved,
  messageSetRemoved,
  insertRemoval,
} = vi.hoisted(() => ({
  referencesTo: vi.fn(),
  clearReferences: vi.fn(),
  blocklistAdd: vi.fn(),
  reviewSetRemoved: vi.fn(),
  messageSetRemoved: vi.fn(),
  insertRemoval: vi.fn(),
}));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../media/media.repository', () => ({
  mediaRepository: { referencesTo, clearReferences },
}));
vi.mock('../media/media.blocklist', () => ({ mediaBlocklist: { add: blocklistAdd } }));
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { setRemoved: reviewSetRemoved },
}));
vi.mock('../messaging/messaging.repository', () => ({
  messagingRepository: { setRemoved: messageSetRemoved },
}));
vi.mock('./content-removals.repository', () => ({
  contentRemovalsRepository: { insert: insertRemoval },
}));

const MEDIA = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
const COLS =
  'id, reporter_id, target_type, target_id, image_url, reason, description, status, reviewed_at, resolution_note, created_at';
/** O nome de exibição do dono: perfil de freelancer, senão o de cliente. */
const OWNER =
  'u.id AS owner_id, u.ulid AS owner_ulid, COALESCE(pf.full_name, pc.full_name) AS owner_name';
const OWNER_JOINS =
  'LEFT JOIN profiles_freelancer pf ON pf.user_id = u.id LEFT JOIN profiles_client pc ON pc.user_id = u.id';

/** O filtro de uma instrução, com o que vem depois dele (ordem e limite). */
const whereOf = (sql: string): string => sql.slice(sql.indexOf(' WHERE ') + ' WHERE '.length);
/** O que vem antes do filtro: a lista de colunas, a tabela e as junções. */
const beforeWhere = (sql: string): string => sql.slice(0, sql.indexOf(' WHERE '));
/** Onde a instrução rodou: na conexão da transação ou direto no pool (fora dela). */
const ranOn = (index: number): unknown => fakeDb.conn.query.mock.contexts[index];

/**
 * Fecha só as denúncias abertas do grupo: mesmo alvo e mesma imagem (<=> casa NULL com NULL), com
 * quem decidiu, a hora e a nota. Roda na conexão da transação: fora dela, uma falha depois do
 * fechamento deixaria as denúncias fechadas sem a remoção.
 */
const expectClosesOpenGroup = (index: number): void => {
  const { sql } = fakeDb.calls[index]!;
  expect(beforeWhere(sql)).toBe(
    'UPDATE content_reports SET status = :status, reviewed_by = :adminId, reviewed_at = NOW(), resolution_note = :note',
  );
  expect(whereOf(sql)).toBe(
    "target_type = :targetType AND target_id = :targetId AND image_url <=> :imageUrl AND status IN ('pending', 'reviewing')",
  );
  expect(ranOn(index)).toBe(fakeDb.conn);
};

const expectCommitted = (): void => {
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
};
const expectRolledBack = (): void => {
  expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
};

/**
 * Repository das denúncias (ADR 39, 41 e 44) sem banco: o que cada método pede, o que devolve a
 * partir da resposta e o que entra em cada transação. Se o SQL roda no MySQL é da integração.
 */
describe('reportsRepository', () => {
  beforeEach(() => {
    fakeDb.reset();
    vi.resetAllMocks();
  });

  it('create grava a denúncia e devolve o id; denúncia automática vai sem denunciante', async () => {
    const data = {
      reporterId: null,
      targetType: 'message',
      targetId: 55,
      imageUrl: null,
      reason: 'off_platform',
      description: 'Sinalizado automaticamente: Pix.',
    };
    fakeDb.reply({ insertId: 15, affectedRows: 1 });

    expect(await reportsRepository.create(data)).toBe(15);

    expect(fakeDb.calls).toHaveLength(1);
    const { sql, params } = fakeDb.calls[0]!;
    // Cada coluna recebe o seu campo, na mesma ordem.
    expect(sql).toContain(
      'INSERT INTO content_reports (reporter_id, target_type, target_id, image_url, reason, description)',
    );
    expect(sql).toContain(
      'VALUES (:reporterId, :targetType, :targetId, :imageUrl, :reason, :description)',
    );
    expect(params).toEqual(data);
  });

  it('listForReporter traz só as denúncias de quem pediu, da mais nova para a mais antiga', async () => {
    const rows = [{ id: 2 }, { id: 1 }];
    fakeDb.reply(rows);

    expect(await reportsRepository.listForReporter(7)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(beforeWhere(sql)).toBe(`SELECT ${COLS} FROM content_reports`);
    // Sem limite: a pessoa vê todas as denúncias que fez.
    expect(whereOf(sql)).toBe('reporter_id = :reporterId ORDER BY id DESC');
    expect(params).toEqual({ reporterId: 7 });
  });

  it('findById devolve a primeira linha, ou undefined', async () => {
    const row = { id: 4, status: 'pending' };
    fakeDb.reply([row], []);

    expect(await reportsRepository.findById(4)).toBe(row);
    expect(await reportsRepository.findById(99)).toBeUndefined();

    expect(beforeWhere(fakeDb.calls[0]!.sql)).toBe(`SELECT ${COLS} FROM content_reports`);
    expect(whereOf(fakeDb.calls[0]!.sql)).toBe('id = :id LIMIT 1');
    expect(fakeDb.calls[0]!.params).toEqual({ id: 4 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 99 });
  });

  describe('imageTarget (dono e imagem no ar, ADR 39)', () => {
    it('avatar: a foto do perfil de freelancer, senão a de cliente, de conta que não foi apagada', async () => {
      const row = { owner_id: 9, image_url: MEDIA, title: null };
      fakeDb.reply([row]);

      expect(await reportsRepository.imageTarget('avatar', 9)).toBe(row);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'SELECT u.id AS owner_id, COALESCE(pf.avatar_url, pc.avatar_url) AS image_url, NULL AS title',
      );
      expect(sql).toContain(`FROM users u ${OWNER_JOINS}`);
      expect(sql).toContain('WHERE u.id = :id AND u.deleted_at IS NULL LIMIT 1');
      expect(params).toEqual({ id: 9 });
    });

    it('trabalho do portfólio: o dono é o usuário do perfil de freelancer; inexistente é undefined', async () => {
      await expect(reportsRepository.imageTarget('portfolio_item', 3)).resolves.toBeUndefined();

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT item_owner.user_id AS owner_id, i.image_url, i.title');
      expect(sql).toContain(
        'FROM freelancer_portfolio_items i JOIN profiles_freelancer item_owner ON item_owner.id = i.freelancer_id',
      );
      expect(sql).toContain('WHERE i.id = :id LIMIT 1');
      expect(sql).not.toContain('FROM users');
      expect(params).toEqual({ id: 3 });
    });
  });

  it('hasPending: só denúncia aberta da mesma pessoa, do mesmo alvo e da mesma imagem conta como repetida', async () => {
    fakeDb.reply([{ 1: 1 }], []);

    expect(await reportsRepository.hasPending(7, 'avatar', 9, MEDIA)).toBe(true);
    expect(await reportsRepository.hasPending(7, 'service', 5, null)).toBe(false);

    const { sql, params } = fakeDb.calls[0]!;
    expect(beforeWhere(sql)).toBe('SELECT 1 FROM content_reports');
    // Denúncia de outra pessoa, de outra imagem do mesmo alvo ou já analisada não conta.
    expect(whereOf(sql)).toBe(
      "reporter_id = :reporterId AND target_type = :targetType AND target_id = :targetId AND image_url <=> :imageUrl AND status IN ('pending', 'reviewing') LIMIT 1",
    );
    expect(params).toEqual({ reporterId: 7, targetType: 'avatar', targetId: 9, imageUrl: MEDIA });
    expect(fakeDb.calls[1]!.params).toEqual({
      reporterId: 7,
      targetType: 'service',
      targetId: 5,
      imageUrl: null,
    });
  });

  describe('listForModeration (fila do admin)', () => {
    it('pendentes: denúncias abertas, das mais recentes para as mais antigas, até o limite', async () => {
      const rows = [{ id: 4 }, { id: 3 }];
      fakeDb.reply(rows);

      expect(await reportsRepository.listForModeration('pending', 500)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(beforeWhere(sql)).toBe(`SELECT ${COLS} FROM content_reports`);
      expect(whereOf(sql)).toBe(
        "status IN ('pending', 'reviewing') ORDER BY created_at DESC, id DESC LIMIT 500",
      );
      expect(params).toBeUndefined();
    });

    it('resolvidas: as que tiveram ação ou foram dispensadas; o limite vai inteiro para o SQL', async () => {
      await reportsRepository.listForModeration('resolved', 20.9);

      expect(whereOf(fakeDb.calls[0]!.sql)).toBe(
        "status IN ('actioned', 'dismissed') ORDER BY created_at DESC, id DESC LIMIT 20",
      );
    });
  });

  describe('o que a fila mostra de cada alvo', () => {
    it('lista vazia de ids não vai ao banco', async () => {
      expect(await reportsRepository.usersByIds([])).toEqual([]);
      expect(await reportsRepository.portfolioByIds([])).toEqual([]);
      expect(await reportsRepository.servicesByIds([])).toEqual([]);
      expect(await reportsRepository.reviewsByIds([])).toEqual([]);
      expect(await reportsRepository.messagesByIds([])).toEqual([]);
      expect(fakeDb.calls).toHaveLength(0);
    });

    it('usuários: o próprio usuário é o dono, com o avatar no ar', async () => {
      const rows = [{ id: 9 }];
      fakeDb.reply(rows);

      expect(await reportsRepository.usersByIds([9, 12])).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        `SELECT u.id, ${OWNER}, NULL AS title, COALESCE(pf.avatar_url, pc.avatar_url) AS image_url FROM users u`,
      );
      expect(beforeWhere(sql).endsWith(`FROM users u ${OWNER_JOINS}`)).toBe(true);
      expect(whereOf(sql)).toBe('u.id IN (:ids)');
      expect(params).toEqual({ ids: [9, 12] });
    });

    it('portfólio: título e imagem do trabalho, e o dono pelo perfil de freelancer', async () => {
      const rows = [{ id: 3 }];
      fakeDb.reply(rows);

      expect(await reportsRepository.portfolioByIds([3])).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        `SELECT i.id, ${OWNER}, i.title, i.image_url FROM freelancer_portfolio_items i`,
      );
      // Do trabalho ao perfil de freelancer, e do perfil ao usuário que é o dono.
      expect(sql).toContain(
        'JOIN profiles_freelancer item_owner ON item_owner.id = i.freelancer_id JOIN users u ON u.id = item_owner.user_id',
      );
      expect(beforeWhere(sql).endsWith(OWNER_JOINS)).toBe(true);
      expect(whereOf(sql)).toBe('i.id IN (:ids)');
      expect(params).toEqual({ ids: [3] });
    });

    it('serviços: o título do serviço, sem imagem, e o dono é quem anuncia', async () => {
      const rows = [{ id: 7 }];
      fakeDb.reply(rows);

      expect(await reportsRepository.servicesByIds([7])).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(`SELECT s.id, ${OWNER}, s.title, NULL AS image_url FROM services s`);
      expect(
        beforeWhere(sql).endsWith(
          `FROM services s JOIN users u ON u.id = s.user_id ${OWNER_JOINS}`,
        ),
      ).toBe(true);
      expect(whereOf(sql)).toBe('s.id IN (:ids)');
      expect(params).toEqual({ ids: [7] });
    });

    it('avaliações: o dono é quem escreveu (não o avaliado), e o trecho é o comentário', async () => {
      const rows = [{ id: 21 }];
      fakeDb.reply(rows);

      expect(await reportsRepository.reviewsByIds([21])).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        `SELECT r.id, ${OWNER}, r.comment AS title, NULL AS image_url FROM reviews r`,
      );
      expect(
        beforeWhere(sql).endsWith(
          `FROM reviews r JOIN users u ON u.id = r.reviewer_id ${OWNER_JOINS}`,
        ),
      ).toBe(true);
      expect(whereOf(sql)).toBe('r.id IN (:ids)');
      expect(params).toEqual({ ids: [21] });
    });

    it('mensagens: o dono é quem enviou, e o trecho é o texto', async () => {
      const rows = [{ id: 55 }];
      fakeDb.reply(rows);

      expect(await reportsRepository.messagesByIds([55, 56])).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        `SELECT m.id, ${OWNER}, m.content AS title, NULL AS image_url FROM messages m`,
      );
      expect(
        beforeWhere(sql).endsWith(
          `FROM messages m JOIN users u ON u.id = m.sender_id ${OWNER_JOINS}`,
        ),
      ).toBe(true);
      expect(whereOf(sql)).toBe('m.id IN (:ids)');
      expect(params).toEqual({ ids: [55, 56] });
    });
  });

  describe('textTarget (autor e texto, ADR 44)', () => {
    it('avaliação: o autor é quem avaliou, com a nota e se já saiu do ar', async () => {
      const row = { owner_id: 12, text: 'Péssimo', rating: 1, file_name: null, removed_at: null };
      fakeDb.reply([row]);

      expect(await reportsRepository.textTarget('review', 21)).toBe(row);

      const { sql, params } = fakeDb.calls[0]!;
      expect(beforeWhere(sql)).toBe(
        'SELECT reviewer_id AS owner_id, comment AS text, rating, NULL AS file_name, removed_at FROM reviews',
      );
      expect(whereOf(sql)).toBe('id = :id LIMIT 1');
      expect(params).toEqual({ id: 21 });
    });

    it('mensagem: o autor é quem enviou, com o nome do anexo; inexistente é undefined', async () => {
      await expect(reportsRepository.textTarget('message', 55)).resolves.toBeUndefined();

      const { sql, params } = fakeDb.calls[0]!;
      expect(beforeWhere(sql)).toBe(
        'SELECT sender_id AS owner_id, content AS text, NULL AS rating, file_name, removed_at FROM messages',
      );
      expect(whereOf(sql)).toBe('id = :id LIMIT 1');
      expect(params).toEqual({ id: 55 });
    });
  });

  it('hasOpenAccountReview: só a revisão por reincidência ainda aberta daquela conta', async () => {
    fakeDb.reply([{ 1: 1 }], []);

    expect(await reportsRepository.hasOpenAccountReview(9)).toBe(true);
    expect(await reportsRepository.hasOpenAccountReview(9)).toBe(false);

    const { sql, params } = fakeDb.calls[0]!;
    expect(beforeWhere(sql)).toBe('SELECT 1 FROM content_reports');
    // Denúncia comum da conta (sem o prefixo) ou revisão já fechada não impede abrir outra.
    expect(whereOf(sql)).toBe(
      "target_type = 'user' AND target_id = :userId AND status IN ('pending', 'reviewing') AND description LIKE 'Reincidência:%' LIMIT 1",
    );
    expect(params).toEqual({ userId: 9 });
  });

  describe('closeGroup (dispensar ou resolver)', () => {
    const group = {
      targetType: 'avatar',
      targetId: 9,
      imageUrl: MEDIA,
      adminId: 1,
      note: 'Não é ofensiva.',
    };

    it('fecha as denúncias abertas do grupo numa transação e devolve quantas fechou', async () => {
      fakeDb.reply({ affectedRows: 3 });

      expect(await reportsRepository.closeGroup({ ...group, status: 'dismissed' })).toBe(3);

      expect(fakeDb.calls).toHaveLength(1);
      expectClosesOpenGroup(0);
      expect(fakeDb.calls[0]!.params).toEqual({ ...group, status: 'dismissed' });
      expectCommitted();
    });

    it('alvo sem imagem fecha pelo image_url nulo; falha desfaz e devolve a conexão', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply(boom);

      await expect(
        reportsRepository.closeGroup({
          ...group,
          targetType: 'service',
          imageUrl: null,
          note: null,
          status: 'actioned',
        }),
      ).rejects.toBe(boom);

      expect(fakeDb.calls[0]!.params).toEqual({
        status: 'actioned',
        adminId: 1,
        note: null,
        targetType: 'service',
        targetId: 9,
        imageUrl: null,
      });
      expectRolledBack();
    });
  });

  describe('removeContentAndClose (ADR 44)', () => {
    const group = {
      targetId: 55,
      imageUrl: null,
      adminId: 1,
      note: 'Pagamento por fora.',
      reportId: 8,
      reason: 'off_platform',
      author: { id: 12, snapshot: 'Me paga no pix por fora' },
    };

    it('mensagem: tira do ar, fecha o grupo e registra a remoção contestável com a cópia do texto, na mesma transação', async () => {
      messageSetRemoved.mockResolvedValue(true);
      fakeDb.reply({ affectedRows: 2 });
      insertRemoval.mockResolvedValue(40);

      expect(
        await reportsRepository.removeContentAndClose({ ...group, targetType: 'message' }),
      ).toEqual({ reports: 2, removalId: 40 });

      expect(messageSetRemoved).toHaveBeenCalledTimes(1);
      expect(messageSetRemoved).toHaveBeenCalledWith(fakeDb.conn, 55, true);
      expect(reviewSetRemoved).not.toHaveBeenCalled();
      expect(fakeDb.calls).toHaveLength(1);
      expectClosesOpenGroup(0);
      // A remoção do conteúdo sempre fecha o grupo como "com ação".
      expect(fakeDb.calls[0]!.params).toEqual({
        status: 'actioned',
        adminId: 1,
        note: 'Pagamento por fora.',
        targetType: 'message',
        targetId: 55,
        imageUrl: null,
      });
      expect(insertRemoval).toHaveBeenCalledTimes(1);
      expect(insertRemoval).toHaveBeenCalledWith(fakeDb.conn, {
        reportId: 8,
        ownerId: 12,
        targetType: 'message',
        targetId: 55,
        imageUrl: null,
        snapshot: 'Me paga no pix por fora',
        reason: 'off_platform',
        note: 'Pagamento por fora.',
        refs: null,
        blocklistId: null,
        adminId: 1,
      });
      expectCommitted();
    });

    it('avaliação: sai do ar pelo repository das avaliações (que recalcula a nota média)', async () => {
      reviewSetRemoved.mockResolvedValue(true);
      fakeDb.reply({ affectedRows: 1 });
      insertRemoval.mockResolvedValue(41);

      expect(
        await reportsRepository.removeContentAndClose({
          ...group,
          targetType: 'review',
          targetId: 21,
        }),
      ).toEqual({ reports: 1, removalId: 41 });

      expect(reviewSetRemoved).toHaveBeenCalledWith(fakeDb.conn, 21, true);
      expect(messageSetRemoved).not.toHaveBeenCalled();
      expect(insertRemoval).toHaveBeenCalledWith(
        fakeDb.conn,
        expect.objectContaining({ targetType: 'review', targetId: 21, ownerId: 12 }),
      );
    });

    it('conteúdo que já estava fora do ar, ou sem autor, só fecha as denúncias: não há remoção a contestar', async () => {
      messageSetRemoved.mockResolvedValue(false);
      fakeDb.reply({ affectedRows: 1 });
      expect(
        await reportsRepository.removeContentAndClose({ ...group, targetType: 'message' }),
      ).toEqual({ reports: 1, removalId: null });

      messageSetRemoved.mockResolvedValue(true);
      fakeDb.reply({ affectedRows: 2 });
      expect(
        await reportsRepository.removeContentAndClose({
          ...group,
          targetType: 'message',
          author: null,
        }),
      ).toEqual({ reports: 2, removalId: null });

      expect(insertRemoval).not.toHaveBeenCalled();
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(2);
    });

    it('se o registro da remoção falha, o conteúdo volta e as denúncias reabrem (rollback)', async () => {
      const boom = new Error('deadlock');
      messageSetRemoved.mockResolvedValue(true);
      fakeDb.reply({ affectedRows: 2 });
      insertRemoval.mockRejectedValue(boom);

      await expect(
        reportsRepository.removeContentAndClose({ ...group, targetType: 'message' }),
      ).rejects.toBe(boom);

      expectRolledBack();
    });
  });

  describe('removeImageAndClose (ADR 39 e 41)', () => {
    const refs = [{ table: 'profiles_freelancer', id: 2 }];
    const print = { sha256: 'abc', dhash: 5n };
    const group = {
      targetType: 'avatar',
      targetId: 9,
      imageUrl: MEDIA,
      adminId: 1,
      note: 'Imagem ofensiva.',
      url: MEDIA,
      print,
      reportId: 4,
      ownerId: 9,
      reason: 'offensive',
    };

    it('anota de onde a imagem sai ANTES de tirar, fecha o grupo, bloqueia o reenvio e registra a remoção', async () => {
      referencesTo.mockResolvedValue(refs);
      clearReferences.mockResolvedValue(1);
      fakeDb.reply({ affectedRows: 2 });
      blocklistAdd.mockResolvedValue(7);
      insertRemoval.mockResolvedValue(31);

      expect(await reportsRepository.removeImageAndClose(group)).toEqual({
        cleared: 1,
        reports: 2,
        removalId: 31,
      });

      expect(referencesTo).toHaveBeenCalledWith(fakeDb.conn, MEDIA);
      expect(clearReferences).toHaveBeenCalledWith(fakeDb.conn, MEDIA);
      // Depois de limpar não sobra referência para anotar: a ordem é o que permite reverter.
      expect(referencesTo.mock.invocationCallOrder[0]!).toBeLessThan(
        clearReferences.mock.invocationCallOrder[0]!,
      );
      expect(fakeDb.calls).toHaveLength(1);
      expectClosesOpenGroup(0);
      expect(fakeDb.calls[0]!.params).toEqual({
        status: 'actioned',
        adminId: 1,
        note: 'Imagem ofensiva.',
        targetType: 'avatar',
        targetId: 9,
        imageUrl: MEDIA,
      });
      expect(blocklistAdd).toHaveBeenCalledTimes(1);
      expect(blocklistAdd).toHaveBeenCalledWith(fakeDb.conn, { print, reportId: 4, adminId: 1 });
      expect(insertRemoval).toHaveBeenCalledTimes(1);
      expect(insertRemoval).toHaveBeenCalledWith(fakeDb.conn, {
        reportId: 4,
        ownerId: 9,
        targetType: 'avatar',
        targetId: 9,
        imageUrl: MEDIA,
        snapshot: null,
        reason: 'offensive',
        note: 'Imagem ofensiva.',
        refs,
        blocklistId: 7,
        adminId: 1,
      });
      expectCommitted();
    });

    it('sem impressão do arquivo (link externo) não bloqueia; a remoção fica registrada sem bloqueio', async () => {
      referencesTo.mockResolvedValue([]);
      clearReferences.mockResolvedValue(0);
      fakeDb.reply({ affectedRows: 1 });
      insertRemoval.mockResolvedValue(32);

      expect(await reportsRepository.removeImageAndClose({ ...group, print: null })).toEqual({
        cleared: 0,
        reports: 1,
        removalId: 32,
      });

      expect(blocklistAdd).not.toHaveBeenCalled();
      expect(insertRemoval).toHaveBeenCalledWith(
        fakeDb.conn,
        expect.objectContaining({ refs: [], blocklistId: null }),
      );
    });

    it('imagem sem dono: limpa, fecha e bloqueia, mas não há remoção contestável', async () => {
      referencesTo.mockResolvedValue(refs);
      clearReferences.mockResolvedValue(1);
      fakeDb.reply({ affectedRows: 1 });
      blocklistAdd.mockResolvedValue(8);

      expect(await reportsRepository.removeImageAndClose({ ...group, ownerId: null })).toEqual({
        cleared: 1,
        reports: 1,
        removalId: null,
      });

      expect(blocklistAdd).toHaveBeenCalledTimes(1);
      expect(insertRemoval).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('se o bloqueio falha, a imagem volta para onde estava e as denúncias reabrem (rollback)', async () => {
      const boom = new Error('ER_DUP_ENTRY');
      referencesTo.mockResolvedValue(refs);
      clearReferences.mockResolvedValue(1);
      fakeDb.reply({ affectedRows: 2 });
      blocklistAdd.mockRejectedValue(boom);

      await expect(reportsRepository.removeImageAndClose(group)).rejects.toBe(boom);

      expect(insertRemoval).not.toHaveBeenCalled();
      expectRolledBack();
    });
  });
});
