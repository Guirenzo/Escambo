import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/db', () => ({ pingDb: vi.fn() }));

import { healthCheck } from './health.controller';
import { pingDb } from '../../config/db';

const ping = vi.mocked(pingDb);

beforeEach(() => vi.clearAllMocks());

describe('healthCheck', () => {
  it('responde status ok + db up quando o ping funciona', async () => {
    ping.mockResolvedValue(undefined);
    const json = vi.fn();
    await healthCheck({} as unknown as Request, { json } as unknown as Response);

    expect(ping).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', db: 'up' }));
  });

  it('propaga o erro quando o banco está fora (vira 500 no error handler)', async () => {
    ping.mockRejectedValue(new Error('db down'));
    const json = vi.fn();
    await expect(
      healthCheck({} as unknown as Request, { json } as unknown as Response),
    ).rejects.toThrow('db down');
    expect(json).not.toHaveBeenCalled();
  });
});
