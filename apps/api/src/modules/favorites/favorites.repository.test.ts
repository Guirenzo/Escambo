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

  it('o dono de um serviço é o user_id dele, e serviço removido não é encontrado', async () => {
    fakeDb.reply([{ user_id: '9' }], []);

    // O id chega como número, venha o BIGINT como número ou como texto.
    expect(await favoritesRepository.targetOwner('service', 5)).toBe(9);
    expect(await favoritesRepository.targetOwner('service', 404)).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT user_id FROM services WHERE id = :targetId AND deleted_at IS NULL LIMIT 1',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ targetId: 5 });
    expect(fakeDb.calls[1]!.params).toEqual({ targetId: 404 });
  });

  it('o freelancer é o próprio usuário: precisa ter perfil de freelancer e a conta não pode estar excluída', async () => {
    fakeDb.reply([{ user_id: 44 }], []);

    expect(await favoritesRepository.targetOwner('freelancer', 44)).toBe(44);
    expect(await favoritesRepository.targetOwner('freelancer', 45)).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT u.id AS user_id FROM users u JOIN profiles_freelancer pf ON pf.user_id = u.id ' +
        'WHERE u.id = :targetId AND u.deleted_at IS NULL LIMIT 1',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ targetId: 44 });
    expect(fakeDb.calls[1]!.params).toEqual({ targetId: 45 });
  });

  it('a falha do banco sobe para quem chamou', async () => {
    const boom = new Error('ER_LOCK_DEADLOCK');
    fakeDb.reply(boom, boom, boom);

    await expect(favoritesRepository.create(7, 'service', 5)).rejects.toBe(boom);
    await expect(favoritesRepository.remove(7, 'service', 5)).rejects.toBe(boom);
    await expect(favoritesRepository.listForUser(7)).rejects.toBe(boom);
  });
});
