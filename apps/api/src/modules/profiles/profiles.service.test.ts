import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./profiles.repository', () => ({
  profilesRepository: {
    upsertFreelancer: vi.fn(),
    upsertClient: vi.fn(),
    findFreelancerByUserId: vi.fn(),
    findClientByUserId: vi.fn(),
    findPublicFreelancerByUlid: vi.fn(),
  },
}));

import { profilesService } from './profiles.service';
import {
  profilesRepository,
  type FreelancerRow,
  type PublicFreelancerRow,
} from './profiles.repository';

const repo = vi.mocked(profilesRepository);

const freelancerRow = (o: Partial<FreelancerRow> = {}): FreelancerRow =>
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

    expect(repo.upsertFreelancer).toHaveBeenCalledWith(1, expect.objectContaining({ fullName: 'Rafael', isAvailable: true }));
    expect(p.isAvailable).toBe(true);
    expect(p.avgRating).toBe(4.5);
    expect(p.totalReviews).toBe(10);
  });
});

describe('profilesService.getPublicFreelancer', () => {
  it('404 quando não existe', async () => {
    repo.findPublicFreelancerByUlid.mockResolvedValue(undefined);
    await expect(profilesService.getPublicFreelancer('01ABC')).rejects.toMatchObject({ statusCode: 404 });
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
  });
});
