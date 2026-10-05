import type {
  BrazilTimezone,
  GamificationProfile,
  LeaderboardEntry,
  LevelProgress,
  XpEvent,
} from '@escambo/types';
import { addDaysToDay, dayIn, DEFAULT_TIMEZONE } from '../../utils/timezone';
import { userZone } from '../auth/user-zone';
import { gamificationRepository, type FreelancerStatsRow } from './gamification.repository';
import { LEVELS, levelFor } from './gamification.levels';

/** Janela da sequência de dias: a atividade dos últimos 60 dias (a sequência não passa disso). */
const STREAK_WINDOW_DAYS = 60;
const DAY_MS = 86_400_000;

export function levelProgress(totalXp: number): LevelProgress {
  const current = levelFor(totalXp);
  const next = LEVELS.find((l) => l.min > totalXp) ?? null;
  const nextMin = next ? next.min : null;
  const xpIntoLevel = totalXp - current.min;
  const span = nextMin !== null ? nextMin - current.min : 0;
  const percent =
    nextMin !== null && span > 0 ? Math.min(100, Math.round((xpIntoLevel / span) * 100)) : 100;
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

/**
 * Sequência de dias ativos terminando hoje ou ontem (RN de streak). Os dias ("AAAA-MM-DD") e o
 * hoje são os do fuso da pessoa: em UTC o dia viraria às 21h de Brasília.
 */
export function computeStreak(
  dates: string[],
  today = new Date(),
  zone: BrazilTimezone = DEFAULT_TIMEZONE,
): number {
  if (dates.length === 0) return 0;
  const set = new Set(dates);
  let day = dayIn(zone, today);
  if (!set.has(day)) {
    day = addDaysToDay(day, -1);
    if (!set.has(day)) return 0;
  }
  let streak = 0;
  while (set.has(day)) {
    streak += 1;
    day = addDaysToDay(day, -1);
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
  opts: { countContract?: boolean } = {},
): Promise<{ leveledUp: boolean; level: number }> {
  if (delta === 0) {
    const xp = await gamificationRepository.getOrCreateXp(userId);
    return { leveledUp: false, level: xp.level };
  }
  // O nível novo sai do total travado na transação do crédito, não de uma leitura anterior.
  const { previousLevel, level } = await gamificationRepository.applyXp({
    userId,
    delta,
    reason,
    referenceId,
    ...opts,
  });
  return { leveledUp: level > previousLevel, level };
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
    const now = new Date();
    // Um dia a mais na janela: o primeiro dia dela, no fuso da pessoa, entra inteiro.
    const since = new Date(now.getTime() - (STREAK_WINDOW_DAYS + 1) * DAY_MS);
    const [badges, times, rank, zone] = await Promise.all([
      gamificationRepository.listBadges(userId),
      gamificationRepository.activityTimes(userId, since),
      gamificationRepository.rankOf(userId),
      userZone(userId),
    ]);
    return {
      totalXp: xp.total_xp,
      level: xp.level,
      levelName: xp.level_name,
      progress: levelProgress(xp.total_xp),
      streakDays: computeStreak(
        times.map((at) => dayIn(zone, at)),
        now,
        zone,
      ),
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

  /** Evento: contrato concluído → +100 XP + badge (RN-051). A contagem e os XP entram juntos. */
  async onContractCompleted(freelancerId: number, contractId: number): Promise<void> {
    await awardXp(freelancerId, 100, 'contract_completed', contractId, { countContract: true });
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
