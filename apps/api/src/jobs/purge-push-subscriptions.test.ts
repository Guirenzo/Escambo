import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/notifications/push.repository', () => ({
  pushRepository: { removeStale: vi.fn() },
}));

import { env } from '../config/env';
import { pushRepository } from '../modules/notifications/push.repository';
import { runPurgePushSubscriptions, STALE_PUSH_DAYS } from './purge-push-subscriptions';

const repo = vi.mocked(pushRepository);

beforeEach(() => {
  vi.clearAllMocks();
  env.PUSH_PROVIDER = 'simulated';
});

describe('expurgo de assinaturas paradas (ADR 54)', () => {
  it('apaga quem não recebeu nada em 180 dias e diz quantas', async () => {
    repo.removeStale.mockResolvedValue(3);
    expect(await runPurgePushSubscriptions()).toEqual({ skipped: null, removed: 3 });
    expect(repo.removeStale).toHaveBeenCalledWith(STALE_PUSH_DAYS);
    expect(STALE_PUSH_DAYS).toBe(180);
  });

  it('com o canal desligado não apaga: ninguém envelheceu por culpa própria', async () => {
    env.PUSH_PROVIDER = 'off';
    expect(await runPurgePushSubscriptions()).toEqual({ skipped: 'push_off', removed: 0 });
    expect(repo.removeStale).not.toHaveBeenCalled();
  });
});
