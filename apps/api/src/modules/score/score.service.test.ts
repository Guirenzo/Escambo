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
    expect(s.breakdown).toEqual({
      quality: 100,
      experience: 100,
      socialProof: 100,
      responsiveness: 100,
    });
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
    // 4,5 de 5 = 90; 5 de 20 contratos = 25; 4 de 10 avaliações = 40; 12h = 36/47 = 76,6.
    expect(s.breakdown).toEqual({
      quality: 90,
      experience: 25,
      socialProof: 40,
      responsiveness: 77,
    });
    expect(s.score).toBe(62); // 36 + 6,25 + 8 + 11,49
  });

  it('o detalhamento sai arredondado, mas a pontuação é calculada com as dimensões sem arredondar', () => {
    const s = computeEscamboScore({
      avgRating: 3.02, // qualidade 60,4
      totalReviews: 3,
      totalContracts: 7,
      responseTimeHours: 5, // responsividade 43/47 = 91,49
    });
    expect(s.breakdown).toEqual({
      quality: 60,
      experience: 35,
      socialProof: 30,
      responsiveness: 91,
    });
    // 24,16 + 8,75 + 6 + 13,72 = 52,63. Somando as dimensões já arredondadas daria 52,4 (52).
    expect(s.score).toBe(53);
    expect(s.tier).toBe('confiavel');
  });

  it('devolve só a pontuação, a faixa e o detalhamento das quatro dimensões', () => {
    const s = computeEscamboScore({
      avgRating: 4,
      totalReviews: 10,
      totalContracts: 20,
      responseTimeHours: 48,
    });
    expect(s).toEqual({
      score: 77, // 32 + 25 + 20 + 0
      tier: 'top',
      breakdown: { quality: 80, experience: 100, socialProof: 100, responsiveness: 0 },
    });
  });

  it('responsividade: <=1h máxima, >=48h zero (com clamp)', () => {
    const base = { avgRating: 0, totalReviews: 0, totalContracts: 0 };
    expect(computeEscamboScore({ ...base, responseTimeHours: 1 }).breakdown.responsiveness).toBe(
      100,
    );
    expect(computeEscamboScore({ ...base, responseTimeHours: 48 }).breakdown.responsiveness).toBe(
      0,
    );
    expect(computeEscamboScore({ ...base, responseTimeHours: 100 }).breakdown.responsiveness).toBe(
      0,
    );
  });

  it('qualidade só conta com avaliações (sem reviews = neutro 50)', () => {
    const semReviews = computeEscamboScore({
      avgRating: 5,
      totalReviews: 0,
      totalContracts: 0,
      responseTimeHours: null,
    });
    expect(semReviews.breakdown.quality).toBe(50); // ignora avgRating sem lastro
    const comReviews = computeEscamboScore({
      avgRating: 5,
      totalReviews: 3,
      totalContracts: 0,
      responseTimeHours: null,
    });
    expect(comReviews.breakdown.quality).toBe(100);
  });

  describe('faixas: elite a partir de 85, top a partir de 70, confiável a partir de 50', () => {
    // [nota média, avaliações, contratos, tempo de resposta (h)] → pontuação e faixa esperadas.
    it.each([
      [5, 10, 20, 48, 85, 'elite'], // 40 + 25 + 20 + 0
      [4.9, 10, 20, 48, 84, 'top'], // 39,2 + 25 + 20 + 0
      [5, 5, 10, null, 70, 'top'], // 40 + 12,5 + 10 + 7,5
      [4.9, 5, 10, null, 69, 'confiavel'], // 39,2 + 12,5 + 10 + 7,5
      [0, 0, 18, null, 50, 'confiavel'], // 20 + 22,5 + 0 + 7,5
      [0, 0, 17, null, 49, 'novato'], // 20 + 21,25 + 0 + 7,5
    ] as const)(
      'nota %s, %i avaliações, %i contratos, resposta em %s h: %i pontos, faixa %s',
      (avgRating, totalReviews, totalContracts, responseTimeHours, score, tier) => {
        const s = computeEscamboScore({
          avgRating,
          totalReviews,
          totalContracts,
          responseTimeHours,
        });
        expect(s.score).toBe(score);
        expect(s.tier).toBe(tier);
      },
    );
  });

  it('experiência satura em 20 contratos e prova social em 10 avaliações', () => {
    const at = (totalContracts: number, totalReviews: number) =>
      computeEscamboScore({ avgRating: 4, totalReviews, totalContracts, responseTimeHours: null })
        .breakdown;

    expect(at(10, 5)).toEqual({
      quality: 80,
      experience: 50,
      socialProof: 50,
      responsiveness: 50,
    });
    expect(at(20, 10)).toEqual({
      quality: 80,
      experience: 100,
      socialProof: 100,
      responsiveness: 50,
    });
    // Passar do teto não rende mais nada.
    expect(at(200, 500)).toEqual(at(20, 10));
  });

  it('cada dimensão fica entre 0 e 100 mesmo com sinais fora da faixa', () => {
    const s = computeEscamboScore({
      avgRating: 6, // nota acima de 5
      totalReviews: 3,
      totalContracts: -4, // contagem negativa
      responseTimeHours: 0.5, // mais rápido que 1h
    });
    expect(s.breakdown).toEqual({
      quality: 100,
      experience: 0,
      socialProof: 30,
      responsiveness: 100,
    });
    expect(s.score).toBe(61); // 40 + 0 + 6 + 15
  });

  it('responsividade cai linearmente entre 1h e 48h, e tempo desconhecido fica no neutro', () => {
    const base = { avgRating: 0, totalReviews: 0, totalContracts: 0 };
    const at = (responseTimeHours: number | null) =>
      computeEscamboScore({ ...base, responseTimeHours }).breakdown.responsiveness;

    expect(at(24.5)).toBe(50); // meio do caminho
    expect(at(12.75)).toBe(75);
    expect(at(null)).toBe(50);
    // Quem responde em 1h pontua mais que quem não tem tempo medido: 20 + 15 contra 20 + 7,5.
    expect(computeEscamboScore({ ...base, responseTimeHours: 1 }).score).toBe(35);
    expect(computeEscamboScore({ ...base, responseTimeHours: null }).score).toBe(28);
  });

  it('tempo de resposta zero é resposta imediata (nota máxima), não tempo desconhecido', () => {
    const base = { avgRating: 0, totalReviews: 0, totalContracts: 0 };
    const instant = computeEscamboScore({ ...base, responseTimeHours: 0 });
    expect(instant.breakdown.responsiveness).toBe(100);
    expect(instant.score).toBe(35); // 20 da qualidade neutra + 15 da responsividade cheia
    // Só a ausência do dado (null) cai no neutro.
    expect(computeEscamboScore({ ...base, responseTimeHours: null }).breakdown.responsiveness).toBe(
      50,
    );
  });

  it('os pesos: qualidade 40%, experiência 25%, prova social 20%, responsividade 15%', () => {
    // Uma avaliação nota 0 e resposta em 48h zeram qualidade e responsividade: sobram
    // 10 de prova social (uma avaliação em dez) com peso 0,2.
    const base = { avgRating: 0, totalReviews: 1, totalContracts: 0, responseTimeHours: 48 };
    expect(computeEscamboScore(base).score).toBe(2);
    expect(computeEscamboScore({ ...base, avgRating: 5 }).score).toBe(42); // + 0,40 * 100
    expect(computeEscamboScore({ ...base, totalContracts: 20 }).score).toBe(27); // + 0,25 * 100
    expect(computeEscamboScore({ ...base, totalReviews: 10 }).score).toBe(20); // 0,20 * 100
    expect(computeEscamboScore({ ...base, responseTimeHours: 1 }).score).toBe(17); // + 0,15 * 100
  });
});
