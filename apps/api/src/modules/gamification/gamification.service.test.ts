import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./gamification.repository', () => ({
  gamificationRepository: {
    getOrCreateXp: vi.fn(),
    applyXp: vi.fn(),
    listBadges: vi.fn(),
    listActiveBadges: vi.fn(),
    findBadgeBySlug: vi.fn(),
    awardBadge: vi.fn(),
    getFreelancerStats: vi.fn(),
    recentEvents: vi.fn(),
    activityTimes: vi.fn(),
    rankOf: vi.fn(),
    leaderboard: vi.fn(),
  },
}));

const { zone } = vi.hoisted(() => ({ zone: vi.fn() }));
vi.mock('../auth/user-zone', () => ({ userZone: zone }));

import { computeStreak, gamificationService, levelProgress } from './gamification.service';
import {
  gamificationRepository,
  type BadgeCatalogRow,
  type FreelancerStatsRow,
  type LeaderboardRow,
  type UserBadgeRow,
  type XpEventRow,
  type XpRow,
} from './gamification.repository';

const repo = vi.mocked(gamificationRepository);
const xp = (
  o: Partial<{ user_id: number; total_xp: number; level: number; level_name: string }> = {},
): XpRow =>
  ({ user_id: 1, total_xp: 0, level: 1, level_name: 'Iniciante', ...o }) as unknown as XpRow;

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

  it('o dia vira à meia-noite de Brasília, e não às 21h (meia-noite em UTC)', () => {
    // 22:30 de 10/03 em Brasília (01:30 de 11/03 em UTC): hoje ainda é 10/03, ontem 09/03.
    const night = new Date('2026-03-11T01:30:00Z');
    expect(computeStreak(['2026-03-09', '2026-03-08'], night)).toBe(2);
  });

  it('o dia é o do fuso da pessoa: 23:30 em Manaus ainda é o dia anterior ao de Brasília', () => {
    // 03:30 UTC de 11/03: 23:30 de 10/03 em Manaus e 00:30 de 11/03 em Brasília.
    const at = new Date('2026-03-11T03:30:00Z');
    expect(computeStreak(['2026-03-09'], at, 'America/Manaus')).toBe(1);
    expect(computeStreak(['2026-03-09'], at, 'America/Sao_Paulo')).toBe(0);
  });
});

describe('awardXp', () => {
  it('credita XP e detecta level up pelo nível que o crédito devolve', async () => {
    repo.applyXp.mockResolvedValue({ previousLevel: 1, level: 2 });

    const res = await gamificationService.awardXp(1, 100, 'contract_completed', 5);

    // O nível é calculado no crédito, do total travado: o service só manda o ganho.
    expect(repo.applyXp).toHaveBeenCalledWith({
      userId: 1,
      delta: 100,
      reason: 'contract_completed',
      referenceId: 5,
    });
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
      {
        id: 2,
        slug: 'top-rated',
        xp_reward: 200,
        criteria: { reviews_min: 50, avg_rating_min: 4.5 },
      },
      { id: 3, slug: 'fast-delivery', xp_reward: 100, criteria: { on_time_deliveries: 20 } },
    ] as unknown as BadgeCatalogRow[]);
    repo.awardBadge.mockResolvedValue(true);
    repo.applyXp.mockResolvedValue({ previousLevel: 1, level: 1 });

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
      {
        id: 2,
        slug: 'top-rated',
        xp_reward: 200,
        criteria: { reviews_min: 50, avg_rating_min: 4.5 },
      },
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
    repo.activityTimes.mockResolvedValue([]);
    repo.rankOf.mockResolvedValue(5);
    zone.mockResolvedValue('America/Sao_Paulo');

    const p = await gamificationService.getProfile(1);

    expect(p.level).toBe(2);
    expect(p.progress.level).toBe(2);
    expect(p.rank).toBe(5);
    expect(p.streakDays).toBe(0);
    expect(p.badges).toHaveLength(1);
  });
});

/**
 * Complemento: os caminhos que os testes acima não exercitam (limites dos níveis, critérios das
 * badges, histórico, ranking e os dois eventos que dão XP). Aqui cada teste parte de mocks
 * zerados, para um retorno configurado num teste não vazar para o seguinte.
 */
describe('gamificação: regras por evento e por critério', () => {
  const badge = (o: {
    id?: number;
    slug?: string;
    xp_reward?: number;
    criteria?: string | Record<string, number> | null;
  }): BadgeCatalogRow =>
    ({ id: 1, slug: 'badge', xp_reward: 0, criteria: null, ...o }) as unknown as BadgeCatalogRow;
  const stats = (
    total_contracts: number,
    total_reviews: number,
    avg_rating: string,
  ): FreelancerStatsRow =>
    ({ total_contracts, total_reviews, avg_rating }) as unknown as FreelancerStatsRow;

  beforeEach(() => {
    vi.resetAllMocks();
    repo.listBadges.mockResolvedValue([]);
    repo.listActiveBadges.mockResolvedValue([]);
    repo.applyXp.mockResolvedValue({ previousLevel: 1, level: 1 });
  });
  afterEach(() => vi.useRealTimers());

  describe('levelProgress: a tabela de níveis (RN-052)', () => {
    it.each([
      [0, 1, 'Iniciante'],
      [299, 1, 'Iniciante'],
      [300, 2, 'Aprendiz'],
      [799, 2, 'Aprendiz'],
      [800, 3, 'Profissional'],
      [1999, 3, 'Profissional'],
      [2000, 4, 'Especialista'],
      [4999, 4, 'Especialista'],
      [5000, 5, 'Mestre'],
      [11999, 5, 'Mestre'],
      [12000, 6, 'Lenda'],
    ])('%i XP é nível %i (%s)', (totalXp, level, levelName) => {
      const p = levelProgress(totalXp);
      expect(p.level).toBe(level);
      expect(p.levelName).toBe(levelName);
    });

    it('no meio de um nível, o progresso conta a partir do piso dele', () => {
      expect(levelProgress(350)).toEqual({
        level: 2,
        levelName: 'Aprendiz',
        currentLevelMin: 300,
        nextLevelMin: 800,
        xpIntoLevel: 50,
        xpToNextLevel: 450,
        percent: 10,
      });
    });

    it('a barra arredonda para o inteiro mais próximo, para cima e para baixo', () => {
      // 100 de 300 = 33,3%; 200 de 300 = 66,7%; 1 de 300 = 0,3%.
      expect(levelProgress(100).percent).toBe(33);
      expect(levelProgress(200).percent).toBe(67);
      expect(levelProgress(1).percent).toBe(0);
      // No piso de um nível a barra recomeça do zero, e o que falta é o nível inteiro.
      expect(levelProgress(800)).toEqual({
        level: 3,
        levelName: 'Profissional',
        currentLevelMin: 800,
        nextLevelMin: 2000,
        xpIntoLevel: 0,
        xpToNextLevel: 1200,
        percent: 0,
      });
    });

    it('no nível máximo não há próximo: falta nula e barra cheia', () => {
      expect(levelProgress(15000)).toEqual({
        level: 6,
        levelName: 'Lenda',
        currentLevelMin: 12000,
        nextLevelMin: null,
        xpIntoLevel: 3000,
        xpToNextLevel: null,
        percent: 100,
      });
    });
  });

  describe('computeStreak', () => {
    it('sem nenhum dia de atividade a sequência é zero', () => {
      expect(computeStreak([], new Date('2026-03-10T12:00:00Z'))).toBe(0);
    });

    it('a sequência atravessa a virada do mês e para no primeiro dia sem atividade', () => {
      const dates = ['2026-03-01', '2026-02-28', '2026-02-27', '2026-02-25'];
      expect(computeStreak(dates, new Date('2026-03-01T08:00:00Z'))).toBe(3);
    });

    it('a ordem e a repetição das datas não importam: conta dias distintos consecutivos', () => {
      const dates = ['2026-03-08', '2026-03-10', '2026-03-09', '2026-03-10', '2026-03-05'];
      expect(computeStreak(dates, new Date('2026-03-10T12:00:00Z'))).toBe(3);
    });

    it('um único dia de atividade, hoje ou ontem, é sequência de um dia', () => {
      const today = new Date('2026-03-10T12:00:00Z');
      expect(computeStreak(['2026-03-10'], today)).toBe(1);
      expect(computeStreak(['2026-03-09'], today)).toBe(1);
    });

    it('atividade só em dias antigos não conta, mesmo que consecutivos', () => {
      const dates = ['2026-03-07', '2026-03-06', '2026-03-05'];
      expect(computeStreak(dates, new Date('2026-03-10T12:00:00Z'))).toBe(0);
    });

    it('não altera a data de referência recebida', () => {
      const today = new Date('2026-03-10T12:00:00Z');
      computeStreak(['2026-03-09', '2026-03-08'], today);
      expect(today.toISOString()).toBe('2026-03-10T12:00:00.000Z');
    });

    it('sem data informada, conta a partir do dia de hoje', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
      expect(computeStreak(['2026-03-10', '2026-03-09'])).toBe(2);
      vi.setSystemTime(new Date('2026-03-12T12:00:00Z'));
      expect(computeStreak(['2026-03-10', '2026-03-09'])).toBe(0);
    });
  });

  describe('awardXp: o que é gravado', () => {
    it('ganho que não muda de nível: credita sem referência e não acusa level up', async () => {
      repo.applyXp.mockResolvedValue({ previousLevel: 1, level: 1 });

      const res = await gamificationService.awardXp(7, 50, 'review_5_stars');

      expect(repo.applyXp).toHaveBeenCalledTimes(1);
      expect(repo.applyXp).toHaveBeenCalledWith({
        userId: 7,
        delta: 50,
        reason: 'review_5_stars',
        referenceId: null,
      });
      expect(res).toEqual({ leveledUp: false, level: 1 });
    });

    it('o total não é lido fora da transação do crédito: um total velho daria o nível errado', async () => {
      await gamificationService.awardXp(7, 50, 'review_5_stars');

      expect(repo.getOrCreateXp).not.toHaveBeenCalled();
      expect(repo.applyXp).toHaveBeenCalledTimes(1);
    });

    it('ganho de zero XP não grava nada e devolve o nível atual', async () => {
      repo.getOrCreateXp.mockResolvedValue(
        xp({ total_xp: 900, level: 3, level_name: 'Profissional' }),
      );

      expect(await gamificationService.awardXp(7, 0, 'noop', 5)).toEqual({
        leveledUp: false,
        level: 3,
      });
      expect(repo.applyXp).not.toHaveBeenCalled();
    });

    it('subir de nível é o nível de depois do crédito maior que o de antes (RN-052)', async () => {
      repo.applyXp.mockResolvedValue({ previousLevel: 1, level: 2 });

      expect(await gamificationService.awardXp(7, 100, 'contract_completed', 9)).toEqual({
        leveledUp: true,
        level: 2,
      });
      expect(repo.applyXp).toHaveBeenCalledWith({
        userId: 7,
        delta: 100,
        reason: 'contract_completed',
        referenceId: 9,
      });
    });

    it('um ganho grande que pula níveis devolve o nível do total novo', async () => {
      repo.applyXp.mockResolvedValue({ previousLevel: 1, level: 4 });

      expect(await gamificationService.awardXp(7, 2000, 'bonus')).toEqual({
        leveledUp: true,
        level: 4,
      });
      expect(repo.applyXp).toHaveBeenCalledTimes(1);
    });

    it('ganho dentro do mesmo nível, já acima do primeiro, não acusa level up', async () => {
      repo.applyXp.mockResolvedValue({ previousLevel: 3, level: 3 });

      expect(await gamificationService.awardXp(7, 100, 'contract_completed', 9)).toEqual({
        leveledUp: false,
        level: 3,
      });
    });

    it('só subir conta como level up: perda de XP que rebaixa devolve o nível novo sem acusar level up', async () => {
      // xp_transactions aceita valor negativo ("positivo = ganho, negativo = perda", no schema).
      repo.applyXp.mockResolvedValue({ previousLevel: 3, level: 2 });

      expect(await gamificationService.awardXp(7, -200, 'penalty', 12)).toEqual({
        leveledUp: false,
        level: 2,
      });
      expect(repo.applyXp).toHaveBeenCalledTimes(1);
      expect(repo.applyXp).toHaveBeenCalledWith({
        userId: 7,
        delta: -200,
        reason: 'penalty',
        referenceId: 12,
      });
    });

    it('se a gravação falha, o erro sobe: não devolve level up de um XP que não entrou', async () => {
      const boom = new Error('deadlock');
      repo.applyXp.mockRejectedValue(boom);

      await expect(gamificationService.awardXp(7, 100, 'contract_completed', 9)).rejects.toBe(boom);
    });
  });

  describe('evaluateBadges (RN-053)', () => {
    it('quem não tem perfil de freelancer não é avaliado', async () => {
      repo.getFreelancerStats.mockResolvedValue(undefined);

      await gamificationService.evaluateBadges(7);

      expect(repo.getFreelancerStats).toHaveBeenCalledWith(7);
      expect(repo.listActiveBadges).not.toHaveBeenCalled();
      expect(repo.awardBadge).not.toHaveBeenCalled();
    });

    it('badge que o usuário já tem não é concedida de novo', async () => {
      repo.getFreelancerStats.mockResolvedValue(stats(60, 60, '4.90'));
      repo.listBadges.mockResolvedValue([{ slug: 'veteran' }] as unknown as UserBadgeRow[]);
      repo.listActiveBadges.mockResolvedValue([
        badge({ id: 4, slug: 'veteran', xp_reward: 300, criteria: { contracts_completed: 50 } }),
      ]);

      await gamificationService.evaluateBadges(7);

      expect(repo.listBadges).toHaveBeenCalledWith(7);
      expect(repo.awardBadge).not.toHaveBeenCalled();
      expect(repo.applyXp).not.toHaveBeenCalled();
    });

    it('só concede quando TODOS os critérios conhecidos foram atingidos (o limite conta como atingido)', async () => {
      // 10 contratos, 5 avaliações, média 4,5.
      repo.getFreelancerStats.mockResolvedValue(stats(10, 5, '4.50'));
      repo.listActiveBadges.mockResolvedValue([
        badge({ id: 10, slug: 'contratos-no-limite', criteria: { contracts_completed: 10 } }),
        badge({ id: 11, slug: 'contratos-faltando', criteria: { contracts_completed: 11 } }),
        badge({ id: 12, slug: 'criterio-em-texto', criteria: '{"reviews_min":5}' }),
        badge({ id: 13, slug: 'json-quebrado', criteria: '{reviews_min' }),
        badge({ id: 14, slug: 'sem-criterio', criteria: null }),
        badge({ id: 15, slug: 'criterio-vazio', criteria: {} }),
        badge({ id: 16, slug: 'nota-faltando', criteria: { avg_rating_min: 4.6 } }),
        badge({ id: 17, slug: 'nota-no-limite', criteria: { avg_rating_min: 4.5 } }),
        badge({
          id: 18,
          slug: 'clientes-recorrentes',
          criteria: { contracts_completed: 1, repeat_clients: 3 },
        }),
        badge({
          id: 19,
          slug: 'permutas',
          criteria: { contracts_completed: 1, barters_completed: 1 },
        }),
        badge({ id: 20, slug: 'criterio-desconhecido', criteria: { something_else: 1 } }),
        badge({
          id: 21,
          slug: 'um-de-dois',
          criteria: { contracts_completed: 10, reviews_min: 6 },
        }),
        badge({ id: 22, slug: 'avaliacoes-faltando', criteria: { reviews_min: 6 } }),
        // Critério ainda não rastreado barra a badge mesmo com os outros critérios atingidos.
        badge({
          id: 23,
          slug: 'entregas-no-prazo',
          criteria: { contracts_completed: 1, on_time_deliveries: 20 },
        }),
        badge({
          id: 24,
          slug: 'tres-criterios',
          criteria: { contracts_completed: 10, reviews_min: 5, avg_rating_min: 4.5 },
        }),
      ]);
      repo.awardBadge.mockResolvedValue(false);

      await gamificationService.evaluateBadges(7);

      expect(repo.awardBadge.mock.calls).toEqual([
        [7, 10],
        [7, 12],
        [7, 17],
        [7, 24],
      ]);
      // Nenhuma foi concedida "agora" (awardBadge devolveu false): não há XP de recompensa.
      expect(repo.applyXp).not.toHaveBeenCalled();
    });

    it('cada badge concedida na mesma avaliação credita a sua recompensa, num crédito próprio', async () => {
      repo.getFreelancerStats.mockResolvedValue(stats(50, 50, '4.80'));
      repo.listActiveBadges.mockResolvedValue([
        badge({ id: 4, slug: 'veteran', xp_reward: 300, criteria: { contracts_completed: 50 } }),
        badge({ id: 2, slug: 'top-rated', xp_reward: 200, criteria: { reviews_min: 50 } }),
      ]);
      repo.awardBadge.mockResolvedValue(true);

      await gamificationService.evaluateBadges(7);

      expect(repo.awardBadge.mock.calls).toEqual([
        [7, 4],
        [7, 2],
      ]);
      // Cada crédito soma ao total travado na sua transação: o segundo vê o primeiro.
      expect(repo.applyXp.mock.calls).toEqual([
        [{ userId: 7, delta: 300, reason: 'badge_earned', referenceId: 4 }],
        [{ userId: 7, delta: 200, reason: 'badge_earned', referenceId: 2 }],
      ]);
    });

    it('badge concedida agora, com recompensa, credita o XP dela com o id da badge como referência', async () => {
      repo.getFreelancerStats.mockResolvedValue(stats(50, 0, '0.00'));
      repo.listActiveBadges.mockResolvedValue([
        badge({ id: 4, slug: 'veteran', xp_reward: 300, criteria: { contracts_completed: 50 } }),
      ]);
      repo.awardBadge.mockResolvedValue(true);

      await gamificationService.evaluateBadges(7);

      expect(repo.awardBadge).toHaveBeenCalledWith(7, 4);
      expect(repo.applyXp).toHaveBeenCalledTimes(1);
      expect(repo.applyXp).toHaveBeenCalledWith({
        userId: 7,
        delta: 300,
        reason: 'badge_earned',
        referenceId: 4,
      });
    });

    it('não credita XP se a badge não tem recompensa, nem se o usuário já a tinha (concessão repetida)', async () => {
      repo.getFreelancerStats.mockResolvedValue(stats(50, 0, '0.00'));
      repo.listActiveBadges.mockResolvedValue([
        badge({
          id: 4,
          slug: 'sem-recompensa',
          xp_reward: 0,
          criteria: { contracts_completed: 1 },
        }),
        badge({ id: 5, slug: 'ja-tinha', xp_reward: 300, criteria: { contracts_completed: 1 } }),
      ]);
      repo.awardBadge.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await gamificationService.evaluateBadges(7);

      expect(repo.awardBadge.mock.calls).toEqual([
        [7, 4],
        [7, 5],
      ]);
      expect(repo.getOrCreateXp).not.toHaveBeenCalled();
      expect(repo.applyXp).not.toHaveBeenCalled();
    });
  });

  describe('getProfile', () => {
    it('devolve XP, nível, progresso, sequência, posição e badges de quem pede', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
      repo.getOrCreateXp.mockResolvedValue(
        xp({ user_id: 7, total_xp: 350, level: 2, level_name: 'Aprendiz' }),
      );
      repo.listBadges.mockResolvedValue([
        { slug: 'first-deal', name: 'Primeiro Negócio', awarded_at: '2026-01-01T00:00:00Z' },
      ] as unknown as UserBadgeRow[]);
      // Em Manaus: 10/03, 09/03 (23:30, já 10/03 em UTC) e 07/03.
      repo.activityTimes.mockResolvedValue([
        new Date('2026-03-10T14:00:00Z'),
        new Date('2026-03-10T03:30:00Z'),
        new Date('2026-03-07T15:00:00Z'),
      ]);
      repo.rankOf.mockResolvedValue(5);
      zone.mockResolvedValue('America/Manaus');

      const profile = await gamificationService.getProfile(7);

      expect(profile).toEqual({
        totalXp: 350,
        level: 2,
        levelName: 'Aprendiz',
        progress: {
          level: 2,
          levelName: 'Aprendiz',
          currentLevelMin: 300,
          nextLevelMin: 800,
          xpIntoLevel: 50,
          xpToNextLevel: 450,
          percent: 10,
        },
        streakDays: 2,
        rank: 5,
        badges: [
          { slug: 'first-deal', name: 'Primeiro Negócio', awardedAt: '2026-01-01T00:00:00.000Z' },
        ],
      });
      expect(repo.getOrCreateXp).toHaveBeenCalledWith(7);
      expect(repo.listBadges).toHaveBeenCalledWith(7);
      // A sequência olha os últimos 60 dias (mais um, para o primeiro caber inteiro no fuso).
      expect(repo.activityTimes).toHaveBeenCalledWith(7, new Date('2026-01-08T12:00:00Z'));
      expect(repo.rankOf).toHaveBeenCalledWith(7);
      expect(zone).toHaveBeenCalledWith(7);
    });

    it('a sequência conta os dias no fuso da pessoa: atividade às 22h de Brasília não pula para o dia seguinte', async () => {
      // 11/03, 10:00 em Brasília. Atividade às 10h de 09/03 e às 22h de 10/03 (01:00 de 11/03 em UTC).
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-11T13:00:00Z'));
      repo.getOrCreateXp.mockResolvedValue(xp({ user_id: 7 }));
      repo.activityTimes.mockResolvedValue([
        new Date('2026-03-11T01:00:00Z'),
        new Date('2026-03-09T13:00:00Z'),
      ]);
      zone.mockResolvedValue('America/Sao_Paulo');

      const profile = await gamificationService.getProfile(7);

      // 10/03 e 09/03 em Brasília: dois dias seguidos até ontem. Em UTC seriam 11/03 e 09/03 (um).
      expect(profile.streakDays).toBe(2);
    });
  });

  describe('getHistory', () => {
    it('devolve os ganhos com a data em ISO; sem limite informado, pede os 20 últimos', async () => {
      repo.recentEvents.mockResolvedValue([
        { amount: 100, reason: 'contract_completed', created_at: new Date('2026-03-10T12:00:00Z') },
        { amount: 50, reason: 'review_5_stars', created_at: '2026-03-09T08:30:00Z' },
      ] as unknown as XpEventRow[]);

      expect(await gamificationService.getHistory(7)).toEqual([
        { amount: 100, reason: 'contract_completed', at: '2026-03-10T12:00:00.000Z' },
        { amount: 50, reason: 'review_5_stars', at: '2026-03-09T08:30:00.000Z' },
      ]);
      expect(repo.recentEvents).toHaveBeenCalledWith(7, 20);
    });

    it('respeita o limite pedido', async () => {
      repo.recentEvents.mockResolvedValue([]);
      expect(await gamificationService.getHistory(7, 5)).toEqual([]);
      expect(repo.recentEvents).toHaveBeenCalledWith(7, 5);
    });
  });

  describe('getLeaderboard', () => {
    it('a posição é a ordem em que o repository entrega; sem limite informado, são os 10 primeiros', async () => {
      repo.leaderboard.mockResolvedValue([
        { ulid: '01HXA', name: 'Ana', total_xp: 900, level: 3, level_name: 'Profissional' },
        { ulid: '01HXB', name: null, total_xp: 100, level: 1, level_name: 'Iniciante' },
      ] as unknown as LeaderboardRow[]);

      expect(await gamificationService.getLeaderboard()).toEqual([
        {
          rank: 1,
          userUlid: '01HXA',
          name: 'Ana',
          totalXp: 900,
          level: 3,
          levelName: 'Profissional',
        },
        { rank: 2, userUlid: '01HXB', name: null, totalXp: 100, level: 1, levelName: 'Iniciante' },
      ]);
      expect(repo.leaderboard).toHaveBeenCalledWith(10);
    });

    it('respeita o limite pedido', async () => {
      repo.leaderboard.mockResolvedValue([]);
      expect(await gamificationService.getLeaderboard(3)).toEqual([]);
      expect(repo.leaderboard).toHaveBeenCalledWith(3);
    });
  });

  describe('onContractCompleted (RN-051)', () => {
    const firstDeal = badge({ id: 1, slug: 'first-deal', xp_reward: 50 });
    /** O crédito do contrato: os 100 XP e a contagem do contrato vão juntos, numa transação só. */
    const contractCredit = (contractId: number): Record<string, unknown> => ({
      userId: 7,
      delta: 100,
      reason: 'contract_completed',
      referenceId: contractId,
      countContract: true,
    });

    it('conta o contrato e dá 100 XP no mesmo crédito, concede a first-deal e reavalia as badges', async () => {
      repo.findBadgeBySlug.mockResolvedValue(firstDeal);
      repo.awardBadge.mockResolvedValue(true);
      repo.getFreelancerStats.mockResolvedValue(stats(1, 0, '0.00'));

      await gamificationService.onContractCompleted(7, 55);

      expect(repo.findBadgeBySlug).toHaveBeenCalledWith('first-deal');
      expect(repo.awardBadge).toHaveBeenCalledWith(7, 1);
      expect(repo.applyXp.mock.calls).toEqual([
        [contractCredit(55)],
        [{ userId: 7, delta: 50, reason: 'badge_earned', referenceId: 1 }],
      ]);
      // As badges por critério são avaliadas depois de o contrato entrar na contagem.
      expect(repo.getFreelancerStats).toHaveBeenCalledWith(7);
      expect(repo.applyXp.mock.invocationCallOrder[0]!).toBeLessThan(
        repo.getFreelancerStats.mock.invocationCallOrder[0]!,
      );
      expect(repo.listActiveBadges).toHaveBeenCalledTimes(1);
    });

    it('do segundo contrato em diante a first-deal já existe: só o crédito do contrato', async () => {
      repo.findBadgeBySlug.mockResolvedValue(firstDeal);
      repo.awardBadge.mockResolvedValue(false);

      await gamificationService.onContractCompleted(7, 56);

      // A concessão é tentada de novo (o banco é quem diz que já existia), mas não rende XP.
      expect(repo.awardBadge.mock.calls).toEqual([[7, 1]]);
      expect(repo.applyXp.mock.calls).toEqual([[contractCredit(56)]]);
    });

    it('se o crédito do contrato falha, o erro sobe: nem a contagem nem os XP entram, e nenhuma badge é concedida', async () => {
      const boom = new Error('deadlock');
      repo.applyXp.mockRejectedValue(boom);
      repo.findBadgeBySlug.mockResolvedValue(firstDeal);

      await expect(gamificationService.onContractCompleted(7, 59)).rejects.toBe(boom);

      // A contagem não tem chamada própria: ela é desfeita junto com os XP, na mesma transação.
      expect(repo.applyXp.mock.calls).toEqual([[contractCredit(59)]]);
      expect(repo.findBadgeBySlug).not.toHaveBeenCalled();
      expect(repo.awardBadge).not.toHaveBeenCalled();
      expect(repo.getFreelancerStats).not.toHaveBeenCalled();
    });

    it('sem a first-deal no catálogo (ou desativada), nada é concedido e o contrato vale XP do mesmo jeito', async () => {
      repo.findBadgeBySlug.mockResolvedValue(undefined);

      await gamificationService.onContractCompleted(7, 57);

      expect(repo.findBadgeBySlug).toHaveBeenCalledWith('first-deal');
      expect(repo.awardBadge).not.toHaveBeenCalled();
      expect(repo.applyXp.mock.calls).toEqual([[contractCredit(57)]]);
      expect(repo.getFreelancerStats).toHaveBeenCalledWith(7);
    });

    it('first-deal sem recompensa é concedida sem crédito de XP extra', async () => {
      repo.findBadgeBySlug.mockResolvedValue(badge({ id: 1, slug: 'first-deal', xp_reward: 0 }));
      repo.awardBadge.mockResolvedValue(true);

      await gamificationService.onContractCompleted(7, 58);

      expect(repo.awardBadge).toHaveBeenCalledWith(7, 1);
      // O único crédito é o do contrato: nenhum lançamento 'badge_earned' de 0 XP.
      expect(repo.applyXp.mock.calls).toEqual([[contractCredit(58)]]);
    });
  });

  describe('onReviewReceived (RN-051)', () => {
    it.each([
      [5, 50, 'review_5_stars'],
      [4, 20, 'review_4_stars'],
    ])('nota %i dá +%i XP, com a avaliação como referência', async (rating, delta, reason) => {
      await gamificationService.onReviewReceived(7, rating, 31);

      expect(repo.applyXp).toHaveBeenCalledTimes(1);
      // Avaliação não é contrato: o crédito não mexe na contagem de contratos.
      expect(repo.applyXp).toHaveBeenCalledWith({ userId: 7, delta, reason, referenceId: 31 });
      expect(repo.getFreelancerStats).toHaveBeenCalledWith(7);
    });

    it('nota 3 ou menor não dá XP, mas as badges são reavaliadas (a avaliação muda as estatísticas)', async () => {
      for (const rating of [3, 2, 1]) {
        await gamificationService.onReviewReceived(7, rating, 31);
      }

      expect(repo.getOrCreateXp).not.toHaveBeenCalled();
      expect(repo.applyXp).not.toHaveBeenCalled();
      expect(repo.getFreelancerStats).toHaveBeenCalledTimes(3);
      expect(repo.getFreelancerStats).toHaveBeenCalledWith(7);
    });

    it('a avaliação que completa o critério concede a badge por nota', async () => {
      repo.getFreelancerStats.mockResolvedValue(stats(60, 50, '4.80'));
      repo.listActiveBadges.mockResolvedValue([
        badge({
          id: 2,
          slug: 'top-rated',
          xp_reward: 200,
          criteria: { reviews_min: 50, avg_rating_min: 4.5 },
        }),
      ]);
      repo.awardBadge.mockResolvedValue(true);

      await gamificationService.onReviewReceived(7, 5, 31);

      expect(repo.awardBadge).toHaveBeenCalledWith(7, 2);
      expect(repo.applyXp.mock.calls.map(([p]) => [p.delta, p.reason, p.referenceId])).toEqual([
        [50, 'review_5_stars', 31],
        [200, 'badge_earned', 2],
      ]);
    });
  });
});
