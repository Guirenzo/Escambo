import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./content-removals.repository', () => ({
  contentRemovalsRepository: { strikeStats: vi.fn() },
}));
vi.mock('../settings/settings.service', () => ({
  settingsService: { number: vi.fn() },
}));

import { settingsService } from '../settings/settings.service';
import { contentRemovalsRepository } from './content-removals.repository';
import {
  appealDeadline,
  strikePolicy,
  strikeSummary,
  uploadsBlockedUntil,
} from './moderation.strikes';

const settings = vi.mocked(settingsService);
const repo = vi.mocked(contentRemovalsRepository);

const NUMBERS: Record<string, number> = {
  appeal_window_days: 14,
  strike_window_days: 180,
  strike_upload_block_days: 7,
  strike_review_threshold: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  settings.number.mockImplementation(async (key: string) => NUMBERS[key]!);
});

describe('reincidência na moderação de imagens (ADR 41)', () => {
  it('bloqueio progressivo: nada na primeira, 7 dias na segunda, 14 na terceira; 0 desliga', () => {
    const last = new Date('2026-09-15T12:00:00Z');
    expect(uploadsBlockedUntil(1, last, 7)).toBeNull();
    expect(uploadsBlockedUntil(2, last, 7)).toEqual(new Date('2026-09-22T12:00:00Z'));
    expect(uploadsBlockedUntil(3, last, 7)).toEqual(new Date('2026-09-29T12:00:00Z'));
    expect(uploadsBlockedUntil(3, last, 0)).toBeNull();
    expect(uploadsBlockedUntil(3, null, 7)).toBeNull();
  });

  it('prazo de contestação', () => {
    expect(appealDeadline(new Date('2026-09-15T15:00:00Z'), 14)).toEqual(
      new Date('2026-09-29T15:00:00Z'),
    );
  });

  it('lê os quatro parâmetros da plataforma', async () => {
    expect(await strikePolicy()).toEqual({
      appealWindowDays: 14,
      windowDays: 180,
      blockDays: 7,
      reviewThreshold: 3,
    });
  });

  it('resumo conta a janela a partir de agora e só mostra bloqueio que ainda vale', async () => {
    repo.strikeStats.mockResolvedValue({
      strikes: 3,
      imageStrikes: 2,
      lastImage: new Date('2026-09-15T12:00:00Z'),
    });

    const during = await strikeSummary(5, new Date('2026-09-18T00:00:00Z'));
    expect(repo.strikeStats).toHaveBeenCalledWith(5, new Date('2026-03-22T00:00:00Z'));
    expect(during).toEqual({
      strikes: 3,
      imageStrikes: 2,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: '2026-09-22T12:00:00.000Z',
    });

    const after = await strikeSummary(5, new Date('2026-09-23T00:00:00Z'));
    expect(after.uploadsBlockedUntil).toBeNull();
  });

  it('avaliação e mensagem removidas contam para a revisão, mas não bloqueiam o envio (ADR 44)', async () => {
    repo.strikeStats.mockResolvedValue({
      strikes: 3,
      imageStrikes: 1,
      lastImage: new Date('2026-09-15T12:00:00Z'),
    });
    const summary = await strikeSummary(5, new Date('2026-09-16T00:00:00Z'));
    expect(summary).toMatchObject({ strikes: 3, imageStrikes: 1, uploadsBlockedUntil: null });
  });
});
