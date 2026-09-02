import type { EscamboScore, ScoreBreakdown, ScoreTier } from '@escambo/types';

export interface ScoreSignals {
  avgRating: number; // 0-5
  totalReviews: number;
  totalContracts: number;
  responseTimeHours: number | null; // média; menor é melhor
}

// Pesos das dimensões (somam 1).
const W = { quality: 0.4, experience: 0.25, socialProof: 0.2, responsiveness: 0.15 };

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

function tierFor(score: number): ScoreTier {
  if (score >= 85) return 'elite';
  if (score >= 70) return 'top';
  if (score >= 50) return 'confiavel';
  return 'novato';
}

/**
 * Escambo Score: reputação multifator (0-100), explicável e sem estado externo.
 * - quality: nota média (neutra em 50 enquanto não houver avaliações);
 * - experience: volume de contratos (satura em 20);
 * - socialProof: volume de avaliações (satura em 10);
 * - responsiveness: tempo de resposta (<=1h = 100, >=48h = 0; desconhecido = 50).
 */
export function computeEscamboScore(s: ScoreSignals): EscamboScore {
  const quality = s.totalReviews > 0 ? clamp((s.avgRating / 5) * 100) : 50;
  const experience = clamp((Math.min(s.totalContracts, 20) / 20) * 100);
  const socialProof = clamp((Math.min(s.totalReviews, 10) / 10) * 100);
  const responsiveness =
    s.responseTimeHours == null ? 50 : clamp(((48 - s.responseTimeHours) / (48 - 1)) * 100);

  const breakdown: ScoreBreakdown = {
    quality: Math.round(quality),
    experience: Math.round(experience),
    socialProof: Math.round(socialProof),
    responsiveness: Math.round(responsiveness),
  };

  const score = Math.round(
    W.quality * quality +
      W.experience * experience +
      W.socialProof * socialProof +
      W.responsiveness * responsiveness,
  );

  return { score, tier: tierFor(score), breakdown };
}
