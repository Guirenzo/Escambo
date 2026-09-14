import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./profiles.repository', () => ({
  profilesRepository: {
    upsertFreelancer: vi.fn(),
    findFreelancerByUserId: vi.fn(),
    listPortfolio: vi.fn(),
    countPortfolio: vi.fn(),
    createPortfolioItem: vi.fn(),
    updatePortfolioItem: vi.fn(),
    deletePortfolioItem: vi.fn(),
  },
}));

import { profilesRepository, type FreelancerRow, type PortfolioRow } from './profiles.repository';
import { normalizeDays, profilesService } from './profiles.service';

const repo = vi.mocked(profilesRepository);

const freelancerRow = (o: Partial<Record<string, unknown>> = {}): FreelancerRow =>
  ({
    full_name: 'Bruno Costa',
    avatar_url: null,
    bio: null,
    headline: null,
    city: 'Joinville',
    state: 'SC',
    latitude: null,
    longitude: null,
    is_available: 1,
    available_days: [1, 2, 3],
    avg_rating: '4.50',
    total_reviews: 2,
    total_contracts: 3,
    response_time_hours: '1.75',
    ...o,
  }) as unknown as FreelancerRow;

const item = (id: number): PortfolioRow =>
  ({
    id,
    title: `Trabalho ${id}`,
    description: null,
    image_url: 'https://img.escambo.test/a.png',
    external_url: null,
    sort_order: id,
  }) as PortfolioRow;

beforeEach(() => vi.clearAllMocks());

describe('dias de atendimento e tempo de resposta no perfil', () => {
  it('normaliza os dias (sem repetição, em ordem) e devolve JSON ou null', () => {
    expect(normalizeDays([5, 1, 1, 3])).toBe('[1,3,5]');
    expect(normalizeDays(null)).toBeNull();
    expect(normalizeDays(undefined)).toBeNull();
  });

  it('mapeia available_days (array ou string) e response_time_hours para o DTO', async () => {
    repo.findFreelancerByUserId.mockResolvedValueOnce(freelancerRow());
    const a = await profilesService.upsertFreelancer(7, {
      fullName: 'Bruno Costa',
      availableDays: [3, 1, 2],
    });
    expect(repo.upsertFreelancer).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ availableDays: '[1,2,3]' }),
    );
    expect(a.availableDays).toEqual([1, 2, 3]);
    expect(a.responseTimeHours).toBe(1.75);

    repo.findFreelancerByUserId.mockResolvedValueOnce(
      freelancerRow({ available_days: '[0,6]', response_time_hours: null }),
    );
    const b = await profilesService.upsertFreelancer(7, { fullName: 'Bruno Costa' });
    expect(b.availableDays).toEqual([0, 6]);
    expect(b.responseTimeHours).toBeNull();
    expect(repo.upsertFreelancer).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ availableDays: null }),
    );
  });
});

describe('portfólio', () => {
  it('adiciona até o limite; sem perfil de freelancer é 409', async () => {
    repo.countPortfolio.mockResolvedValue(2);
    repo.createPortfolioItem.mockResolvedValue(10);
    repo.listPortfolio.mockResolvedValue([item(1), item(10)]);
    const list = await profilesService.addPortfolioItem(7, {
      title: 'Site da padaria',
      imageUrl: 'https://img.escambo.test/a.png',
    });
    expect(repo.createPortfolioItem).toHaveBeenCalledWith(7, {
      title: 'Site da padaria',
      description: null,
      imageUrl: 'https://img.escambo.test/a.png',
      externalUrl: null,
    });
    expect(list.map((i) => i.id)).toEqual([1, 10]);

    repo.countPortfolio.mockResolvedValue(12);
    await expect(
      profilesService.addPortfolioItem(7, { title: 'Mais um', externalUrl: 'https://x.test' }),
    ).rejects.toMatchObject({ code: 'portfolio_full' });

    repo.countPortfolio.mockResolvedValue(0);
    repo.createPortfolioItem.mockResolvedValue(null);
    await expect(
      profilesService.addPortfolioItem(7, { title: 'Sem perfil', externalUrl: 'https://x.test' }),
    ).rejects.toMatchObject({ code: 'no_freelancer_profile' });
  });

  it('editar e remover item de outro (ou inexistente) é 404', async () => {
    repo.updatePortfolioItem.mockResolvedValue(false);
    repo.deletePortfolioItem.mockResolvedValue(false);
    await expect(
      profilesService.updatePortfolioItem(7, 99, {
        title: 'Novo título',
        externalUrl: 'https://x.test',
      }),
    ).rejects.toMatchObject({ code: 'portfolio_item_not_found' });
    await expect(profilesService.removePortfolioItem(7, 99)).rejects.toMatchObject({
      code: 'portfolio_item_not_found',
    });
  });
});
