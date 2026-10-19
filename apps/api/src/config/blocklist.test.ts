import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../test-support/fake-db';
import { blocklist } from './blocklist';
import { logger } from './logger';

vi.mock('./db', async () => (await import('../test-support/fake-db')).dbModule);

/**
 * Retrato local da moderação (RN-007): distingue suspensão de banimento.
 * A autorização atual consulta o banco; este teste cobre hidratação e manutenção do retrato.
 */
describe('blocklist', () => {
  beforeEach(async () => {
    fakeDb.reset();
    // Zera o mapa do módulo: uma hidratação sem linhas esvazia a lista.
    await blocklist.hydrate();
    fakeDb.reset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('add bloqueia, delete libera e size conta sem repetir o mesmo usuário', () => {
    expect(blocklist.has(7)).toBe(false);
    expect(blocklist.size()).toBe(0);

    blocklist.add(7);
    blocklist.add(7);
    blocklist.add(9);

    expect(blocklist.has(7)).toBe(true);
    expect(blocklist.has(9)).toBe(true);
    expect(blocklist.has(8)).toBe(false);
    expect(blocklist.status(7)).toBe('banned');
    expect(blocklist.status(8)).toBeUndefined();
    expect(blocklist.size()).toBe(2);

    blocklist.delete(7);

    expect(blocklist.has(7)).toBe(false);
    expect(blocklist.has(9)).toBe(true);
    expect(blocklist.size()).toBe(1);
  });

  it('add distingue suspensão de banimento e substitui o estado sem duplicar a conta', () => {
    blocklist.add(7, 'suspended');
    expect(blocklist.status(7)).toBe('suspended');
    expect(blocklist.size()).toBe(1);
    blocklist.add(7, 'banned');
    expect(blocklist.status(7)).toBe('banned');
    expect(blocklist.size()).toBe(1);
    blocklist.delete(7);
    expect(blocklist.status(7)).toBeUndefined();
  });

  it('hydrate lê só suspensos e banidos, guarda o id como número e devolve quantos são', async () => {
    // O driver pode devolver o id como string (BIGINT): has(7) precisa achar mesmo assim.
    fakeDb.reply([
      { id: 3, status: 'suspended' },
      { id: '7', status: 'banned' },
    ]);
    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');

    expect(await blocklist.hydrate()).toBe(2);

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      "SELECT id, status FROM users WHERE status IN ('suspended', 'banned')",
    );
    expect(blocklist.has(3)).toBe(true);
    expect(blocklist.has(7)).toBe(true);
    expect(blocklist.status(3)).toBe('suspended');
    expect(blocklist.status(7)).toBe('banned');
    expect(blocklist.size()).toBe(2);
    // A subida registra quantos estão bloqueados (é o que se confere no log do deploy).
    expect(info.mock.calls).toEqual([[{ blocked: 2 }, 'lista de bloqueio hidratada']]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('o mesmo usuário repetido no resultado conta uma vez', async () => {
    fakeDb.reply([
      { id: 3, status: 'suspended' },
      { id: '3', status: 'suspended' },
      { id: 4, status: 'banned' },
    ]);

    expect(await blocklist.hydrate()).toBe(2);

    expect(blocklist.size()).toBe(2);
  });

  it('hydrate substitui o que havia em memória: quem foi liberado no banco deixa de ser negado', async () => {
    blocklist.add(99);
    fakeDb.reply([{ id: 3, status: 'suspended' }]);

    expect(await blocklist.hydrate()).toBe(1);

    expect(blocklist.has(99)).toBe(false);
    expect(blocklist.has(3)).toBe(true);
    expect(blocklist.status(3)).toBe('suspended');
  });

  it('com o banco fora não derruba a subida e mantém os bloqueios que já estavam em memória', async () => {
    blocklist.add(5);
    const boom = new Error('ECONNREFUSED');
    fakeDb.reply(boom);
    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');

    await expect(blocklist.hydrate()).resolves.toBe(1);

    expect(blocklist.has(5)).toBe(true);
    // A falha não passa em silêncio: fica o aviso com o erro, e nada de "hidratada".
    expect(warn.mock.calls).toEqual([
      [{ err: boom }, 'não foi possível hidratar a lista de bloqueio'],
    ]);
    expect(info).not.toHaveBeenCalled();
  });
});
