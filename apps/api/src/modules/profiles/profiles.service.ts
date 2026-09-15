import type {
  ClientProfile,
  FreelancerProfile,
  MyProfiles,
  PortfolioItem,
  PublicFreelancerProfile,
} from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { computeEscamboScore } from '../score/score.service';
import {
  profilesRepository,
  type ClientRow,
  type FreelancerRow,
  type PortfolioRow,
  type PublicFreelancerRow,
} from './profiles.repository';
import {
  PORTFOLIO_MAX_ITEMS,
  type PortfolioItemInput,
  type UpsertClientInput,
  type UpsertFreelancerInput,
} from './profiles.schema';
import { isAvailableNow, normalizePeriods, parsePeriods } from './availability';

/** available_days chega como array (mysql2 parseia JSON) ou string; qualquer outra coisa vira null. */
/** JSON da coluna available_days (array, string ou NULL) → lista de dias 0–6. */
export function parseDays(v: number[] | string | null | undefined): number[] | null {
  if (v == null) return null;
  const arr = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(arr) ? arr.filter((d): d is number => Number.isInteger(d)) : null;
}

/** Dias sem repetição, em ordem (domingo primeiro), prontos para a coluna JSON. */
export const normalizeDays = (days: number[] | null | undefined): string | null =>
  days ? JSON.stringify([...new Set(days)].sort((a, b) => a - b)) : null;

function toPortfolioItem(r: PortfolioRow): PortfolioItem {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    imageUrl: r.image_url,
    externalUrl: r.external_url,
    sortOrder: r.sort_order,
  };
}

function toFreelancer(r: FreelancerRow): FreelancerProfile {
  return {
    fullName: r.full_name,
    avatarUrl: r.avatar_url,
    bio: r.bio,
    headline: r.headline,
    city: r.city,
    state: r.state,
    latitude: r.latitude != null ? Number(r.latitude) : null,
    longitude: r.longitude != null ? Number(r.longitude) : null,
    isAvailable: Boolean(r.is_available),
    availableDays: parseDays(r.available_days),
    availablePeriods: parsePeriods(r.available_periods),
    availableNow: isAvailableNow({
      isAvailable: Boolean(r.is_available),
      availableDays: parseDays(r.available_days),
      availablePeriods: parsePeriods(r.available_periods),
    }),
    responseTimeHours: r.response_time_hours != null ? Number(r.response_time_hours) : null,
    avgRating: Number(r.avg_rating),
    totalReviews: r.total_reviews,
    totalContracts: r.total_contracts,
    escamboScore: computeEscamboScore({
      avgRating: Number(r.avg_rating),
      totalReviews: r.total_reviews,
      totalContracts: r.total_contracts,
      responseTimeHours: r.response_time_hours != null ? Number(r.response_time_hours) : null,
    }),
  };
}

function toClient(r: ClientRow): ClientProfile {
  return {
    fullName: r.full_name,
    avatarUrl: r.avatar_url,
    bio: r.bio,
    city: r.city,
    state: r.state,
  };
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
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      isAvailable: input.isAvailable ?? true,
      availableDays: normalizeDays(input.availableDays),
      availablePeriods: normalizePeriods(input.availableDays, input.availablePeriods),
    });
    return toFreelancer((await profilesRepository.findFreelancerByUserId(userId))!);
  },

  // ---------- Portfólio ----------

  async listMyPortfolio(userId: number): Promise<PortfolioItem[]> {
    return (await profilesRepository.listPortfolio(userId)).map(toPortfolioItem);
  },

  async addPortfolioItem(userId: number, input: PortfolioItemInput): Promise<PortfolioItem[]> {
    if ((await profilesRepository.countPortfolio(userId)) >= PORTFOLIO_MAX_ITEMS) {
      throw new HttpError(
        409,
        `O portfólio tem no máximo ${PORTFOLIO_MAX_ITEMS} itens`,
        'portfolio_full',
      );
    }
    const id = await profilesRepository.createPortfolioItem(userId, {
      title: input.title,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      externalUrl: input.externalUrl ?? null,
    });
    if (id === null) {
      throw new HttpError(
        409,
        'Crie seu perfil de freelancer antes do portfólio',
        'no_freelancer_profile',
      );
    }
    return this.listMyPortfolio(userId);
  },

  async updatePortfolioItem(
    userId: number,
    id: number,
    input: PortfolioItemInput,
  ): Promise<PortfolioItem[]> {
    const ok = await profilesRepository.updatePortfolioItem(userId, id, {
      title: input.title,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      externalUrl: input.externalUrl ?? null,
    });
    if (!ok)
      throw new HttpError(404, 'Item do portfólio não encontrado', 'portfolio_item_not_found');
    return this.listMyPortfolio(userId);
  },

  async removePortfolioItem(userId: number, id: number): Promise<PortfolioItem[]> {
    const ok = await profilesRepository.deletePortfolioItem(userId, id);
    if (!ok)
      throw new HttpError(404, 'Item do portfólio não encontrado', 'portfolio_item_not_found');
    return this.listMyPortfolio(userId);
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
    const r: PublicFreelancerRow | undefined =
      await profilesRepository.findPublicFreelancerByUlid(ulid);
    if (!r) throw new HttpError(404, 'Perfil não encontrado', 'profile_not_found');
    return {
      ...toFreelancer(r),
      userId: r.user_id,
      userUlid: r.ulid,
      level: r.level,
      levelName: r.level_name,
      portfolio: (await profilesRepository.listPortfolio(r.user_id)).map(toPortfolioItem),
    };
  },
};
