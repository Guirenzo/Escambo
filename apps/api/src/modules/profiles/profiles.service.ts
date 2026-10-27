import type {
  Badge,
  ClientProfile,
  CompanyProfile,
  FreelancerProfile,
  MyProfiles,
  PortfolioItem,
  PublicCompanyProfile,
  PublicFreelancerProfile,
} from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { userAgentOf } from '../../utils/user-agent';
import { auditService } from '../audit/audit.service';
import type { RequestContext } from '../auth/auth.service';
import { computeEscamboScore } from '../score/score.service';
import {
  profilesRepository,
  type ClientRow,
  type CompanyRow,
  type FreelancerRow,
  type PortfolioRow,
  type PublicFreelancerRow,
} from './profiles.repository';
import {
  PORTFOLIO_MAX_ITEMS,
  type PortfolioItemInput,
  type UpsertClientInput,
  type UpsertCompanyInput,
  type UpsertFreelancerInput,
} from './profiles.schema';
import { isAvailableNow, normalizePeriods, parsePeriods } from './availability';
import { timezoneOf } from '../../utils/timezone';
import { coarseCoord } from '../../utils/coarse-coord';
import { dropoutsService } from '../dropouts/dropouts.service';

/** available_days chega como array (mysql2 parseia JSON) ou string; qualquer outra coisa vira null. */
/** JSON da coluna available_days (array, string ou NULL) → lista de dias 0–6. */
export function parseDays(v: number[] | string | null | undefined): number[] | null {
  if (v == null) return null;
  let arr: unknown = v;
  if (typeof v === 'string') {
    // Texto que não é JSON (dado corrompido) vira "sem dias", como em parsePeriods: o perfil abre.
    try {
      arr = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return Array.isArray(arr) ? arr.filter((d): d is number => Number.isInteger(d)) : null;
}

/** Quantas badges ficam em destaque no perfil público (RN-058); as demais vão em "Conquistas". */
export const FEATURED_BADGES_MAX = 3;

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
      timezone: r.timezone,
    }),
    timezone: timezoneOf(r.timezone),
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

/** company_name é a razão social; o nome fantasia cai nela se faltar (linha anterior à 1.53.0). */
function toCompany(r: CompanyRow): CompanyProfile {
  return {
    legalName: r.company_name,
    tradeName: r.trade_name ?? r.company_name,
    cnpj: r.cnpj ?? '',
    logoUrl: r.logo_url,
    bio: r.bio,
    website: r.website,
    city: r.city,
    state: r.state,
  };
}

const cnpjTaken = (): HttpError =>
  new HttpError(409, 'Este CNPJ já está em outra conta do Escambo.', 'cnpj_taken');

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

  /**
   * Reordena o portfólio (ADR 43). A lista precisa ter exatamente os trabalhos de agora: se algum
   * entrou ou saiu no meio do caminho (outra aba), recusa em vez de adivinhar a posição.
   */
  async reorderPortfolio(userId: number, ids: number[]): Promise<PortfolioItem[]> {
    const current = await profilesRepository.listPortfolio(userId);
    const known = new Set(current.map((r) => r.id));
    if (ids.length !== current.length || !ids.every((id) => known.has(id))) {
      throw new HttpError(
        409,
        'O portfólio mudou enquanto você reordenava; recarregue e tente de novo',
        'portfolio_order_mismatch',
      );
    }
    await profilesRepository.reorderPortfolio(userId, ids);
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
    const [f, c, co] = await Promise.all([
      profilesRepository.findFreelancerByUserId(userId),
      profilesRepository.findClientByUserId(userId),
      profilesRepository.findCompanyByUserId(userId),
    ]);
    return {
      freelancer: f ? toFreelancer(f) : null,
      client: c ? toClient(c) : null,
      company: co ? toCompany(co) : null,
    };
  },

  /**
   * Dados da empresa (RF-018), só de conta de empresa: a razão social, o nome fantasia e o CNPJ
   * continuam obrigatórios; logo, site, descrição curta e cidade são do Perfil. O CNPJ é dado
   * público, mas a troca dele fica na auditoria (de qual para qual).
   */
  async upsertCompany(
    userId: number,
    role: string,
    input: UpsertCompanyInput,
    ctx: RequestContext,
  ): Promise<CompanyProfile> {
    if (role !== 'company') {
      throw new HttpError(403, 'Só contas de empresa têm dados de empresa.', 'not_company');
    }
    const before = await profilesRepository.findCompanyByUserId(userId);
    if (await profilesRepository.cnpjTaken(input.cnpj, userId)) throw cnpjTaken();
    try {
      await profilesRepository.upsertCompany(userId, {
        legalName: input.legalName,
        tradeName: input.tradeName,
        cnpj: input.cnpj,
        logoUrl: input.logoUrl ?? null,
        bio: input.bio ?? null,
        website: input.website ?? null,
        city: input.city ?? null,
        state: input.state ? input.state.toUpperCase() : null,
      });
    } catch (err) {
      // Outra conta gravou o mesmo CNPJ entre a conferência e o UPDATE.
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw cnpjTaken();
      throw err;
    }
    if ((before?.cnpj ?? null) !== input.cnpj) {
      void auditService.log({
        userId,
        action: 'company_cnpj_changed',
        entityType: 'user',
        entityId: userId,
        oldValue: { cnpj: before?.cnpj ?? null },
        newValue: { cnpj: input.cnpj },
        ip: ctx.ip,
        userAgent: userAgentOf(ctx.userAgent),
      });
    }
    return toCompany((await profilesRepository.findCompanyByUserId(userId))!);
  },

  /** A página pública da empresa (RF-018): o CNPJ é dado público e aparece inteiro. */
  async getPublicCompany(ulid: string): Promise<PublicCompanyProfile> {
    const r = await profilesRepository.findPublicCompanyByUlid(ulid);
    if (!r) throw new HttpError(404, 'Empresa não encontrada', 'company_not_found');
    return {
      ...toCompany(r),
      userUlid: r.ulid,
      memberSince: new Date(r.created_at).toISOString(),
    };
  },

  /** Para o atendimento: o nome fantasia e o CNPJ da conta de empresa; null nas outras. */
  async companySummary(userId: number): Promise<{ tradeName: string; cnpj: string } | null> {
    const r = await profilesRepository.findCompanyByUserId(userId);
    if (!r) return null;
    const c = toCompany(r);
    return { tradeName: c.tradeName, cnpj: c.cnpj };
  },

  /**
   * Perfil público. `viewerId` é quem abre (token opcional, que não dá acesso a nada): o próprio
   * dono vê a localização exata, como no /me; qualquer outra pessoa, ou quem não está logado, vê
   * latitude e longitude arredondadas para ~1 km (coarseCoord). A busca e o ranking seguem
   * calculando a distância no banco com o valor exato.
   */
  async getPublicFreelancer(ulid: string, viewerId?: number): Promise<PublicFreelancerProfile> {
    const r: PublicFreelancerRow | undefined =
      await profilesRepository.findPublicFreelancerByUlid(ulid);
    if (!r) throw new HttpError(404, 'Perfil não encontrado', 'profile_not_found');
    const profile = toFreelancer(r);
    const isOwner = viewerId !== undefined && viewerId === r.user_id;
    const [portfolio, summary, badgeRows] = await Promise.all([
      profilesRepository.listPortfolio(r.user_id),
      dropoutsService.publicSummary(r.user_id),
      profilesRepository.listBadges(r.user_id),
    ]);
    const badges: Badge[] = badgeRows.map((b) => ({
      slug: b.slug,
      name: b.name,
      awardedAt: new Date(b.awarded_at).toISOString(),
    }));
    return {
      ...profile,
      ...(isOwner
        ? {}
        : { latitude: coarseCoord(profile.latitude), longitude: coarseCoord(profile.longitude) }),
      userId: r.user_id,
      userUlid: r.ulid,
      level: r.level,
      levelName: r.level_name,
      totalXp: Number(r.total_xp ?? 0),
      badges,
      // RN-058: ainda não há escolha do freelancer; ficam em destaque as mais recentes.
      featuredBadges: badges.slice(0, FEATURED_BADGES_MAX),
      portfolio: portfolio.map(toPortfolioItem),
      // O perfil público nunca recebe a lista, as datas ou os textos privados da contestação.
      dropouts: { count: summary.count, windowDays: 60, alert: summary.alert },
    };
  },
};
