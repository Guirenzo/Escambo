import { describe, expect, it } from 'vitest';
import { computeEscamboScore } from './score.service';

describe('computeEscamboScore', () => {
  it('freelancer novo: qualidade/responsividade neutras, faixa novato', () => {
    const s = computeEscamboScore({
      avgRating: 0,
      totalReviews: 0,
      totalContracts: 0,
      responseTimeHours: null,
    });
    expect(s.breakdown).toEqual({ quality: 50, experience: 0, socialProof: 0, responsiveness: 50 });
    expect(s.score).toBe(28); // 0.4*50 + 0.15*50
    expect(s.tier).toBe('novato');
  });

  it('freelancer excelente atinge elite (100)', () => {
    const s = computeEscamboScore({
      avgRating: 5,
      totalReviews: 20,
      totalContracts: 30,
      responseTimeHours: 1,
    });
    expect(s.breakdown).toEqual({ quality: 100, experience: 100, socialProof: 100, responsiveness: 100 });
    expect(s.score).toBe(100);
    expect(s.tier).toBe('elite');
  });

  it('nota alta mas pouca experiência fica em faixa confiável', () => {
    const s = computeEscamboScore({
      avgRating: 4.5,
      totalReviews: 4,
      totalContracts: 5,
      responseTimeHours: 12,
    });
    expect(s.tier).toBe('confiavel');
    expect(s.score).toBeGreaterThanOrEqual(50);
    expect(s.score).toBeLessThan(70);
  });

  it('responsividade: <=1h máxima, >=48h zero (com clamp)', () => {
    const base = { avgRating: 0, totalReviews: 0, totalContracts: 0 };
    expect(computeEscamboScore({ ...base, responseTimeHours: 1 }).breakdown.responsiveness).toBe(100);
    expect(computeEscamboScore({ ...base, responseTimeHours: 48 }).breakdown.responsiveness).toBe(0);
    expect(computeEscamboScore({ ...base, responseTimeHours: 100 }).breakdown.responsiveness).toBe(0);
  });

  it('qualidade só conta com avaliações (sem reviews = neutro 50)', () => {
    const semReviews = computeEscamboScore({ avgRating: 5, totalReviews: 0, totalContracts: 0, responseTimeHours: null });
    expect(semReviews.breakdown.quality).toBe(50); // ignora avgRating sem lastro
    const comReviews = computeEscamboScore({ avgRating: 5, totalReviews: 3, totalContracts: 0, responseTimeHours: null });
    expect(comReviews.breakdown.quality).toBe(100);
  });
});
