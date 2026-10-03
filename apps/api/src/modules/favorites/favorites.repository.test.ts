import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { favoritesRepository } from './favorites.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository dos favoritos sem banco: o que cada método pede (tabela, filtro, parâmetros) e o que
 * devolve. Todo acesso é preso ao dono (user_id): ninguém lê nem apaga favorito de outra conta.
 */
describe('favoritesRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('favoritar é idempotente: INSERT IGNORE, para o favorito repetido não virar erro', async () => {
    fakeDb.reply({ affectedRows: 1, insertId: 3 });

    expect(await favoritesRepository.create(7, 'service', 5)).toBeUndefined();

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      'INSERT IGNORE INTO favorites (user_id, target_type, target_id) VALUES (:userId, :targetType, :targetId)',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, targetType: 'service', targetId: 5 });
  });

  it('desfavoritar apaga só o favorito daquele dono, daquele tipo e daquele alvo', async () => {
    fakeDb.reply({ affectedRows: 1 });

    expect(await favoritesRepository.remove(7, 'freelancer', 44)).toBeUndefined();

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      'DELETE FROM favorites WHERE user_id = :userId AND target_type = :targetType AND target_id = :targetId',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, targetType: 'freelancer', targetId: 44 });
  });

  it('a lista traz só os favoritos do dono, do mais novo para o mais antigo', async () => {
    const rows = [
      { id: 2, target_type: 'service', target_id: 5, created_at: new Date('2026-01-02T00:00:00Z') },
      {
        id: 1,
        target_type: 'freelancer',
        target_id: 44,
        created_at: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    fakeDb.reply(rows);

    expect(await favoritesRepository.listForUser(7)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toBe(
      'SELECT id, target_type, target_id, created_at FROM favorites WHERE user_id = :userId ORDER BY id DESC',
    );
    expect(params).toEqual({ userId: 7 });
  });

  it('quem não favoritou nada recebe a lista vazia', async () => {
    expect(await favoritesRepository.listForUser(8)).toEqual([]);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 8 });
  });

  it('a falha do banco sobe para quem chamou', async () => {
    const boom = new Error('ER_LOCK_DEADLOCK');
    fakeDb.reply(boom, boom, boom);

    await expect(favoritesRepository.create(7, 'service', 5)).rejects.toBe(boom);
    await expect(favoritesRepository.remove(7, 'service', 5)).rejects.toBe(boom);
    await expect(favoritesRepository.listForUser(7)).rejects.toBe(boom);
  });
});
