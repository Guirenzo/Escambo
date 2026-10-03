import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { IMAGE_COLUMNS, mediaRepository, type ImageRef } from './media.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const conn = fakeDb.conn as unknown as PoolConnection;
const URL = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';

/**
 * Repository das imagens de perfil e portfólio sem banco: onde uma imagem pode aparecer (avatar de
 * freelancer, avatar de cliente, trabalho do portfólio), o que cada método pede e o que devolve.
 */
describe('mediaRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('a lista fechada de lugares que mostram imagem: os dois avatares e o portfólio', () => {
    expect(IMAGE_COLUMNS).toEqual({
      profiles_freelancer: 'avatar_url',
      profiles_client: 'avatar_url',
      freelancer_portfolio_items: 'image_url',
    });
  });

  describe('listReferencedUrls (ADR 36)', () => {
    it('junta as URLs de mídia própria dos três lugares, sem repetir, e devolve só o texto', async () => {
      fakeDb.reply([{ url: URL }, { url: '/api/media/2026/10/01J8ZQ4K7M3VX5R2T9W6Y1B0CE.png' }]);

      expect(await mediaRepository.listReferencedUrls()).toEqual([
        URL,
        '/api/media/2026/10/01J8ZQ4K7M3VX5R2T9W6Y1B0CE.png',
      ]);

      const { sql, params } = fakeDb.calls[0]!;
      // Só imagem hospedada aqui entra: avatar de fora (pravatar, Google) não segura arquivo nenhum.
      expect(sql).toContain(
        "SELECT avatar_url AS url FROM profiles_freelancer WHERE avatar_url LIKE '/api/media/%'",
      );
      expect(sql).toContain(
        "SELECT avatar_url FROM profiles_client WHERE avatar_url LIKE '/api/media/%'",
      );
      expect(sql).toContain(
        "SELECT image_url FROM freelancer_portfolio_items WHERE image_url LIKE '/api/media/%'",
      );
      // UNION (e não UNION ALL): a mesma imagem em dois lugares vem uma vez só.
      expect(sql.match(/UNION/g)).toHaveLength(2);
      expect(sql).not.toContain('UNION ALL');
      expect(params).toBeUndefined();
      // Leitura fora de transação: vai pelo pool.
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    });

    it('sem nenhuma imagem em uso, devolve lista vazia', async () => {
      fakeDb.reply([]);
      expect(await mediaRepository.listReferencedUrls()).toEqual([]);
    });

    it('se a consulta falha, o erro sobe: lista vazia faria o expurgo tratar toda imagem como órfã', async () => {
      const boom = new Error('connect ECONNREFUSED 127.0.0.1:3306');
      fakeDb.reply(boom);
      await expect(mediaRepository.listReferencedUrls()).rejects.toBe(boom);
      expect(fakeDb.calls).toHaveLength(1);
    });
  });

  describe('referencesTo (ADR 41)', () => {
    it('diz em que tabela e em que linha a URL aparece, com o id como número', async () => {
      fakeDb.reply([
        { tbl: 'profiles_freelancer', id: '12' },
        { tbl: 'freelancer_portfolio_items', id: 5 },
      ]);

      expect(await mediaRepository.referencesTo(conn, URL)).toEqual([
        { table: 'profiles_freelancer', id: 12 },
        { table: 'freelancer_portfolio_items', id: 5 },
      ]);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        "SELECT 'profiles_freelancer' AS tbl, id FROM profiles_freelancer WHERE avatar_url = :url",
      );
      expect(sql).toContain(
        "SELECT 'profiles_client', id FROM profiles_client WHERE avatar_url = :url",
      );
      expect(sql).toContain(
        "SELECT 'freelancer_portfolio_items', id FROM freelancer_portfolio_items WHERE image_url = :url",
      );
      // UNION ALL: cada linha que mostra a imagem conta, nenhuma some por parecer repetida.
      expect(sql.match(/UNION ALL/g)).toHaveLength(2);
      expect(params).toEqual({ url: URL });
    });

    it('imagem que ninguém mostra: lista vazia', async () => {
      fakeDb.reply([]);
      expect(await mediaRepository.referencesTo(conn, URL)).toEqual([]);
    });

    it('se a consulta falha, o erro sobe: a remoção não segue sem saber onde a imagem estava', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply(boom);
      await expect(mediaRepository.referencesTo(conn, URL)).rejects.toBe(boom);
    });
  });

  describe('clearReferences (ADR 39)', () => {
    it('limpa a imagem dos três lugares pela URL e devolve quantas linhas mudaram ao todo', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 }, { affectedRows: 3 });

      expect(await mediaRepository.clearReferences(conn, URL)).toBe(4);

      // A limpeza é pela URL e não pelo dono: qualquer um pode ter colado o endereço no perfil.
      expect(fakeDb.sqls()).toEqual([
        'UPDATE profiles_freelancer SET avatar_url = NULL WHERE avatar_url = :url',
        'UPDATE profiles_client SET avatar_url = NULL WHERE avatar_url = :url',
        'UPDATE freelancer_portfolio_items SET image_url = NULL WHERE image_url = :url',
      ]);
      for (const call of fakeDb.calls) expect(call.params).toEqual({ url: URL });
    });

    it('quando ninguém mostrava a imagem, devolve zero', async () => {
      fakeDb.reply({ affectedRows: 0 }, { affectedRows: 0 }, { affectedRows: 0 });
      expect(await mediaRepository.clearReferences(conn, URL)).toBe(0);
      expect(fakeDb.calls).toHaveLength(3);
    });

    it('se uma das limpezas falha, o erro sobe (quem chamou desfaz a transação)', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply({ affectedRows: 1 }, boom);

      await expect(mediaRepository.clearReferences(conn, URL)).rejects.toBe(boom);
      expect(fakeDb.calls).toHaveLength(2);
    });
  });

  describe('restoreReferences (ADR 41)', () => {
    it('recoloca a imagem em cada linha de onde saiu, na coluna da tabela, só se o campo segue vazio', async () => {
      const refs: ImageRef[] = [
        { table: 'profiles_freelancer', id: 12 },
        { table: 'profiles_client', id: 8 },
        { table: 'freelancer_portfolio_items', id: 5 },
      ];
      // A pessoa da segunda linha já pôs outra foto: a nova fica e a linha não conta.
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 }, { affectedRows: 1 });

      expect(await mediaRepository.restoreReferences(conn, URL, refs)).toBe(2);

      expect(fakeDb.sqls()).toEqual([
        'UPDATE profiles_freelancer SET avatar_url = :url WHERE id = :id AND avatar_url IS NULL',
        'UPDATE profiles_client SET avatar_url = :url WHERE id = :id AND avatar_url IS NULL',
        'UPDATE freelancer_portfolio_items SET image_url = :url WHERE id = :id AND image_url IS NULL',
      ]);
      expect(fakeDb.calls.map((c) => c.params)).toEqual([
        { url: URL, id: 12 },
        { url: URL, id: 8 },
        { url: URL, id: 5 },
      ]);
    });

    it('tabela fora da lista fechada é ignorada: o nome dela nunca chega ao SQL', async () => {
      const refs = [
        { table: 'users; DROP TABLE users', id: 1 },
        { table: 'profiles_client', id: 8 },
      ] as unknown as ImageRef[];
      fakeDb.reply({ affectedRows: 1 });

      expect(await mediaRepository.restoreReferences(conn, URL, refs)).toBe(1);

      expect(fakeDb.sqls()).toEqual([
        'UPDATE profiles_client SET avatar_url = :url WHERE id = :id AND avatar_url IS NULL',
      ]);
    });

    it('sem linhas para recolocar, não toca no banco', async () => {
      expect(await mediaRepository.restoreReferences(conn, URL, [])).toBe(0);
      expect(fakeDb.calls).toHaveLength(0);
    });

    it('se uma recolocação falha, o erro sobe e as seguintes não são tentadas (quem chamou desfaz a transação)', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({ affectedRows: 1 }, boom);

      await expect(
        mediaRepository.restoreReferences(conn, URL, [
          { table: 'profiles_freelancer', id: 12 },
          { table: 'profiles_client', id: 8 },
          { table: 'freelancer_portfolio_items', id: 5 },
        ]),
      ).rejects.toBe(boom);
      expect(fakeDb.calls).toHaveLength(2);
    });
  });

  describe('transação de quem chama (ADR 39 e 41)', () => {
    /** Uma conexão só do teste: o que passar por ela não aparece no banco falso (que é o pool). */
    function ownConnection(...results: unknown[]) {
      const query = vi.fn(async (_sql: string, _params?: unknown) => [results.shift() ?? [], []]);
      return { query, asConn: { query } as unknown as PoolConnection };
    }

    it('referencesTo lê pela conexão recebida, para ver o que a própria transação já mudou', async () => {
      const tx = ownConnection([{ tbl: 'profiles_client', id: 8 }]);

      expect(await mediaRepository.referencesTo(tx.asConn, URL)).toEqual([
        { table: 'profiles_client', id: 8 },
      ]);

      expect(tx.query).toHaveBeenCalledTimes(1);
      expect(tx.query.mock.calls[0]![1]).toEqual({ url: URL });
      expect(fakeDb.calls).toHaveLength(0);
    });

    it('clearReferences limpa pela conexão recebida: se a remoção falhar adiante, a limpeza é desfeita junto', async () => {
      const tx = ownConnection({ affectedRows: 2 }, { affectedRows: 1 }, { affectedRows: 0 });

      expect(await mediaRepository.clearReferences(tx.asConn, URL)).toBe(3);

      expect(tx.query).toHaveBeenCalledTimes(3);
      for (const [sql, params] of tx.query.mock.calls) {
        expect(sql).toMatch(/^UPDATE \w+ SET \w+ = NULL WHERE \w+ = :url$/);
        expect(params).toEqual({ url: URL });
      }
      expect(fakeDb.calls).toHaveLength(0);
    });

    it('restoreReferences recoloca pela conexão recebida, na mesma transação que decide a contestação', async () => {
      const tx = ownConnection({ affectedRows: 1 });

      expect(
        await mediaRepository.restoreReferences(tx.asConn, URL, [
          { table: 'freelancer_portfolio_items', id: 5 },
        ]),
      ).toBe(1);

      expect(tx.query.mock.calls).toEqual([
        [
          'UPDATE freelancer_portfolio_items SET image_url = :url WHERE id = :id AND image_url IS NULL',
          { url: URL, id: 5 },
        ],
      ]);
      expect(fakeDb.calls).toHaveLength(0);
    });
  });
});
