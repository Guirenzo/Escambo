import type {
  BrazilTimezone,
  GamificationProfile,
  LeaderboardEntry,
  LeaderboardQuery,
  LevelProgress,
  Mission,
  XpEvent,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { addDaysToDay, dayIn, DEFAULT_TIMEZONE } from '../../utils/timezone';
import { userZone } from '../auth/user-zone';
import { settingsFacade } from '../settings/settings.facade';
import {
  gamificationRepository,
  type BadgeCatalogRow,
  type FreelancerStatsRow,
  type LeaderboardRow,
} from './gamification.repository';
import { LEVELS, levelFor } from './gamification.levels';
import { missionsService } from './gamification.missions';

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

/**
 * Critérios contados no banco (RF-065). Cada um custa uma consulta, feita só quando alguma badge
 * ainda não conquistada depende dele: quem já tem as badges não paga por elas a cada evento.
 */
const COUNTED_CRITERIA = {
  on_time_deliveries: (userId: number) => gamificationRepository.countOnTimeDeliveries(userId),
  repeat_clients: (userId: number) => gamificationRepository.countRepeatClients(userId),
  barters_completed: (userId: number) => gamificationRepository.countBartersCompleted(userId),
} as const;
type CountedCriterion = keyof typeof COUNTED_CRITERIA;
const COUNTED_KEYS = Object.keys(COUNTED_CRITERIA) as CountedCriterion[];

/** Tamanho do lote da reavaliação de todos os freelancers. */
const REEVALUATE_BATCH = 200;

/** O ranking mostra o top 10 (RN-056). */
const LEADERBOARD_SIZE = 10;
/** Raio do ranking local (RN-056) quando ranking_radius_km falta ou não é um raio aceitável. */
const DEFAULT_RANKING_RADIUS_KM = 50;
/** O mesmo teto de raio da busca de serviços. */
const MAX_RANKING_RADIUS_KM = 500;

/** O raio do ranking local: o parâmetro da plataforma, ou 50 km se ele não for um raio válido. */
export function rankingRadius(value: number): number {
  return Number.isFinite(value) && value > 0 && value <= MAX_RANKING_RADIUS_KM
    ? value
    : DEFAULT_RANKING_RADIUS_KM;
}

function toLeaderboardEntry(r: LeaderboardRow, i: number): LeaderboardEntry {
  // No ranking por categoria ou local entra quem ainda não tem linha de XP: nível inicial.
  const initial = levelFor(0);
  const entry: LeaderboardEntry = {
    rank: i + 1,
    userUlid: r.ulid,
    name: r.name,
    totalXp: Number(r.total_xp),
    level: r.level ?? initial.level,
    levelName: r.level_name ?? initial.name,
    avgRating: Number(r.avg_rating ?? 0),
    completedContracts: Number(r.total_contracts ?? 0),
  };
  // A 100 m (1 casa), como na busca de serviços: o Haversine cru, ao metro, entregaria a casa.
  if (r.distance_km != null) entry.distanceKm = Math.round(Number(r.distance_km) * 10) / 10;
  return entry;
}

interface BadgeStats {
  contractsCompleted: number;
  totalReviews: number;
  avgRating: number;
  /** As contagens consultadas nesta avaliação; a que não foi consultada não atinge critério. */
  counted: Partial<Record<CountedCriterion, number>>;
}

function parseCriteria(
  criteria: string | Record<string, number> | null,
): Record<string, number> | null {
  if (!criteria) return null;
  try {
    return typeof criteria === 'string'
      ? (JSON.parse(criteria) as Record<string, number> | null)
      : criteria;
  } catch {
    return null;
  }
}

function criteriaMet(c: Record<string, number> | null, stats: BadgeStats): boolean {
  if (!c) return false;
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
  for (const key of COUNTED_KEYS) {
    if (c[key] == null) continue;
    hasKnown = true;
    if ((stats.counted[key] ?? 0) < c[key]) return false;
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

/**
 * Concede a badge e credita a recompensa só se a concessão foi agora: o INSERT IGNORE na chave
 * única (user_id, badge_id) decide, então o mesmo evento repetido ou em paralelo não duplica nada.
 */
async function grantBadge(userId: number, badge: BadgeCatalogRow): Promise<boolean> {
  const newly = await gamificationRepository.awardBadge(userId, badge.id);
  if (newly && badge.xp_reward > 0) {
    await awardXp(userId, badge.xp_reward, 'badge_earned', badge.id);
  }
  return newly;
}

/**
 * Avalia e concede as badges cujos critérios já foram atingidos (RN-053, RF-065). Devolve quantas
 * foram concedidas agora.
 */
async function evaluateBadges(userId: number): Promise<number> {
  const statsRow: FreelancerStatsRow | undefined =
    await gamificationRepository.getFreelancerStats(userId);
  if (!statsRow) return 0;
  const owned = new Set((await gamificationRepository.listBadges(userId)).map((b) => b.slug));
  const pending = (await gamificationRepository.listActiveBadges())
    .filter((badge) => !owned.has(badge.slug))
    .map((badge) => ({ badge, criteria: parseCriteria(badge.criteria) }));
  const needed = COUNTED_KEYS.filter((key) => pending.some((p) => p.criteria?.[key] != null));
  const values = await Promise.all(needed.map((key) => COUNTED_CRITERIA[key](userId)));
  const stats: BadgeStats = {
    contractsCompleted: statsRow.total_contracts,
    totalReviews: statsRow.total_reviews,
    avgRating: Number(statsRow.avg_rating),
    counted: Object.fromEntries(needed.map((key, i) => [key, values[i]])),
  };
  let awarded = 0;
  for (const { badge, criteria } of pending) {
    if (criteriaMet(criteria, stats) && (await grantBadge(userId, badge))) awarded += 1;
  }
  return awarded;
}

export const gamificationService = {
  awardXp,
  evaluateBadges,
  levelProgress,

  async getProfile(
    userId: number,
    options: { readOnly?: boolean } = {},
  ): Promise<GamificationProfile> {
    const initial = levelFor(0);
    const xp = options.readOnly
      ? ((await gamificationRepository.findXp(userId)) ?? {
          total_xp: 0,
          level: initial.level,
          level_name: initial.name,
        })
      : await gamificationRepository.getOrCreateXp(userId);
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

  /**
   * Ranking (RF-067). Sem filtro, o geral por XP, o mesmo da posição no perfil. Com categoria e/ou
   * o ponto do "perto de mim", a RN-056: o top 10 por nota média, depois contratações concluídas,
   * depois XP, dentro do raio ranking_radius_km da plataforma (50 km no seed).
   */
  async getLeaderboard(
    query: LeaderboardQuery = {},
    limit = LEADERBOARD_SIZE,
  ): Promise<LeaderboardEntry[]> {
    const local = query.lat !== undefined && query.lng !== undefined;
    if (query.categoryId === undefined && !local) {
      return (await gamificationRepository.leaderboard(limit)).map(toLeaderboardEntry);
    }
    const near = local
      ? {
          lat: query.lat!,
          lng: query.lng!,
          radiusKm: rankingRadius(
            await settingsFacade.getNumber('ranking_radius_km', DEFAULT_RANKING_RADIUS_KM),
          ),
        }
      : undefined;
    const rows = await gamificationRepository.rankedLeaderboard({
      ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
      ...(near ? { near } : {}),
      limit,
    });
    return rows.map(toLeaderboardEntry);
  },

  /** As missões do período vigente (RF-066); abrir conta como o acesso do dia. */
  listMissions(userId: number): Promise<Mission[]> {
    return missionsService.list(userId);
  },

  /**
   * Evento: contrato concluído → +100 XP + badge (RN-051). A contagem e os XP entram juntos. Por
   * último, a missão de contratações concluídas do período (RF-066).
   */
  async onContractCompleted(freelancerId: number, contractId: number): Promise<void> {
    await awardXp(freelancerId, 100, 'contract_completed', contractId, { countContract: true });
    await awardBadgeBySlug(freelancerId, 'first-deal');
    await evaluateBadges(freelancerId);
    await missionsService.evaluate(freelancerId, { actions: ['complete_contracts'] });
  },

  /** Evento: avaliação recebida → +50 (5★) / +20 (4★) (RN-051). */
  async onReviewReceived(freelancerId: number, rating: number, reviewId: number): Promise<void> {
    if (rating === 5) await awardXp(freelancerId, 50, 'review_5_stars', reviewId);
    else if (rating === 4) await awardXp(freelancerId, 20, 'review_4_stars', reviewId);
    await evaluateBadges(freelancerId);
  },

  /**
   * Evento: troca concluída → reavalia as badges de cada parte (RF-065, `barters_completed`). A
   * troca não dá XP próprio (não está na tabela da RN-051); só a badge, se sair, dá a recompensa,
   * e a missão de troca do catálogo (RF-066), se ainda não foi cumprida.
   */
  async onBarterCompleted(userId: number): Promise<void> {
    await evaluateBadges(userId);
    await missionsService.evaluate(userId, { actions: ['complete_barter'] });
  },

  /**
   * Evento: o freelancer respondeu a uma oferta do cliente (aceitou, recusou ou contrapropôs). Conta
   * para a missão de resposta rápida (RF-066); a resposta em si não dá XP (RN-051).
   */
  async onOfferAnswered(freelancerId: number): Promise<void> {
    await missionsService.evaluate(freelancerId, { actions: ['fast_response_hours'] });
  },

  /**
   * Reavalia as badges de todos os freelancers no ranking, em lotes pelo id (RN-053): concede as
   * que já estavam cumpridas antes de o critério ser acompanhado (1.44.0) ou enquanto a conta
   * estava suspensa. Idempotente, pela mesma concessão dos eventos; rodar de novo não concede nem
   * credita nada. A falha de uma pessoa é registrada e não para as outras.
   */
  async reevaluateAll(
    batchSize = REEVALUATE_BATCH,
  ): Promise<{ evaluated: number; awarded: number; failed: number }> {
    const result = { evaluated: 0, awarded: 0, failed: 0 };
    let after = 0;
    for (;;) {
      const ids = await gamificationRepository.listRankedFreelancers(after, batchSize);
      for (const userId of ids) {
        try {
          result.awarded += await evaluateBadges(userId);
          result.evaluated += 1;
        } catch (err) {
          result.failed += 1;
          logger.warn({ err, userId }, 'reavaliação de badges falhou');
        }
      }
      if (ids.length < batchSize) return result;
      after = ids[ids.length - 1]!;
    }
  },
};

async function awardBadgeBySlug(userId: number, slug: string): Promise<void> {
  const badge = await gamificationRepository.findBadgeBySlug(slug);
  if (!badge) return;
  await grantBadge(userId, badge);
}
