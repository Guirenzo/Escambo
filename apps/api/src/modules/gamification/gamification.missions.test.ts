import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./gamification.missions.repository', () => ({
  missionsRepository: {
    findAccount: vi.fn(),
    listActive: vi.fn(),
    listForPeriods: vi.fn(),
    saveProgress: vi.fn(),
    complete: vi.fn(),
    countCompletedContracts: vi.fn(),
    countFastResponses: vi.fn(),
    countCompletedBarters: vi.fn(),
  },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));

import { setClockForTests } from '../../utils/clock';
import { notificationsService } from '../notifications/notifications.service';
import { missionPeriod, missionsService, parseMission, windowOf } from './gamification.missions';
import {
  missionsRepository,
  type MissionCatalogRow,
  type UserMissionRow,
} from './gamification.missions.repository';

/**
 * Missões com prazo (RF-066, RN-054): o período no fuso da conta (fronteiras do dia e da semana), a
 * leitura do catálogo e a avaliação — progresso recontado na fonte, gravado só quando sobe,
 * conclusão uma vez só com XP e aviso, e o período antigo que deixa de contar.
 */

const repo = vi.mocked(missionsRepository);
const notify = vi.mocked(notificationsService.notify);

const at = (iso: string): Date => new Date(iso);

/** O catálogo do seed (apps/api/db/seed.sql), com os ids do banco novo. */
const SEED: MissionCatalogRow[] = [
  {
    id: 1,
    title: 'Maratona da semana',
    description: 'Conclua 3 serviços nesta semana',
    xp_reward: 200,
    type: 'weekly',
    criteria: '{"action": "complete_contracts", "count": 3}',
  },
  {
    id: 2,
    title: 'Resposta rápida',
    description: 'Responda propostas em menos de 2 horas',
    xp_reward: 100,
    type: 'weekly',
    criteria: { action: 'fast_response_hours', count: 2 },
  },
  {
    id: 3,
    title: 'Presença diária',
    description: 'Acesse a plataforma hoje',
    xp_reward: 10,
    type: 'daily',
    criteria: '{"action": "daily_login", "count": 1}',
  },
  {
    id: 4,
    title: 'Primeira troca',
    description: 'Feche sua primeira troca de serviço',
    xp_reward: 150,
    type: 'achievement',
    criteria: '{"action": "complete_barter", "count": 1}',
  },
] as unknown as MissionCatalogRow[];

const userMission = (o: Partial<Record<keyof UserMissionRow, unknown>>): UserMissionRow =>
  ({
    id: 90,
    mission_id: 1,
    period_key: 'w:2026-10-19',
    progress: 0,
    is_completed: 0,
    completed_at: null,
    ...o,
  }) as unknown as UserMissionRow;

describe('missionPeriod (RN-054): o período no fuso da conta', () => {
  it('diária em Brasília: do 00:00 ao 23:59:59 do dia de lá', () => {
    // Segunda, 19/10/2026, 12:00 em Brasília.
    const p = missionPeriod('daily', 'America/Sao_Paulo', at('2026-10-19T15:00:00Z'));
    expect(p).toEqual({
      key: 'd:2026-10-19',
      start: at('2026-10-19T03:00:00Z'),
      expiresAt: at('2026-10-20T02:59:59Z'),
    });
  });

  it('a diária vira à meia-noite do fuso: 23:59:59 ainda é o dia, 00:00:00 já é o seguinte', () => {
    expect(missionPeriod('daily', 'America/Sao_Paulo', at('2026-10-20T02:59:59Z')).key).toBe(
      'd:2026-10-19',
    );
    expect(missionPeriod('daily', 'America/Sao_Paulo', at('2026-10-20T03:00:00Z')).key).toBe(
      'd:2026-10-20',
    );
  });

  it('o mesmo instante é dias diferentes em Manaus, Brasília e Noronha', () => {
    // 03:30 UTC do dia 20: 23:30 do dia 19 em Manaus, 00:30 do dia 20 em Brasília.
    const instant = at('2026-10-20T03:30:00Z');
    expect(missionPeriod('daily', 'America/Manaus', instant)).toEqual({
      key: 'd:2026-10-19',
      start: at('2026-10-19T04:00:00Z'),
      expiresAt: at('2026-10-20T03:59:59Z'),
    });
    expect(missionPeriod('daily', 'America/Sao_Paulo', instant).key).toBe('d:2026-10-20');
    // Noronha (UTC−2) vira uma hora antes de Brasília.
    expect(missionPeriod('daily', 'America/Noronha', at('2026-10-20T02:00:00Z')).key).toBe(
      'd:2026-10-20',
    );
    expect(missionPeriod('daily', 'America/Sao_Paulo', at('2026-10-20T02:00:00Z')).key).toBe(
      'd:2026-10-19',
    );
  });

  it('semanal: de segunda 00:00 a domingo 23:59:59; a chave é a segunda-feira', () => {
    // Quarta, 21/10/2026.
    expect(missionPeriod('weekly', 'America/Sao_Paulo', at('2026-10-21T18:00:00Z'))).toEqual({
      key: 'w:2026-10-19',
      start: at('2026-10-19T03:00:00Z'),
      expiresAt: at('2026-10-26T02:59:59Z'),
    });
    // Na própria segunda e no domingo, a mesma semana.
    expect(missionPeriod('weekly', 'America/Sao_Paulo', at('2026-10-19T03:00:00Z')).key).toBe(
      'w:2026-10-19',
    );
    expect(missionPeriod('weekly', 'America/Sao_Paulo', at('2026-10-25T20:00:00Z')).key).toBe(
      'w:2026-10-19',
    );
  });

  it('a semana vira no domingo 23:59:59 do fuso, e não no de Greenwich nem no de Brasília', () => {
    // Domingo 23:59:59 em Brasília: ainda a semana de 19/10; um segundo depois, a de 26/10.
    expect(missionPeriod('weekly', 'America/Sao_Paulo', at('2026-10-26T02:59:59Z')).key).toBe(
      'w:2026-10-19',
    );
    expect(missionPeriod('weekly', 'America/Sao_Paulo', at('2026-10-26T03:00:00Z')).key).toBe(
      'w:2026-10-26',
    );
    // Em Manaus, 03:30 UTC de segunda ainda é domingo 23:30: a semana é a anterior.
    const manaus = missionPeriod('weekly', 'America/Manaus', at('2026-10-26T03:30:00Z'));
    expect(manaus).toEqual({
      key: 'w:2026-10-19',
      start: at('2026-10-19T04:00:00Z'),
      expiresAt: at('2026-10-26T03:59:59Z'),
    });
    expect(missionPeriod('weekly', 'America/Manaus', at('2026-10-26T04:00:00Z')).key).toBe(
      'w:2026-10-26',
    );
  });

  it('a semana que cruza a virada do mês e do ano', () => {
    // Sexta, 01/01/2027: a segunda da semana é 28/12/2026.
    expect(missionPeriod('weekly', 'America/Sao_Paulo', at('2027-01-01T15:00:00Z'))).toEqual({
      key: 'w:2026-12-28',
      start: at('2026-12-28T03:00:00Z'),
      expiresAt: at('2027-01-04T02:59:59Z'),
    });
  });

  it('a conquista não tem prazo: um período só', () => {
    expect(missionPeriod('achievement', 'America/Sao_Paulo', at('2026-10-19T15:00:00Z'))).toEqual({
      key: 'sempre',
      start: null,
      expiresAt: null,
    });
  });

  it('windowOf: até o segundo seguinte ao 23:59:59 (exclusivo); sem prazo, sem limites', () => {
    const p = missionPeriod('daily', 'America/Sao_Paulo', at('2026-10-19T15:00:00Z'));
    expect(windowOf(p)).toEqual({
      start: at('2026-10-19T03:00:00Z'),
      end: at('2026-10-20T03:00:00Z'),
    });
    expect(windowOf({ key: 'sempre', start: null, expiresAt: null })).toEqual({
      start: null,
      end: null,
    });
  });
});

describe('parseMission: o critério do catálogo', () => {
  it('lê o catálogo do seed: count é a meta, exceto na resposta rápida (horas) e na presença', () => {
    expect(SEED.map(parseMission)).toEqual([
      {
        id: 1,
        title: 'Maratona da semana',
        description: 'Conclua 3 serviços nesta semana',
        type: 'weekly',
        action: 'complete_contracts',
        xpReward: 200,
        target: 3,
        hours: null,
      },
      expect.objectContaining({ action: 'fast_response_hours', target: 1, hours: 2 }),
      expect.objectContaining({ action: 'daily_login', target: 1, hours: null }),
      expect.objectContaining({ action: 'complete_barter', type: 'achievement', target: 1 }),
    ]);
  });

  it('a presença conta uma vez por período, mesmo com count maior', () => {
    const row = { ...SEED[2]!, criteria: { action: 'daily_login', count: 3 } };
    expect(parseMission(row as MissionCatalogRow)?.target).toBe(1);
  });

  it.each([
    ['ação desconhecida', { action: 'send_messages', count: 1 }],
    ['count zero', { action: 'complete_contracts', count: 0 }],
    ['count quebrado', { action: 'complete_contracts', count: 1.5 }],
    ['count em texto', { action: 'complete_contracts', count: '3' }],
    ['critério nulo', null],
    ['JSON quebrado', '{"action": '],
    ['critério que não é objeto', '"complete_contracts"'],
  ])('fica de fora: %s', (_rule, criteria) => {
    expect(parseMission({ ...SEED[0]!, criteria } as MissionCatalogRow)).toBeNull();
  });

  it('fica de fora: tipo fora da lista', () => {
    expect(parseMission({ ...SEED[0]!, type: 'monthly' } as unknown as MissionCatalogRow)).toBe(
      null,
    );
  });
});

describe('missionsService.evaluate', () => {
  // Quarta, 21/10/2026, 12:00 em Brasília.
  const NOW = at('2026-10-21T15:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    setClockForTests(NOW, { frozen: true });
    repo.findAccount.mockResolvedValue({ timezone: 'America/Sao_Paulo' });
    repo.listActive.mockResolvedValue(SEED);
    repo.listForPeriods.mockResolvedValue([]);
    repo.countCompletedContracts.mockResolvedValue(0);
    repo.countFastResponses.mockResolvedValue(0);
    repo.countCompletedBarters.mockResolvedValue(0);
    repo.complete.mockResolvedValue(true);
  });
  afterEach(() => setClockForTests(null));

  it('conta sem perfil de freelancer, suspensa ou banida: lista vazia e nada gravado', async () => {
    repo.findAccount.mockResolvedValue(undefined);

    expect(await missionsService.list(7)).toEqual([]);

    expect(repo.listActive).not.toHaveBeenCalled();
    expect(repo.saveProgress).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it('abrir as missões cumpre a presença do dia: grava e conclui com o XP do catálogo, sem aviso', async () => {
    const missions = await missionsService.list(7);

    expect(repo.listForPeriods).toHaveBeenCalledWith(7, ['w:2026-10-19', 'd:2026-10-21', 'sempre']);
    expect(repo.saveProgress).toHaveBeenCalledTimes(1);
    expect(repo.saveProgress).toHaveBeenCalledWith({
      userId: 7,
      missionId: 3,
      periodKey: 'd:2026-10-21',
      progress: 1,
      expiresAt: at('2026-10-22T02:59:59Z'),
    });
    expect(repo.complete).toHaveBeenCalledTimes(1);
    expect(repo.complete).toHaveBeenCalledWith({
      userId: 7,
      missionId: 3,
      periodKey: 'd:2026-10-21',
      xp: 10,
      now: NOW,
    });
    // Quem cumpriu a presença está olhando o cartão: um aviso por dia só encheria o sino.
    expect(notify).not.toHaveBeenCalled();

    expect(missions).toEqual([
      {
        id: 1,
        title: 'Maratona da semana',
        description: 'Conclua 3 serviços nesta semana',
        type: 'weekly',
        action: 'complete_contracts',
        xpReward: 200,
        progress: 0,
        target: 3,
        completed: false,
        completedAt: null,
        expiresAt: '2026-10-26T02:59:59.000Z',
      },
      expect.objectContaining({ id: 2, progress: 0, target: 1, completed: false }),
      expect.objectContaining({
        id: 3,
        progress: 1,
        target: 1,
        completed: true,
        completedAt: NOW.toISOString(),
        expiresAt: '2026-10-22T02:59:59.000Z',
      }),
      expect.objectContaining({ id: 4, completed: false, expiresAt: null }),
    ]);
  });

  it('as contagens recebem a janela do período no fuso da conta; a conquista conta tudo', async () => {
    repo.findAccount.mockResolvedValue({ timezone: 'America/Manaus' });

    await missionsService.evaluate(7);

    const week = { start: at('2026-10-19T04:00:00Z'), end: at('2026-10-26T04:00:00Z') };
    expect(repo.countCompletedContracts).toHaveBeenCalledWith(7, week);
    expect(repo.countFastResponses).toHaveBeenCalledWith(7, week, 2);
    expect(repo.countCompletedBarters).toHaveBeenCalledWith(7, { start: null, end: null });
    // Sem ser um acesso, a presença não conta.
    expect(repo.saveProgress).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it('fuso nulo ou fora da lista vale Brasília', async () => {
    repo.findAccount.mockResolvedValue({ timezone: null });
    await missionsService.evaluate(7, { actions: ['complete_contracts'] });
    expect(repo.countCompletedContracts).toHaveBeenCalledWith(7, {
      start: at('2026-10-19T03:00:00Z'),
      end: at('2026-10-26T03:00:00Z'),
    });
  });

  it('o evento conta só as missões da ação dele', async () => {
    repo.countCompletedContracts.mockResolvedValue(2);

    const missions = await missionsService.evaluate(7, { actions: ['complete_contracts'] });

    expect(missions.map((m) => m.id)).toEqual([1]);
    expect(repo.countFastResponses).not.toHaveBeenCalled();
    expect(repo.countCompletedBarters).not.toHaveBeenCalled();
    expect(repo.listForPeriods).toHaveBeenCalledWith(7, ['w:2026-10-19']);
    expect(repo.saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: 1, periodKey: 'w:2026-10-19', progress: 2 }),
    );
    // 2 de 3: ainda não cumprida.
    expect(repo.complete).not.toHaveBeenCalled();
    expect(missions[0]).toMatchObject({ progress: 2, target: 3, completed: false });
  });

  it('nenhuma missão do catálogo para a ação: nada é lido do progresso', async () => {
    repo.listActive.mockResolvedValue([SEED[2]!]);
    expect(await missionsService.evaluate(7, { actions: ['complete_contracts'] })).toEqual([]);
    expect(repo.listForPeriods).not.toHaveBeenCalled();
  });

  it('na meta, conclui uma vez; o progresso guardado passa da meta só até ela', async () => {
    repo.countCompletedContracts.mockResolvedValue(5);

    const [m] = await missionsService.evaluate(7, { actions: ['complete_contracts'] });

    expect(repo.saveProgress).toHaveBeenCalledWith(expect.objectContaining({ progress: 3 }));
    expect(repo.complete).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: 1, periodKey: 'w:2026-10-19', xp: 200 }),
    );
    expect(notify).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ body: 'Você ganhou 200 XP.' }),
    );
    expect(m).toMatchObject({ progress: 3, completed: true, completedAt: NOW.toISOString() });
  });

  it('idempotente: o mesmo evento de novo reconta o mesmo número e não grava nem conclui', async () => {
    repo.countCompletedContracts.mockResolvedValue(2);
    repo.listForPeriods.mockResolvedValue([userMission({ progress: 2 })]);

    const [m] = await missionsService.evaluate(7, { actions: ['complete_contracts'] });

    expect(repo.countCompletedContracts).toHaveBeenCalledTimes(1);
    expect(repo.saveProgress).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
    expect(m).toMatchObject({ progress: 2, completed: false });
  });

  it('o progresso mostrado não volta se a contagem cair (contraparte suspensa depois)', async () => {
    repo.countCompletedContracts.mockResolvedValue(1);
    repo.listForPeriods.mockResolvedValue([userMission({ progress: 2 })]);

    const [m] = await missionsService.evaluate(7, { actions: ['complete_contracts'] });

    expect(repo.saveProgress).not.toHaveBeenCalled();
    expect(m).toMatchObject({ progress: 2 });
  });

  it('já cumprida no período: não reconta, não conclui de novo, e mostra a hora da conclusão', async () => {
    const done = at('2026-10-20T12:00:00Z');
    repo.listForPeriods.mockResolvedValue([
      userMission({ progress: 3, is_completed: 1, completed_at: done }),
    ]);

    const [m] = await missionsService.evaluate(7, { actions: ['complete_contracts'] });

    expect(repo.countCompletedContracts).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(m).toMatchObject({ progress: 3, completed: true, completedAt: done.toISOString() });
  });

  it('a linha de outro período (a semana passada) não conta: o progresso recomeça', async () => {
    repo.countCompletedContracts.mockResolvedValue(1);
    repo.listForPeriods.mockResolvedValue([
      userMission({ period_key: 'w:2026-10-12', progress: 3, is_completed: 1 }),
    ]);

    const [m] = await missionsService.evaluate(7, { actions: ['complete_contracts'] });

    expect(repo.saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({ periodKey: 'w:2026-10-19', progress: 1 }),
    );
    expect(m).toMatchObject({ progress: 1, completed: false });
  });

  it('concluída em paralelo por outra chamada: cumprida, mas o aviso é só de quem concluiu', async () => {
    repo.countCompletedBarters.mockResolvedValue(1);
    repo.complete.mockResolvedValue(false);

    const [m] = await missionsService.evaluate(7, { actions: ['complete_barter'] });

    expect(repo.complete).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(m).toMatchObject({ id: 4, completed: true });
  });

  it('missão sem recompensa avisa sem falar de XP', async () => {
    repo.listActive.mockResolvedValue([{ ...SEED[3]!, xp_reward: 0 } as MissionCatalogRow]);
    repo.countCompletedBarters.mockResolvedValue(1);

    await missionsService.evaluate(7);

    expect(notify).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ title: 'Missão cumprida: Primeira troca', body: null }),
    );
  });

  it('a resposta rápida usa o limite de horas do catálogo e cumpre com uma resposta', async () => {
    repo.countFastResponses.mockResolvedValue(1);

    const [m] = await missionsService.evaluate(7, { actions: ['fast_response_hours'] });

    expect(repo.countFastResponses).toHaveBeenCalledWith(7, expect.any(Object), 2);
    expect(repo.complete).toHaveBeenCalledWith(expect.objectContaining({ missionId: 2, xp: 100 }));
    expect(m).toMatchObject({ progress: 1, target: 1, completed: true });
  });

  it('missão quebrada no catálogo é ignorada, as outras seguem', async () => {
    repo.listActive.mockResolvedValue([
      { ...SEED[0]!, id: 9, criteria: '{"action": "send_messages", "count": 1}' },
      SEED[2]!,
    ] as MissionCatalogRow[]);

    const missions = await missionsService.list(7);

    expect(missions.map((m) => m.id)).toEqual([3]);
  });
});
