import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./gamification.repository', () => ({
  gamificationRepository: {
    getOrCreateXp: vi.fn(),
    applyXp: vi.fn(),
    listBadges: vi.fn(),
    listActiveBadges: vi.fn(),
    findBadgeBySlug: vi.fn(),
    awardBadge: vi.fn(),
    getFreelancerStats: vi.fn(),
    incrementContracts: vi.fn(),
    recentEvents: vi.fn(),
    activityDates: vi.fn(),
    rankOf: vi.fn(),
    leaderboard: vi.fn(),
  },
}));

import { computeStreak, gamificationService, levelProgress } from './gamification.service';
import {
  gamificationRepository,
  type BadgeCatalogRow,
  type FreelancerStatsRow,
  type UserBadgeRow,
  type XpRow,
} from './gamification.repository';

const repo = vi.mocked(gamificationRepository);
const xp = (
  o: Partial<{ user_id: number; total_xp: number; level: number; level_name: string }> = {},
): XpRow => ({ user_id: 1, total_xp: 0, level: 1, level_name: 'Iniciante', ...o }) as unknown as XpRow;

beforeEach(() => vi.clearAllMocks());

describe('levelProgress (RN-052)', () => {
  it('nível 1 no começo', () => {
    const p = levelProgress(0);
    expect(p.level).toBe(1);
    expect(p.levelName).toBe('Iniciante');
    expect(p.nextLevelMin).toBe(300);
    expect(p.percent).toBe(0);
  });

  it('metade do caminho para o próximo nível', () => {
    const p = levelProgress(150); // 0..300 -> 50%
    expect(p.level).toBe(1);
    expect(p.percent).toBe(50);
    expect(p.xpToNextLevel).toBe(150);
  });

  it('nível máximo (Lenda) sem próximo', () => {
    const p = levelProgress(15000);
    expect(p.level).toBe(6);
    expect(p.levelName).toBe('Lenda');
    expect(p.nextLevelMin).toBeNull();
    expect(p.percent).toBe(100);
  });
});

describe('computeStreak', () => {
  const today = new Date('2026-03-10T12:00:00Z');

  it('conta dias consecutivos terminando hoje', () => {
    expect(computeStreak(['2026-03-10', '2026-03-09', '2026-03-08', '2026-03-06'], today)).toBe(3);
  });

  it('conta a partir de ontem quando não houve atividade hoje', () => {
    expect(computeStreak(['2026-03-09', '2026-03-08'], today)).toBe(2);
  });

  it('zero quando a última atividade foi anteontem', () => {
    expect(computeStreak(['2026-03-08'], today)).toBe(0);
  });
});

describe('awardXp', () => {
  it('credita XP e detecta level up', async () => {
    repo.getOrCreateXp.mockResolvedValue(xp({ total_xp: 250, level: 1 }));
    repo.applyXp.mockResolvedValue(undefined);

    const res = await gamificationService.awardXp(1, 100, 'contract_completed', 5);

    // 250 + 100 = 350 -> nível 2 (Aprendiz, min 300)
    expect(repo.applyXp).toHaveBeenCalledWith(
      expect.objectContaining({ delta: 100, level: 2, levelName: 'Aprendiz' }),
    );
    expect(res.leveledUp).toBe(true);
    expect(res.level).toBe(2);
  });
});

describe('evaluateBadges (engine por critério)', () => {
  it('concede badge cujo critério foi atingido e ignora critério não rastreado', async () => {
    repo.getFreelancerStats.mockResolvedValue({
      total_contracts: 60,
      total_reviews: 60,
      avg_rating: '4.80',
    } as unknown as FreelancerStatsRow);
    repo.listBadges.mockResolvedValue([] as unknown as UserBadgeRow[]);
    repo.listActiveBadges.mockResolvedValue([
      { id: 2, slug: 'top-rated', xp_reward: 200, criteria: { reviews_min: 50, avg_rating_min: 4.5 } },
      { id: 3, slug: 'fast-delivery', xp_reward: 100, criteria: { on_time_deliveries: 20 } },
    ] as unknown as BadgeCatalogRow[]);
    repo.awardBadge.mockResolvedValue(true);
    repo.getOrCreateXp.mockResolvedValue(xp());
    repo.applyXp.mockResolvedValue(undefined);

    await gamificationService.evaluateBadges(1);

    expect(repo.awardBadge).toHaveBeenCalledWith(1, 2); // top-rated
    expect(repo.awardBadge).not.toHaveBeenCalledWith(1, 3); // fast-delivery (não rastreado)
  });

  it('não concede quando as stats são insuficientes', async () => {
    repo.getFreelancerStats.mockResolvedValue({
      total_contracts: 1,
      total_reviews: 2,
      avg_rating: '3.00',
    } as unknown as FreelancerStatsRow);
    repo.listBadges.mockResolvedValue([] as unknown as UserBadgeRow[]);
    repo.listActiveBadges.mockResolvedValue([
      { id: 2, slug: 'top-rated', xp_reward: 200, criteria: { reviews_min: 50, avg_rating_min: 4.5 } },
    ] as unknown as BadgeCatalogRow[]);

    await gamificationService.evaluateBadges(1);

    expect(repo.awardBadge).not.toHaveBeenCalled();
  });
});

describe('getProfile', () => {
  it('monta o perfil premium (progresso + streak + rank + badges)', async () => {
    repo.getOrCreateXp.mockResolvedValue(xp({ total_xp: 350, level: 2, level_name: 'Aprendiz' }));
    repo.listBadges.mockResolvedValue([
      { slug: 'first-deal', name: 'First Deal', awarded_at: new Date('2026-01-01T00:00:00Z') },
    ] as unknown as UserBadgeRow[]);
    repo.activityDates.mockResolvedValue([]);
    repo.rankOf.mockResolvedValue(5);

    const p = await gamificationService.getProfile(1);

    expect(p.level).toBe(2);
    expect(p.progress.level).toBe(2);
    expect(p.rank).toBe(5);
    expect(p.streakDays).toBe(0);
    expect(p.badges).toHaveLength(1);
  });
});
