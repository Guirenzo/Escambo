import type {
  ClientProfile,
  FreelancerProfile,
  MyProfiles,
  PublicFreelancerProfile,
} from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import {
  profilesRepository,
  type ClientRow,
  type FreelancerRow,
  type PublicFreelancerRow,
} from './profiles.repository';
import type { UpsertClientInput, UpsertFreelancerInput } from './profiles.schema';

function toFreelancer(r: FreelancerRow): FreelancerProfile {
  return {
    fullName: r.full_name,
    avatarUrl: r.avatar_url,
    bio: r.bio,
    headline: r.headline,
    city: r.city,
    state: r.state,
    isAvailable: Boolean(r.is_available),
    avgRating: Number(r.avg_rating),
    totalReviews: r.total_reviews,
    totalContracts: r.total_contracts,
  };
}

function toClient(r: ClientRow): ClientProfile {
  return { fullName: r.full_name, avatarUrl: r.avatar_url, bio: r.bio, city: r.city, state: r.state };
}

export const profilesService = {
  async upsertFreelancer(userId: number, input: UpsertFreelancerInput): Promise<FreelancerProfile> {
    await profilesRepository.upsertFreelancer(userId, {
      fullName: input.fullName,
      avatarUrl: input.avatarUrl ?? null,
      bio: input.bio ?? null,
      headline: input.headline ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      isAvailable: input.isAvailable ?? true,
    });
    return toFreelancer((await profilesRepository.findFreelancerByUserId(userId))!);
  },

  async upsertClient(userId: number, input: UpsertClientInput): Promise<ClientProfile> {
    await profilesRepository.upsertClient(userId, {
      fullName: input.fullName,
      avatarUrl: input.avatarUrl ?? null,
      bio: input.bio ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
    });
    return toClient((await profilesRepository.findClientByUserId(userId))!);
  },

  async getMine(userId: number): Promise<MyProfiles> {
    const [f, c] = await Promise.all([
      profilesRepository.findFreelancerByUserId(userId),
      profilesRepository.findClientByUserId(userId),
    ]);
    return { freelancer: f ? toFreelancer(f) : null, client: c ? toClient(c) : null };
  },

  async getPublicFreelancer(ulid: string): Promise<PublicFreelancerProfile> {
    const r: PublicFreelancerRow | undefined = await profilesRepository.findPublicFreelancerByUlid(ulid);
    if (!r) throw new HttpError(404, 'Perfil não encontrado', 'profile_not_found');
    return { ...toFreelancer(r), userUlid: r.ulid, level: r.level, levelName: r.level_name };
  },
};
