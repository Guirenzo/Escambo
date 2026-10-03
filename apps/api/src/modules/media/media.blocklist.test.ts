import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { mediaBlocklist } from './media.blocklist';
import { PERCEPTUAL_MATCH_BITS } from './media.image';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const conn = fakeDb.conn as unknown as PoolConnection;
const SHA = 'a3f1c0de'.repeat(8);
/** Maior que 2^53: só chega inteiro ao banco se for como texto. */
const DHASH = 0xfedcba9876543210n;

/**
 * Lista de bloqueio das imagens removidas pela moderação (ADR 39) sem banco: o que é gravado, o que
 * a consulta compara e o que cada método devolve.
 */
describe('mediaBlocklist', () => {
  beforeEach(() => fakeDb.reset());

  describe('add', () => {
    it('grava a assinatura, a impressão, a denúncia e quem removeu, e devolve o id da linha', async () => {
      fakeDb.reply({ insertId: 17, affectedRows: 1 });

      const id = await mediaBlocklist.add(conn, {
        print: { sha256: SHA, dhash: DHASH },
        reportId: 40,
        adminId: 2,
      });

      expect(id).toBe(17);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('INSERT INTO media_blocklist (sha256, dhash, report_id, created_by)');
      expect(sql).toContain('VALUES (:sha256, :dhash, :reportId, :adminId)');
      // A impressão de 64 bits vai como texto decimal: como número JS perderia os bits baixos.
      expect(params).toEqual({
        sha256: SHA,
        dhash: '18364758544493064720',
        reportId: 40,
        adminId: 2,
      });
    });

    it('imagem sem detalhe (impressão nula) entra só com a assinatura exata', async () => {
      fakeDb.reply({ insertId: 18, affectedRows: 1 });

      await mediaBlocklist.add(conn, {
        print: { sha256: SHA, dhash: null },
        reportId: 41,
        adminId: 2,
      });

      expect(fakeDb.calls[0]!.params).toEqual({
        sha256: SHA,
        dhash: null,
        reportId: 41,
        adminId: 2,
      });
    });

    it('impressão zero não é confundida com "sem impressão"', async () => {
      fakeDb.reply({ insertId: 19, affectedRows: 1 });
      await mediaBlocklist.add(conn, {
        print: { sha256: SHA, dhash: 0n },
        reportId: 1,
        adminId: 2,
      });
      expect(fakeDb.calls[0]!.params).toMatchObject({ dhash: '0' });
    });
  });

  it('remove tira a linha pelo id (remoção revertida numa contestação, ADR 41)', async () => {
    fakeDb.reply({ affectedRows: 1 });

    expect(await mediaBlocklist.remove(conn, 17)).toBeUndefined();

    expect(fakeDb.calls).toEqual([
      { sql: 'DELETE FROM media_blocklist WHERE id = :id', params: { id: 17 } },
    ]);
  });

  it('add e remove escrevem pela conexão recebida: entram e saem junto com a transação da moderação', async () => {
    // Uma conexão só do teste: o que passar por ela não aparece no banco falso (que é o pool).
    const replies: unknown[] = [{ insertId: 23, affectedRows: 1 }, { affectedRows: 1 }];
    const query = vi.fn(async (_sql: string, _params?: unknown) => [replies.shift(), []]);
    const tx = { query } as unknown as PoolConnection;

    expect(
      await mediaBlocklist.add(tx, {
        print: { sha256: SHA, dhash: null },
        reportId: 40,
        adminId: 2,
      }),
    ).toBe(23);
    await mediaBlocklist.remove(tx, 23);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toContain('INSERT INTO media_blocklist');
    expect(query.mock.calls[0]![1]).toEqual({ sha256: SHA, dhash: null, reportId: 40, adminId: 2 });
    expect(query.mock.calls[1]).toEqual(['DELETE FROM media_blocklist WHERE id = :id', { id: 23 }]);
    expect(fakeDb.calls).toHaveLength(0);
  });

  it('se a gravação na lista falha, o erro sobe (quem chamou desfaz a remoção)', async () => {
    const boom = new Error('ER_DUP_ENTRY');
    fakeDb.reply(boom);
    await expect(
      mediaBlocklist.add(conn, { print: { sha256: SHA, dhash: DHASH }, reportId: 40, adminId: 2 }),
    ).rejects.toBe(boom);
  });

  describe('matches', () => {
    it('bate pela assinatura exata ou pela impressão perceptual dentro da tolerância', async () => {
      fakeDb.reply([{ id: 17 }]);

      expect(await mediaBlocklist.matches({ sha256: SHA, dhash: DHASH })).toBe(true);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT id FROM media_blocklist WHERE sha256 = :sha256 OR (');
      // A comparação perceptual só vale quando as DUAS imagens têm impressão E a diferença cabe na
      // tolerância: os três predicados ficam juntos, dentro do mesmo parêntese.
      expect(sql).toContain(
        'OR (:dhash IS NOT NULL AND dhash IS NOT NULL AND BIT_COUNT(dhash ^ CAST(:dhash AS UNSIGNED)) <= :maxBits) LIMIT 1',
      );
      expect(sql.endsWith('LIMIT 1')).toBe(true);
      expect(params).toEqual({
        sha256: SHA,
        dhash: '18364758544493064720',
        maxBits: PERCEPTUAL_MATCH_BITS,
      });
      // A tolerância é a do ADR 39; se mudar, a decisão precisa mudar junto.
      expect(PERCEPTUAL_MATCH_BITS).toBe(6);
      // Consulta do envio, fora de transação: vai pelo pool.
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    });

    it('imagem lisa (sem impressão) é comparada só pela assinatura', async () => {
      fakeDb.reply([]);

      expect(await mediaBlocklist.matches({ sha256: SHA, dhash: null })).toBe(false);

      expect(fakeDb.calls[0]!.params).toEqual({
        sha256: SHA,
        dhash: null,
        maxBits: PERCEPTUAL_MATCH_BITS,
      });
    });

    it('lista sem nada parecido: não bate', async () => {
      fakeDb.reply([]);
      expect(await mediaBlocklist.matches({ sha256: SHA, dhash: DHASH })).toBe(false);
    });

    it('banco fora do ar: o erro sobe, o envio não passa como se a imagem estivesse liberada', async () => {
      const boom = new Error('connect ECONNREFUSED');
      fakeDb.reply(boom);
      await expect(mediaBlocklist.matches({ sha256: SHA, dhash: DHASH })).rejects.toBe(boom);
    });
  });
});
