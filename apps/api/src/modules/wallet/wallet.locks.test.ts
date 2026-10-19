import type { PoolConnection } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { lockWalletRows, lockWallets, lockWalletUsers } from './wallet.locks';

describe('ordem das travas financeiras', () => {
  it('trava contas antes das carteiras, em ordem numérica e sem duplicar participantes', async () => {
    const query = vi.fn().mockResolvedValue([[], []]);
    await lockWallets({ query } as unknown as PoolConnection, [20, 3, 20], [9, 3]);
    expect(query.mock.calls).toEqual([
      ['SELECT id FROM users WHERE id = :uid FOR SHARE', { uid: 3 }],
      ['SELECT id FROM users WHERE id = :uid FOR SHARE', { uid: 9 }],
      ['SELECT id FROM users WHERE id = :uid FOR SHARE', { uid: 20 }],
      ['SELECT user_id FROM wallets WHERE user_id = :userId FOR UPDATE', { userId: 3 }],
      ['SELECT user_id FROM wallets WHERE user_id = :userId FOR UPDATE', { userId: 20 }],
    ]);
  });

  it('inclui a conta exclusiva na mesma ordem, sem promover uma trava compartilhada depois', async () => {
    const query = vi.fn().mockResolvedValue([[], []]);
    await lockWalletUsers({ query } as unknown as PoolConnection, [20, 3, 3], [9, 3]);
    expect(query.mock.calls).toEqual([
      ['SELECT id FROM users WHERE id = :uid FOR UPDATE', { uid: 3 }],
      ['SELECT id FROM users WHERE id = :uid FOR UPDATE', { uid: 9 }],
      ['SELECT id FROM users WHERE id = :uid FOR SHARE', { uid: 20 }],
    ]);
  });

  it('não segue para carteiras quando a trava de uma conta falha', async () => {
    const error = new Error('connection lost');
    const query = vi.fn().mockResolvedValueOnce([[], []]).mockRejectedValueOnce(error);
    await expect(lockWallets({ query } as unknown as PoolConnection, [20, 3])).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([sql]) => String(sql).includes('FROM users'))).toBe(true);
  });

  it('propaga falha de carteira para o chamador desfazer a transação', async () => {
    const error = new Error('connection lost');
    const query = vi.fn().mockRejectedValue(error);
    await expect(lockWalletRows({ query } as unknown as PoolConnection, [3])).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('listas vazias não consultam o banco', async () => {
    const query = vi.fn();
    const conn = { query } as unknown as PoolConnection;
    await lockWallets(conn, []);
    await lockWalletUsers(conn, []);
    await lockWalletRows(conn, []);
    expect(query).not.toHaveBeenCalled();
  });
});
