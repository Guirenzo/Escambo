import type {
  GamificationProfile,
  LeaderboardEntry,
  LevelProgress,
  XpEvent,
} from '@escambo/types';
import { gamificationRepository, type FreelancerStatsRow } from './gamification.repository';

/** Tabela de níveis (RN-052). */
const LEVELS = [
  { level: 1, name: 'Iniciante', min: 0 },
  { level: 2, name: 'Aprendiz', min: 300 },
  { level: 3, name: 'Profissional', min: 800 },
  { level: 4, name: 'Especialista', min: 2000 },
  { level: 5, name: 'Mestre', min: 5000 },
  { level: 6, name: 'Lenda', min: 12000 },
] as const;

function levelFor(totalXp: number): { level: number; name: string; min: number } {
  let current: (typeof LEVELS)[number] = LEVELS[0];
  for (const l of LEVELS) {
    if (totalXp >= l.min) current = l;
  }
  return { level: current.level, name: current.name, min: current.min };
}

export function levelProgress(totalXp: number): LevelProgress {
  const current = levelFor(totalXp);
  const next = LEVELS.find((l) => l.min > totalXp) ?? null;
  const nextMin = next ? next.min : null;
  const xpIntoLevel = totalXp - current.min;
  const span = nextMin !== null ? nextMin - current.min : 0;
  const percent = nextMin !== null && span > 0 ? Math.min(100, Math.round((xpIntoLevel / span) * 100)) : 100;
  return {
    level: current.level,
    levelName: current.name,
    currentLevelMin: current.min,
    nextLevelMin: nextMin,
    xpIntoLevel,
    xpToNextLevel: nextMin !== null ? nextMin - totalXp : null,
    percent,
  };
}

/** Sequência de dias ativos terminando hoje ou ontem (RN de streak). */
export function computeStreak(dates: string[], today = new Date()): number {
  if (dates.length === 0) return 0;
  const set = new Set(dates);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const cursor = new Date(today);
  if (!set.has(iso(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!set.has(iso(cursor))) return 0;
  }
  let streak = 0;
  while (set.has(iso(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

function criteriaMet(
  criteria: string | Record<string, number> | null,
  stats: { contractsCompleted: number; totalReviews: number; avgRating: number },
): boolean {
  if (!criteria) return false;
  let c: Record<string, number>;
  try {
    c = typeof criteria === 'string' ? (JSON.parse(criteria) as Record<string, number>) : criteria;
  } catch {
    return false;
  }
  // Critérios ainda não rastreados: não é possível conceder.
  if (c.on_time_deliveries != null || c.repeat_clients != null || c.barters_completed != null) {
    return false;
  }
  let hasKnown = false;
  if (c.contracts_completed != null) {
    hasKnown = true;
    if (stats.contractsCompleted < c.contracts_completed) return false;
  }
  if (c.reviews_min != null) {
    hasKnown = true;
    if (stats.totalReviews < c.reviews_min) return false;
  }
  if (c.avg_rating_min != null) {
    hasKnown = true;
    if (stats.avgRating < c.avg_rating_min) return false;
  }
  return hasKnown;
}

async function awardXp(
  userId: number,
  delta: number,
  reason: string,
  referenceId: number | null = null,
): Promise<{ leveledUp: boolean; level: number }> {
  const xp = await gamificationRepository.getOrCreateXp(userId);
  if (delta === 0) return { leveledUp: false, level: xp.level };
  const oldLevel = xp.level;
  const newTotal = xp.total_xp + delta;
  const lvl = levelFor(newTotal);
  await gamificationRepository.applyXp({
    userId,
    delta,
    level: lvl.level,
    levelName: lvl.name,
    reason,
    referenceId,
  });
  return { leveledUp: lvl.level > oldLevel, level: lvl.level };
}

/** Avalia e concede badges cujos critérios já foram atingidos (RN-053). */
async function evaluateBadges(userId: number): Promise<void> {
  const statsRow: FreelancerStatsRow | undefined =
    await gamificationRepository.getFreelancerStats(userId);
  if (!statsRow) return;
  const stats = {
    contractsCompleted: statsRow.total_contracts,
    totalReviews: statsRow.total_reviews,
    avgRating: Number(statsRow.avg_rating),
  };
  const owned = new Set((await gamificationRepository.listBadges(userId)).map((b) => b.slug));
  const badges = await gamificationRepository.listActiveBadges();
  for (const badge of badges) {
    if (owned.has(badge.slug)) continue;
    if (criteriaMet(badge.criteria, stats)) {
      const newly = await gamificationRepository.awardBadge(userId, badge.id);
      if (newly && badge.xp_reward > 0) {
        await awardXp(userId, badge.xp_reward, 'badge_earned', badge.id);
      }
    }
  }
}

export const gamificationService = {
  awardXp,
  evaluateBadges,
  levelProgress,

  async getProfile(userId: number): Promise<GamificationProfile> {
    const xp = await gamificationRepository.getOrCreateXp(userId);
    const [badges, dates, rank] = await Promise.all([
      gamificationRepository.listBadges(userId),
      gamificationRepository.activityDates(userId, 60),
      gamificationRepository.rankOf(userId),
    ]);
    return {
      totalXp: xp.total_xp,
      level: xp.level,
      levelName: xp.level_name,
      progress: levelProgress(xp.total_xp),
      streakDays: computeStreak(dates),
      rank,
      badges: badges.map((b) => ({
        slug: b.slug,
        name: b.name,
        awardedAt: new Date(b.awarded_at).toISOString(),
      })),
    };
  },

  async getHistory(userId: number, limit = 20): Promise<XpEvent[]> {
    const rows = await gamificationRepository.recentEvents(userId, limit);
    return rows.map((r) => ({
      amount: r.amount,
      reason: r.reason,
      at: new Date(r.created_at).toISOString(),
    }));
  },

  async getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
    const rows = await gamificationRepository.leaderboard(limit);
    return rows.map((r, i) => ({
      rank: i + 1,
      userUlid: r.ulid,
      name: r.name,
      totalXp: r.total_xp,
      level: r.level,
      levelName: r.level_name,
    }));
  },

  /** Evento: contrato concluído → +100 XP + badge (RN-051). */
  async onContractCompleted(freelancerId: number, contractId: number): Promise<void> {
    await gamificationRepository.incrementContracts(freelancerId);
    await awardXp(freelancerId, 100, 'contract_completed', contractId);
    await awardBadgeBySlug(freelancerId, 'first-deal');
    await evaluateBadges(freelancerId);
  },

  /** Evento: avaliação recebida → +50 (5★) / +20 (4★) (RN-051). */
  async onReviewReceived(freelancerId: number, rating: number, reviewId: number): Promise<void> {
    if (rating === 5) await awardXp(freelancerId, 50, 'review_5_stars', reviewId);
    else if (rating === 4) await awardXp(freelancerId, 20, 'review_4_stars', reviewId);
    await evaluateBadges(freelancerId);
  },
};

async function awardBadgeBySlug(userId: number, slug: string): Promise<void> {
  const badge = await gamificationRepository.findBadgeBySlug(slug);
  if (!badge) return;
  const newly = await gamificationRepository.awardBadge(userId, badge.id);
  if (newly && badge.xp_reward > 0) {
    await awardXp(userId, badge.xp_reward, 'badge_earned', badge.id);
  }
}
