import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./profiles.repository', () => ({
  profilesRepository: {
    upsertFreelancer: vi.fn(),
    upsertClient: vi.fn(),
    findFreelancerByUserId: vi.fn(),
    findClientByUserId: vi.fn(),
    findPublicFreelancerByUlid: vi.fn(),
    listPortfolio: vi.fn().mockResolvedValue([]),
  },
}));

import { computeEscamboScore } from '../score/score.service';
import { parseDays, profilesService } from './profiles.service';
import {
  profilesRepository,
  type ClientRow,
  type FreelancerRow,
  type PortfolioRow,
  type PublicFreelancerRow,
} from './profiles.repository';

const repo = vi.mocked(profilesRepository);

const freelancerRow = (o: Partial<Record<keyof FreelancerRow, unknown>> = {}): FreelancerRow =>
  ({
    full_name: 'Rafael',
    avatar_url: null,
    bio: null,
    headline: 'Dev Full Stack',
    city: 'Joinville',
    state: 'SC',
    is_available: 1,
    avg_rating: '4.50',
    total_reviews: 10,
    total_contracts: 12,
    ...o,
  }) as unknown as FreelancerRow;

beforeEach(() => vi.clearAllMocks());

describe('profilesService.upsertFreelancer', () => {
  it('salva e retorna o perfil mapeado (flags/decimais)', async () => {
    repo.upsertFreelancer.mockResolvedValue(undefined);
    repo.findFreelancerByUserId.mockResolvedValue(freelancerRow());

    const p = await profilesService.upsertFreelancer(1, { fullName: 'Rafael', isAvailable: true });

    expect(repo.upsertFreelancer).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ fullName: 'Rafael', isAvailable: true }),
    );
    expect(p.isAvailable).toBe(true);
    expect(p.avgRating).toBe(4.5);
    expect(p.totalReviews).toBe(10);
  });
});

describe('profilesService.getPublicFreelancer', () => {
  it('404 quando não existe', async () => {
    repo.findPublicFreelancerByUlid.mockResolvedValue(undefined);
    await expect(profilesService.getPublicFreelancer('01ABC')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('retorna perfil público com nível', async () => {
    repo.findPublicFreelancerByUlid.mockResolvedValue({
      ...freelancerRow(),
      ulid: '01HZXULIDEXAMPLE0000000000',
      level: 3,
      level_name: 'Profissional',
    } as unknown as PublicFreelancerRow);

    const p = await profilesService.getPublicFreelancer('01HZXULIDEXAMPLE0000000000');

    expect(p.userUlid).toBe('01HZXULIDEXAMPLE0000000000');
    expect(p.level).toBe(3);
    expect(p.levelName).toBe('Profissional');
    expect(p.avgRating).toBe(4.5);
    expect(p.portfolio).toEqual([]);
  });
});

describe('profilesService.upsertFreelancer: o que vai para o banco e o que volta', () => {
  it('campo que a pessoa não preencheu vai como null, e sem dizer nada ela nasce aceitando pedidos', async () => {
    repo.findFreelancerByUserId.mockResolvedValue(freelancerRow());

    await profilesService.upsertFreelancer(7, { fullName: 'Rafael' });

    expect(repo.upsertFreelancer).toHaveBeenCalledTimes(1);
    expect(repo.upsertFreelancer).toHaveBeenCalledWith(7, {
      fullName: 'Rafael',
      avatarUrl: null,
      bio: null,
      headline: null,
      city: null,
      state: null,
      latitude: null,
      longitude: null,
      isAvailable: true,
      availableDays: null,
      availablePeriods: null,
    });
    // O perfil devolvido é o do próprio usuário, lido depois da gravação.
    expect(repo.findFreelancerByUserId).toHaveBeenCalledWith(7);
  });

  it('pausar o atendimento chega como false (o padrão "aceitando" não passa por cima) e os campos preenchidos vão como vieram', async () => {
    repo.findFreelancerByUserId.mockResolvedValue(freelancerRow({ is_available: 0 }));

    await profilesService.upsertFreelancer(7, {
      fullName: 'Rafael',
      avatarUrl: 'https://img.escambo.test/r.png',
      bio: 'Desenvolvedor',
      headline: 'Dev Full Stack',
      city: 'Joinville',
      state: 'SC',
      latitude: 0,
      longitude: -48.84,
      isAvailable: false,
    });

    expect(repo.upsertFreelancer).toHaveBeenCalledWith(7, {
      fullName: 'Rafael',
      avatarUrl: 'https://img.escambo.test/r.png',
      bio: 'Desenvolvedor',
      headline: 'Dev Full Stack',
      city: 'Joinville',
      state: 'SC',
      // Zero é coordenada válida (linha do Equador), não "sem localização".
      latitude: 0,
      longitude: -48.84,
      isAvailable: false,
      availableDays: null,
      availablePeriods: null,
    });
  });

  it('a linha do banco vira o perfil da API: decimais em número, fuso da conta e o Escambo Score dos números dela', async () => {
    repo.findFreelancerByUserId.mockResolvedValue(
      freelancerRow({
        avatar_url: 'https://img.escambo.test/r.png',
        bio: 'Desenvolvedor',
        latitude: '-26.3044',
        longitude: '-48.8456',
        is_available: 0,
        available_days: [1, 3],
        available_periods: { '1': ['morning'] },
        response_time_hours: '2.50',
        timezone: 'America/Manaus',
      }),
    );

    const p = await profilesService.upsertFreelancer(7, { fullName: 'Rafael' });

    expect(p).toEqual({
      fullName: 'Rafael',
      avatarUrl: 'https://img.escambo.test/r.png',
      bio: 'Desenvolvedor',
      headline: 'Dev Full Stack',
      city: 'Joinville',
      state: 'SC',
      latitude: -26.3044,
      longitude: -48.8456,
      isAvailable: false,
      availableDays: [1, 3],
      availablePeriods: { '1': ['morning'] },
      // Pausado nunca "atende agora", seja qual for a hora em que o teste roda.
      availableNow: false,
      timezone: 'America/Manaus',
      responseTimeHours: 2.5,
      avgRating: 4.5,
      totalReviews: 10,
      totalContracts: 12,
      escamboScore: computeEscamboScore({
        avgRating: 4.5,
        totalReviews: 10,
        totalContracts: 12,
        responseTimeHours: 2.5,
      }),
    });
  });

  it('sem coordenadas, sem tempo de resposta e sem fuso escolhido: null, null e Brasília (ADR 46)', async () => {
    repo.findFreelancerByUserId.mockResolvedValue(
      freelancerRow({ latitude: null, longitude: null, response_time_hours: null, timezone: null }),
    );

    const p = await profilesService.upsertFreelancer(7, { fullName: 'Rafael' });

    expect(p.latitude).toBeNull();
    expect(p.longitude).toBeNull();
    expect(p.responseTimeHours).toBeNull();
    expect(p.timezone).toBe('America/Sao_Paulo');
    expect(p.availableDays).toBeNull();
    expect(p.availablePeriods).toBeNull();
    // Sem tempo de resposta conhecido, a responsividade fica neutra em vez de zerar a reputação.
    expect(p.escamboScore.breakdown.responsiveness).toBe(50);
  });
});

describe('parseDays (coluna available_days)', () => {
  it('aceita a lista já pronta ou o JSON em texto, e NULL continua null', () => {
    expect(parseDays([1, 3])).toEqual([1, 3]);
    expect(parseDays('[0,6]')).toEqual([0, 6]);
    expect(parseDays(null)).toBeNull();
    expect(parseDays(undefined)).toBeNull();
  });

  it('JSON que não é lista vira null, e o que não é dia inteiro sai da lista', () => {
    expect(parseDays('{"1":true}')).toBeNull();
    expect(parseDays('5')).toBeNull();
    expect(parseDays('[1,"2",2.5,null,4]')).toEqual([1, 4]);
  });
});

describe('profilesService.upsertClient', () => {
  const clientRow = {
    full_name: 'Ana Souza',
    avatar_url: null,
    bio: 'Dona de padaria',
    city: 'Joinville',
    state: 'SC',
  } as ClientRow;

  it('grava o perfil de cliente do usuário, com null no que ficou em branco, e devolve o que ficou gravado', async () => {
    repo.findClientByUserId.mockResolvedValue(clientRow);

    const p = await profilesService.upsertClient(8, {
      fullName: 'Ana Souza',
      bio: 'Dona de padaria',
    });

    expect(repo.upsertClient).toHaveBeenCalledTimes(1);
    expect(repo.upsertClient).toHaveBeenCalledWith(8, {
      fullName: 'Ana Souza',
      avatarUrl: null,
      bio: 'Dona de padaria',
      city: null,
      state: null,
    });
    expect(repo.findClientByUserId).toHaveBeenCalledWith(8);
    expect(p).toEqual({
      fullName: 'Ana Souza',
      avatarUrl: null,
      bio: 'Dona de padaria',
      city: 'Joinville',
      state: 'SC',
    });
    // Perfil de cliente não mexe no de freelancer.
    expect(repo.upsertFreelancer).not.toHaveBeenCalled();
  });

  it('só com o nome, todo o resto do perfil de cliente é gravado como null (regravar limpa o que saiu do formulário)', async () => {
    repo.findClientByUserId.mockResolvedValue(clientRow);

    await profilesService.upsertClient(8, { fullName: 'Ana Souza' });

    expect(repo.upsertClient).toHaveBeenCalledWith(8, {
      fullName: 'Ana Souza',
      avatarUrl: null,
      bio: null,
      city: null,
      state: null,
    });
  });

  it('os campos preenchidos chegam ao banco como vieram', async () => {
    repo.findClientByUserId.mockResolvedValue(clientRow);
    const input = {
      fullName: 'Ana Souza',
      avatarUrl: 'https://img.escambo.test/ana.png',
      bio: 'Dona de padaria',
      city: 'Joinville',
      state: 'SC',
    };

    await profilesService.upsertClient(8, input);

    expect(repo.upsertClient).toHaveBeenCalledWith(8, input);
  });
});

describe('profilesService.getMine', () => {
  it('quem ainda não criou perfil recebe os dois como null', async () => {
    repo.findFreelancerByUserId.mockResolvedValue(undefined);
    repo.findClientByUserId.mockResolvedValue(undefined);

    expect(await profilesService.getMine(7)).toEqual({ freelancer: null, client: null });

    expect(repo.findFreelancerByUserId).toHaveBeenCalledWith(7);
    expect(repo.findClientByUserId).toHaveBeenCalledWith(7);
  });

  it('traz os dois perfis do próprio usuário, cada um no formato da API', async () => {
    repo.findFreelancerByUserId.mockResolvedValue(freelancerRow({ is_available: 0 }));
    repo.findClientByUserId.mockResolvedValue({
      full_name: 'Rafael',
      avatar_url: null,
      bio: null,
      city: 'Joinville',
      state: 'SC',
    } as ClientRow);

    const mine = await profilesService.getMine(7);

    expect(mine.client).toEqual({
      fullName: 'Rafael',
      avatarUrl: null,
      bio: null,
      city: 'Joinville',
      state: 'SC',
    });
    expect(mine.freelancer).toMatchObject({
      fullName: 'Rafael',
      headline: 'Dev Full Stack',
      isAvailable: false,
      avgRating: 4.5,
      totalContracts: 12,
    });
  });

  it('só freelancer, ou só cliente: o outro perfil fica null', async () => {
    repo.findFreelancerByUserId
      .mockResolvedValueOnce(freelancerRow())
      .mockResolvedValueOnce(undefined);
    repo.findClientByUserId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ full_name: 'Ana Souza' } as ClientRow);

    const onlyFreelancer = await profilesService.getMine(7);
    expect(onlyFreelancer.client).toBeNull();
    expect(onlyFreelancer.freelancer?.fullName).toBe('Rafael');

    const onlyClient = await profilesService.getMine(8);
    expect(onlyClient.freelancer).toBeNull();
    expect(onlyClient.client?.fullName).toBe('Ana Souza');
  });
});

describe('profilesService.getPublicFreelancer: o que o perfil público mostra', () => {
  const ULID = '01HZXULIDEXAMPLE0000000000';

  it('procura pelo ulid, identifica o dono e traz o portfólio dele, no formato da API', async () => {
    repo.findPublicFreelancerByUlid.mockResolvedValue({
      ...freelancerRow(),
      user_id: 44,
      ulid: ULID,
      level: 3,
      level_name: 'Profissional',
    } as unknown as PublicFreelancerRow);
    repo.listPortfolio.mockResolvedValueOnce([
      {
        id: 5,
        title: 'Site da padaria',
        description: null,
        image_url: 'https://img.escambo.test/a.png',
        external_url: null,
        sort_order: 1,
      } as PortfolioRow,
    ]);

    const p = await profilesService.getPublicFreelancer(ULID);

    expect(repo.findPublicFreelancerByUlid).toHaveBeenCalledWith(ULID);
    // O portfólio é o do dono do perfil (id numérico da linha), não o de quem pediu.
    expect(repo.listPortfolio).toHaveBeenCalledWith(44);
    expect(p).toMatchObject({
      userId: 44,
      userUlid: ULID,
      level: 3,
      levelName: 'Profissional',
      fullName: 'Rafael',
      portfolio: [
        {
          id: 5,
          title: 'Site da padaria',
          description: null,
          imageUrl: 'https://img.escambo.test/a.png',
          externalUrl: null,
          sortOrder: 1,
        },
      ],
    });
  });

  it('perfil que não existe é 404 profile_not_found, e o portfólio nem é consultado', async () => {
    repo.findPublicFreelancerByUlid.mockResolvedValue(undefined);

    await expect(profilesService.getPublicFreelancer(ULID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'profile_not_found',
      message: 'Perfil não encontrado',
    });
    expect(repo.listPortfolio).not.toHaveBeenCalled();
  });
});

describe('availableNow no perfil (ADR 34 e 48): a agenda vale no relógio do freelancer', () => {
  // 2026-09-14 é segunda-feira. 09:30 UTC = 06:30 em Brasília (manhã) e 05:30 em Manaus (madrugada).
  const MONDAY_EARLY = new Date('2026-09-14T09:30:00Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: MONDAY_EARLY });
    repo.findClientByUserId.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  const availableNow = async (o: Partial<Record<keyof FreelancerRow, unknown>>) => {
    repo.findFreelancerByUserId.mockResolvedValueOnce(
      freelancerRow({ is_available: 1, available_days: [1], available_periods: null, ...o }),
    );
    return (await profilesService.getMine(7)).freelancer!.availableNow;
  };

  it('aceitando pedidos, num dia marcado e em horário de atendimento, o perfil diz que atende agora', async () => {
    expect(await availableNow({ timezone: null })).toBe(true);
    // A coluna em texto (driver antigo) vale igual à lista pronta.
    expect(await availableNow({ available_days: '[1]' })).toBe(true);
  });

  it('o relógio é o do fuso da conta: a mesma agenda, na mesma hora, é madrugada em Manaus', async () => {
    expect(await availableNow({ timezone: 'America/Manaus' })).toBe(false);
    expect(await availableNow({ timezone: 'America/Sao_Paulo' })).toBe(true);
  });

  it('fora dos dias marcados, fora do período do dia ou pausado, não atende agora', async () => {
    expect(await availableNow({ available_days: [2, 3] })).toBe(false);
    expect(await availableNow({ available_days: null })).toBe(false);
    expect(await availableNow({ available_periods: { '1': ['evening'] } })).toBe(false);
    expect(await availableNow({ available_periods: { '1': ['morning'] } })).toBe(true);
    // Período de outro dia não restringe a segunda.
    expect(await availableNow({ available_periods: { '2': ['evening'] } })).toBe(true);
    expect(await availableNow({ is_available: 0 })).toBe(false);
  });

  it('o perfil público usa a mesma conta: atende agora pelo fuso do dono, não de quem visita', async () => {
    const row = (timezone: string | null): PublicFreelancerRow =>
      ({
        ...freelancerRow({ available_days: [1], timezone }),
        user_id: 44,
        ulid: '01HZXULIDEXAMPLE0000000000',
        level: 1,
        level_name: 'Iniciante',
      }) as unknown as PublicFreelancerRow;
    repo.findPublicFreelancerByUlid
      .mockResolvedValueOnce(row(null))
      .mockResolvedValueOnce(row('America/Manaus'));

    const brasilia = await profilesService.getPublicFreelancer('01HZXULIDEXAMPLE0000000000');
    const manaus = await profilesService.getPublicFreelancer('01HZXULIDEXAMPLE0000000000');

    expect(brasilia.availableNow).toBe(true);
    expect(brasilia.timezone).toBe('America/Sao_Paulo');
    expect(manaus.availableNow).toBe(false);
    expect(manaus.timezone).toBe('America/Manaus');
  });
});

describe('Escambo Score no perfil: sai dos números da própria linha', () => {
  it('nota, avaliações, contratos e tempo de resposta da linha entram cada um na sua dimensão', async () => {
    repo.findFreelancerByUserId.mockResolvedValue(
      freelancerRow({
        avg_rating: '4.00',
        total_reviews: 5,
        total_contracts: 10,
        response_time_hours: '1.00',
      }),
    );

    const p = await profilesService.upsertFreelancer(7, { fullName: 'Rafael' });

    // Nota 4 de 5 = 80; 10 de 20 contratos = 50; 5 de 10 avaliações = 50; resposta em até 1h = 100.
    expect(p.escamboScore.breakdown).toEqual({
      quality: 80,
      experience: 50,
      socialProof: 50,
      responsiveness: 100,
    });
  });
});
