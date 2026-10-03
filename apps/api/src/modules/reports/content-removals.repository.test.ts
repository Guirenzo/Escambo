import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { contentRemovalsRepository } from './content-removals.repository';

const { blocklistRemove, restoreReferences, reviewSetRemoved, messageSetRemoved } = vi.hoisted(
  () => ({
    blocklistRemove: vi.fn(),
    restoreReferences: vi.fn(),
    reviewSetRemoved: vi.fn(),
    messageSetRemoved: vi.fn(),
  }),
);
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../media/media.blocklist', () => ({ mediaBlocklist: { remove: blocklistRemove } }));
vi.mock('../media/media.repository', () => ({ mediaRepository: { restoreReferences } }));
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { setRemoved: reviewSetRemoved },
}));
vi.mock('../messaging/messaging.repository', () => ({
  messagingRepository: { setRemoved: messageSetRemoved },
}));

const MEDIA = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
/** O trabalho do portfólio entra só para dar o título; remoção de outro tipo não casa com ele. */
const WORK_JOIN =
  "FROM content_removals r LEFT JOIN freelancer_portfolio_items pi ON r.target_type = 'portfolio_item' AND pi.id = r.target_id";

/** O filtro de uma instrução, com o que vem depois dele (ordem e limite). */
const whereOf = (sql: string): string => sql.slice(sql.indexOf(' WHERE ') + ' WHERE '.length);
/** O que vem antes do filtro: o que a instrução lê ou grava, e em que tabela. */
const beforeWhere = (sql: string): string => sql.slice(0, sql.indexOf(' WHERE '));
/** Onde a instrução rodou: na conexão da transação ou direto no pool (fora dela). */
const ranOn = (index: number): unknown => fakeDb.conn.query.mock.contexts[index];

/**
 * As colunas que o service lê de uma remoção: de quem é (só o dono contesta), a situação e as datas
 * (prazo e decisão), o arquivo em quarentena e o que a reversão precisa para recolocar a imagem.
 * Coluna que some da leitura chega `undefined` ao service sem nenhum erro de tipo.
 */
const REMOVAL_COLUMNS = [
  'r.id',
  'r.report_id',
  'r.owner_id',
  'r.target_type',
  'r.target_id',
  'r.image_url',
  'r.content_snapshot',
  'r.reason',
  'r.note',
  'r.cleared_refs',
  'r.quarantine_file',
  'r.blocklist_id',
  'r.removed_by',
  'r.removed_at',
  'r.status',
  'r.appeal_text',
  'r.appealed_at',
  'r.decided_by',
  'r.decided_at',
  'r.decision_note',
  'r.file_purged_at',
  'pi.title AS work_title',
];
const expectRemovalColumns = (sql: string): void => {
  const selected = sql.slice('SELECT '.length, sql.indexOf(' FROM content_removals r')).split(', ');
  expect(selected).toEqual(expect.arrayContaining(REMOVAL_COLUMNS));
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
 * Repository das remoções e contestações (ADR 41 e 44) sem banco: o que cada método pede (tabela,
 * filtro, ordem, parâmetros), o que devolve a partir da resposta e como trata a transação. Se o SQL
 * roda no MySQL é da integração.
 */
describe('contentRemovalsRepository', () => {
  beforeEach(() => {
    fakeDb.reset();
    vi.resetAllMocks();
  });

  describe('insert', () => {
    const data = {
      reportId: 4,
      ownerId: 9,
      targetType: 'avatar' as const,
      targetId: 9,
      imageUrl: MEDIA,
      snapshot: null,
      reason: 'offensive',
      note: 'Imagem ofensiva.',
      refs: [{ table: 'profiles_freelancer' as const, id: 2 }],
      blocklistId: 7,
      adminId: 1,
    };

    it('grava na conexão da transação de quem chamou (não no pool) e devolve o id da remoção', async () => {
      const query = vi.fn(async (_sql: string, _params: unknown) => [{ insertId: 31 }, []]);
      const conn = { query } as unknown as PoolConnection;

      expect(await contentRemovalsRepository.insert(conn, data)).toBe(31);

      expect(fakeDb.calls).toHaveLength(0);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0]!;
      const flat = sql.replace(/\s+/g, ' ');
      expect(flat).toContain(
        'INSERT INTO content_removals (report_id, owner_id, target_type, target_id, image_url, content_snapshot, reason, note, cleared_refs, blocklist_id, removed_by)',
      );
      expect(flat).toContain(
        'VALUES (:reportId, :ownerId, :targetType, :targetId, :imageUrl, :snapshot, :reason, :note, :refs, :blocklistId, :adminId)',
      );
      // De onde a imagem saiu vai como JSON, para a reversão saber onde recolocar.
      expect(params).toEqual({ ...data, refs: '[{"table":"profiles_freelancer","id":2}]' });
    });

    it('remoção de texto (sem referências de imagem) grava cleared_refs nulo, não a string "null"', async () => {
      fakeDb.reply({ insertId: 40 });
      const text = {
        ...data,
        targetType: 'message' as const,
        targetId: 55,
        imageUrl: null,
        snapshot: 'Me paga no pix',
        refs: null,
        blocklistId: null,
      };

      expect(
        await contentRemovalsRepository.insert(fakeDb.conn as unknown as PoolConnection, text),
      ).toBe(40);

      expect(fakeDb.calls[0]!.params).toEqual(text);
    });
  });

  it('setQuarantineFile anota o arquivo da quarentena só naquela remoção', async () => {
    await contentRemovalsRepository.setQuarantineFile(31, '31.webp');
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE content_removals SET quarantine_file = :file WHERE id = :id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 31, file: '31.webp' });
  });

  it('findById devolve a primeira linha com o título do trabalho, ou undefined', async () => {
    const row = { id: 31, owner_id: 9, work_title: 'Logo' };
    fakeDb.reply([row], []);

    expect(await contentRemovalsRepository.findById(31)).toBe(row);
    expect(await contentRemovalsRepository.findById(99)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expectRemovalColumns(sql);
    expect(sql).toContain(`${WORK_JOIN} WHERE r.id = :id LIMIT 1`);
    expect(params).toEqual({ id: 31 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 99 });
  });

  it('listForOwner traz só as remoções do dono, da mais recente para a mais antiga', async () => {
    const rows = [{ id: 32 }, { id: 31 }];
    fakeDb.reply(rows);

    expect(await contentRemovalsRepository.listForOwner(9)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expectRemovalColumns(sql);
    expect(beforeWhere(sql).endsWith(WORK_JOIN)).toBe(true);
    // Sem limite e sem filtro de situação: o dono vê todas as remoções dele, inclusive as decididas.
    expect(whereOf(sql)).toBe('r.owner_id = :ownerId ORDER BY r.removed_at DESC, r.id DESC');
    expect(params).toEqual({ ownerId: 9 });
  });

  describe('strikeStats (reincidência, ADR 41 e 44)', () => {
    const since = new Date('2026-03-24T12:00:00Z');

    it('conta as remoções não revertidas do dono desde a janela; imagem conta à parte', async () => {
      fakeDb.reply([{ strikes: '3', image_strikes: '2', last_image: '2026-09-15T12:00:00.000Z' }]);

      const stats = await contentRemovalsRepository.strikeStats(9, since);

      // O driver devolve contagem como string: sai número, e a data da última imagem sai Date.
      expect(stats).toEqual({
        strikes: 3,
        imageStrikes: 2,
        lastImage: new Date('2026-09-15T12:00:00Z'),
      });
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT COUNT(*) AS strikes');
      expect(sql).toContain(
        "COALESCE(SUM(target_type IN ('avatar', 'portfolio_item')), 0) AS image_strikes",
      );
      expect(sql).toContain(
        "MAX(CASE WHEN target_type IN ('avatar', 'portfolio_item') THEN removed_at END) AS last_image",
      );
      // Remoção revertida (overturned) não é ocorrência.
      expect(sql).toContain(
        "FROM content_removals WHERE owner_id = :ownerId AND status IN ('removed', 'appealed', 'upheld') AND removed_at >= :since",
      );
      expect(params).toEqual({ ownerId: 9, since });
    });

    it('sem imagem removida, ou sem linha nenhuma, não há data nem ocorrência', async () => {
      fakeDb.reply([{ strikes: 1, image_strikes: 0, last_image: null }], []);

      expect(await contentRemovalsRepository.strikeStats(9, since)).toEqual({
        strikes: 1,
        imageStrikes: 0,
        lastImage: null,
      });
      expect(await contentRemovalsRepository.strikeStats(9, since)).toEqual({
        strikes: 0,
        imageStrikes: 0,
        lastImage: null,
      });
    });
  });

  it('appeal só registra a contestação do dono, e só de remoção ainda não contestada', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await contentRemovalsRepository.appeal(31, 9, 'É a minha foto.')).toBe(true);
    // Segunda tentativa (ou de outra pessoa): nada muda, e o service responde 409.
    expect(await contentRemovalsRepository.appeal(31, 9, 'De novo.')).toBe(false);

    const { sql, params } = fakeDb.calls[0]!;
    expect(beforeWhere(sql)).toBe(
      "UPDATE content_removals SET status = 'appealed', appeal_text = :text, appealed_at = NOW()",
    );
    // O dono e a situação entram no filtro: a disputa entre dois pedidos se resolve no banco.
    expect(whereOf(sql)).toBe("id = :id AND owner_id = :ownerId AND status = 'removed'");
    expect(params).toEqual({ id: 31, ownerId: 9, text: 'É a minha foto.' });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 31, ownerId: 9, text: 'De novo.' });
  });

  describe('listAppeals (fila do admin)', () => {
    it('pendentes: só as contestadas, da mais antiga para a mais nova, com o dono', async () => {
      const rows = [{ id: 31, owner_ulid: '01OWNER', owner_name: 'Bruno Costa' }];
      fakeDb.reply(rows);

      expect(await contentRemovalsRepository.listAppeals('pending', 200)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expectRemovalColumns(sql);
      expect(sql).toContain(
        'u.ulid AS owner_ulid, COALESCE(pf.full_name, pc.full_name) AS owner_name',
      );
      expect(sql).toContain(`${WORK_JOIN} JOIN users u ON u.id = r.owner_id`);
      expect(sql).toContain('LEFT JOIN profiles_freelancer pf ON pf.user_id = u.id');
      expect(sql).toContain('LEFT JOIN profiles_client pc ON pc.user_id = u.id');
      expect(whereOf(sql)).toBe(
        "r.status = 'appealed' ORDER BY r.appealed_at ASC, r.id ASC LIMIT 200",
      );
      expect(params).toBeUndefined();
    });

    it('decididas: mantidas e revertidas que foram contestadas, da decisão mais recente para a mais antiga', async () => {
      await contentRemovalsRepository.listAppeals('decided', 50.9);

      const { sql } = fakeDb.calls[0]!;
      // Remoção cujo prazo venceu sem contestação não é decisão do admin: fica de fora.
      expect(whereOf(sql)).toBe(
        "r.status IN ('upheld', 'overturned') AND r.appealed_at IS NOT NULL ORDER BY r.decided_at DESC, r.id ASC LIMIT 50",
      );
    });
  });

  it('uphold só decide contestação pendente, com o admin e a nota', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await contentRemovalsRepository.uphold(31, 1, 'Continua ofensiva.')).toBe(true);
    expect(await contentRemovalsRepository.uphold(31, 1, null)).toBe(false);

    const { sql } = fakeDb.calls[0]!;
    expect(beforeWhere(sql)).toBe(
      "UPDATE content_removals SET status = 'upheld', decided_by = :adminId, decided_at = NOW(), decision_note = :note",
    );
    // Só contestação pendente: quem chega depois de outra decisão não muda nada.
    expect(whereOf(sql)).toBe("id = :id AND status = 'appealed'");
    expect(fakeDb.calls[0]!.params).toEqual({ id: 31, adminId: 1, note: 'Continua ofensiva.' });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 31, adminId: 1, note: null });
  });

  describe('overturn (reverter remoção de imagem)', () => {
    const refs = [{ table: 'profiles_freelancer' as const, id: 2 }];
    const decision = {
      id: 31,
      adminId: 1,
      note: 'Foto legítima.',
      url: MEDIA,
      refs,
      blocklistId: 7,
      restoreRefs: true,
      fileBack: true,
    };

    it('decide, tira do bloqueio e recoloca a imagem na mesma transação', async () => {
      fakeDb.reply({ affectedRows: 1 });
      restoreReferences.mockResolvedValue(2);

      expect(await contentRemovalsRepository.overturn(decision)).toEqual({
        decided: true,
        restored: 2,
      });

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        "UPDATE content_removals SET status = 'overturned', decided_by = :adminId, decided_at = NOW(), decision_note = :note",
      );
      // O arquivo voltou para o lugar: a remoção deixa de apontar para a quarentena.
      expect(sql).toContain('quarantine_file = IF(:fileBack, NULL, quarantine_file)');
      expect(whereOf(sql)).toBe("id = :id AND status = 'appealed'");
      // A decisão roda na conexão da transação: se recolocar a imagem falhar, ela é desfeita junto.
      expect(ranOn(0)).toBe(fakeDb.conn);
      expect(params).toEqual({ id: 31, adminId: 1, note: 'Foto legítima.', fileBack: 1 });
      expect(blocklistRemove).toHaveBeenCalledTimes(1);
      expect(blocklistRemove).toHaveBeenCalledWith(fakeDb.conn, 7);
      expect(restoreReferences).toHaveBeenCalledTimes(1);
      expect(restoreReferences).toHaveBeenCalledWith(fakeDb.conn, MEDIA, refs);
      expectCommitted();
    });

    it('sem arquivo de volta: a quarentena fica anotada e nenhuma referência é recolocada', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(
        await contentRemovalsRepository.overturn({
          ...decision,
          note: null,
          blocklistId: null,
          restoreRefs: false,
          fileBack: false,
        }),
      ).toEqual({ decided: true, restored: 0 });

      expect(fakeDb.calls[0]!.params).toEqual({ id: 31, adminId: 1, note: null, fileBack: 0 });
      // Link externo ou imagem sem impressão não entrou na lista de bloqueio: nada a tirar.
      expect(blocklistRemove).not.toHaveBeenCalled();
      expect(restoreReferences).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('bloqueio e referências são independentes: arquivo que não voltou ainda sai do bloqueio; link externo volta sem bloqueio para tirar', async () => {
      // Imagem interna cujo arquivo sumiu: a decisão libera o reenvio, mas não recoloca referência.
      fakeDb.reply({ affectedRows: 1 });
      expect(
        await contentRemovalsRepository.overturn({
          ...decision,
          restoreRefs: false,
          fileBack: false,
        }),
      ).toEqual({ decided: true, restored: 0 });
      expect(blocklistRemove).toHaveBeenCalledTimes(1);
      expect(blocklistRemove).toHaveBeenCalledWith(fakeDb.conn, 7);
      expect(restoreReferences).not.toHaveBeenCalled();

      // Link externo: nunca entrou no bloqueio, mas a imagem volta para onde estava.
      vi.clearAllMocks();
      fakeDb.reply({ affectedRows: 1 });
      restoreReferences.mockResolvedValue(1);
      expect(
        await contentRemovalsRepository.overturn({
          ...decision,
          url: 'https://i.pravatar.cc/150',
          blocklistId: null,
          restoreRefs: true,
          fileBack: false,
        }),
      ).toEqual({ decided: true, restored: 1 });
      expect(blocklistRemove).not.toHaveBeenCalled();
      expect(restoreReferences).toHaveBeenCalledTimes(1);
      expect(restoreReferences).toHaveBeenCalledWith(
        fakeDb.conn,
        'https://i.pravatar.cc/150',
        refs,
      );
      expect(fakeDb.calls[1]!.params).toEqual({
        id: 31,
        adminId: 1,
        note: 'Foto legítima.',
        fileBack: 0,
      });
    });

    it('se tirar do bloqueio falha, a decisão é desfeita e a imagem não é recolocada', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply({ affectedRows: 1 });
      blocklistRemove.mockRejectedValue(boom);

      await expect(contentRemovalsRepository.overturn(decision)).rejects.toBe(boom);

      expect(restoreReferences).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('contestação que já não está pendente: não decide, não mexe no bloqueio nem na imagem', async () => {
      fakeDb.reply({ affectedRows: 0 });

      expect(await contentRemovalsRepository.overturn(decision)).toEqual({
        decided: false,
        restored: 0,
      });

      expect(blocklistRemove).not.toHaveBeenCalled();
      expect(restoreReferences).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se recolocar a imagem falha, a decisão é desfeita e a conexão é devolvida', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({ affectedRows: 1 });
      restoreReferences.mockRejectedValue(boom);

      await expect(contentRemovalsRepository.overturn(decision)).rejects.toBe(boom);

      expectRolledBack();
    });
  });

  describe('overturnContent (reverter remoção de avaliação ou mensagem, ADR 44)', () => {
    const decision = { id: 31, adminId: 1, note: 'Era brincadeira.', targetId: 55 };

    it('avaliação: decide e devolve ao ar pelo repository das avaliações (que recalcula a nota)', async () => {
      fakeDb.reply({ affectedRows: 1 });
      reviewSetRemoved.mockResolvedValue(true);

      expect(
        await contentRemovalsRepository.overturnContent({ ...decision, targetType: 'review' }),
      ).toEqual({ decided: true, restored: 1 });

      const { sql, params } = fakeDb.calls[0]!;
      expect(beforeWhere(sql)).toBe(
        "UPDATE content_removals SET status = 'overturned', decided_by = :adminId, decided_at = NOW(), decision_note = :note",
      );
      expect(whereOf(sql)).toBe("id = :id AND status = 'appealed'");
      // Na conexão da transação: se devolver o conteúdo falhar, a decisão é desfeita junto.
      expect(ranOn(0)).toBe(fakeDb.conn);
      expect(params).toEqual({ id: 31, adminId: 1, note: 'Era brincadeira.' });
      expect(reviewSetRemoved).toHaveBeenCalledTimes(1);
      expect(reviewSetRemoved).toHaveBeenCalledWith(fakeDb.conn, 55, false);
      expect(messageSetRemoved).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('mensagem: devolve ao chat; conteúdo que já não estava removido conta zero restaurado', async () => {
      fakeDb.reply({ affectedRows: 1 });
      messageSetRemoved.mockResolvedValue(false);

      expect(
        await contentRemovalsRepository.overturnContent({ ...decision, targetType: 'message' }),
      ).toEqual({ decided: true, restored: 0 });

      expect(messageSetRemoved).toHaveBeenCalledTimes(1);
      expect(messageSetRemoved).toHaveBeenCalledWith(fakeDb.conn, 55, false);
      expect(reviewSetRemoved).not.toHaveBeenCalled();
      expectCommitted();
    });

    it('contestação que já não está pendente: não decide e o conteúdo fica como está', async () => {
      fakeDb.reply({ affectedRows: 0 });

      expect(
        await contentRemovalsRepository.overturnContent({ ...decision, targetType: 'review' }),
      ).toEqual({ decided: false, restored: 0 });

      expect(reviewSetRemoved).not.toHaveBeenCalled();
      expect(messageSetRemoved).not.toHaveBeenCalled();
    });

    it('se devolver o conteúdo falha, a decisão é desfeita', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply({ affectedRows: 1 });
      messageSetRemoved.mockRejectedValue(boom);

      await expect(
        contentRemovalsRepository.overturnContent({ ...decision, targetType: 'message' }),
      ).rejects.toBe(boom);

      expectRolledBack();
    });
  });

  it('markFilePurged marca a hora em que o arquivo saiu da quarentena, só naquela remoção', async () => {
    await contentRemovalsRepository.markFilePurged(31);
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE content_removals SET file_purged_at = NOW() WHERE id = :id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 31 });
  });

  it('listQuarantineToPurge: só arquivo ainda em quarentena, de remoção mantida ou sem contestação depois do prazo', async () => {
    const rows = [{ id: 30, quarantine_file: '30.webp' }];
    const cutoff = new Date('2026-09-06T12:00:00Z');
    fakeDb.reply(rows);

    expect(await contentRemovalsRepository.listQuarantineToPurge(cutoff, 500.7)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expectRemovalColumns(sql);
    expect(beforeWhere(sql).endsWith(WORK_JOIN)).toBe(true);
    // O filtro inteiro: contestação pendente ('appealed') segura o arquivo até a decisão, e remoção
    // revertida não entra (o arquivo dela voltou para o lugar).
    expect(whereOf(sql)).toBe(
      "r.quarantine_file IS NOT NULL AND r.file_purged_at IS NULL AND (r.status = 'upheld' OR (r.status = 'removed' AND r.removed_at < :appealCutoff)) ORDER BY r.id ASC LIMIT 500",
    );
    expect(params).toEqual({ appealCutoff: cutoff });
  });

  it('listQuarantinedForOwner: tudo que o titular ainda tem em quarentena, em qualquer situação (LGPD)', async () => {
    const rows = [{ id: 31, quarantine_file: '31.webp' }];
    fakeDb.reply(rows);

    expect(await contentRemovalsRepository.listQuarantinedForOwner(9)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expectRemovalColumns(sql);
    expect(beforeWhere(sql).endsWith(WORK_JOIN)).toBe(true);
    // O filtro inteiro: a situação da remoção (contestada, mantida) não segura o arquivo aqui.
    expect(whereOf(sql)).toBe(
      'r.owner_id = :ownerId AND r.quarantine_file IS NOT NULL AND r.file_purged_at IS NULL',
    );
    expect(params).toEqual({ ownerId: 9 });
  });
});
