import type {
  Paginated,
  Service,
  ServiceModality,
  ServicePackage,
  ServicePriceType,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { servicesRepository, type ServiceRow } from './services.repository';
import type { CreateServiceInput, ListServicesInput, UpdateServiceInput } from './services.schema';
import { parseDays } from '../profiles/profiles.service';
import { settingsService } from '../settings/settings.service';
import { isAvailableNow, parsePeriods, slotsByZone } from '../profiles/availability';
import { timezoneOf } from '../../utils/timezone';
import { serviceViews, viewKey, type Viewer } from './service-views';
import {
  derivePackageListing,
  MIN_CONTRACT_PRICE,
  PACKAGE_TIER_LABEL,
  PACKAGE_TIERS,
} from './service-packages';

/**
 * Modalidade (RF-023) a partir das duas colunas: is_remote = atende remoto, is_onsite = atende
 * presencial. Sem is_onsite na linha (montada à mão), vale o DEFAULT da coluna: o inverso de
 * is_remote. Nenhum dos dois (só gravando direto no banco) conta como presencial.
 */
export function modalityOf(row: Pick<ServiceRow, 'is_remote' | 'is_onsite'>): ServiceModality {
  const remote = Number(row.is_remote) === 1;
  const onsite = row.is_onsite == null ? !remote : Number(row.is_onsite) === 1;
  if (remote && onsite) return 'both';
  return remote ? 'remote' : 'onsite';
}

/** As duas colunas de cada modalidade. */
export function modalityColumns(modality: ServiceModality): {
  isRemote: boolean;
  isOnsite: boolean;
} {
  return { isRemote: modality !== 'onsite', isOnsite: modality !== 'remote' };
}

/** A modalidade pedida: modality, se veio; senão o isRemote antigo (true remoto, false presencial). */
function requestedModality(input: {
  modality?: ServiceModality;
  isRemote?: boolean;
}): ServiceModality | undefined {
  if (input.modality) return input.modality;
  if (input.isRemote === undefined) return undefined;
  return input.isRemote ? 'remote' : 'onsite';
}

function toService(row: ServiceRow, tags: string[] = [], packages: ServicePackage[] = []): Service {
  return {
    id: row.id,
    categoryId: row.category_id,
    ownerId: row.user_id,
    title: row.title,
    description: row.description,
    priceType: row.price_type as ServicePriceType,
    price: row.price == null ? null : Number(row.price),
    deliveryDays: row.delivery_days,
    isRemote: Boolean(row.is_remote),
    modality: modalityOf(row),
    tags,
    packages,
    isActive: Boolean(row.is_active),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    // Distância com 1 casa. O banco já a calcula sobre a coordenada do prestador arredondada a ~1 km
    // (utils/coarse-coord, também no raio e na ordem): nem a distância nem o corte do raio, mesmo
    // com o ponto da busca mexido aos poucos, chegam mais perto da casa dele que o perfil público.
    ...(row.distance_km != null
      ? { distanceKm: Math.round(Number(row.distance_km) * 10) / 10 }
      : {}),
    ...(row.boosted != null ? { boosted: Boolean(Number(row.boosted)) } : {}),
    ...(row.owner_name !== undefined
      ? {
          ownerUlid: row.owner_ulid ?? undefined,
          ownerName: row.owner_name,
          ownerAvatarUrl: row.owner_avatar_url ?? null,
          ownerRating: Number(row.owner_avg_rating ?? 0),
          ownerReviews: Number(row.owner_total_reviews ?? 0),
          ownerAvailableDays: parseDays(row.owner_available_days),
          ownerAvailablePeriods: parsePeriods(row.owner_available_periods),
          ownerAvailableNow: isAvailableNow({
            isAvailable: Number(row.owner_is_available ?? 0) === 1,
            availableDays: parseDays(row.owner_available_days),
            availablePeriods: parsePeriods(row.owner_available_periods),
            timezone: row.owner_timezone,
          }),
          ownerTimezone: timezoneOf(row.owner_timezone),
          // Ausentes só em linha montada à mão (testes): aí ficam fora do objeto.
          ownerCity: row.owner_city,
          ownerCoverUrl: row.owner_cover_url,
        }
      : {}),
  };
}

/** RN-016: preço fixo abaixo do mínimo vigente (platform_settings.min_service_price) é recusado. */
async function assertMinPrice(priceType: string, price: number | null | undefined): Promise<void> {
  if (priceType !== 'fixed' || price == null) return;
  const min = await settingsService.minServicePrice();
  if (price < min) {
    throw new HttpError(
      422,
      `Preço mínimo é R$ ${min.toFixed(2).replace('.', ',')} (RN-016)`,
      'price_below_minimum',
    );
  }
}

const brl = (value: number): string => `R$ ${value.toFixed(2).replace('.', ',')}`;

/**
 * RN-068 com RN-016 e RN-027: cada pacote custa pelo menos o maior entre o mínimo do serviço
 * (painel) e o da contratação (R$ 10,00), e o preço não desce do Básico ao Premium.
 */
async function assertPackagePrices(packages: readonly ServicePackage[]): Promise<void> {
  const min = Math.max(MIN_CONTRACT_PRICE, await settingsService.minServicePrice());
  for (const pkg of packages) {
    if (pkg.price < min) {
      throw new HttpError(
        422,
        `O pacote ${PACKAGE_TIER_LABEL[pkg.tier]} custa menos que o mínimo de ${brl(min)} (RN-016)`,
        'price_below_minimum',
      );
    }
  }
  const ordered = [...packages].sort(
    (a, b) => PACKAGE_TIERS.indexOf(a.tier) - PACKAGE_TIERS.indexOf(b.tier),
  );
  for (let i = 1; i < ordered.length; i++) {
    const lower = ordered[i - 1]!;
    const pkg = ordered[i]!;
    if (Math.round(pkg.price * 100) < Math.round(lower.price * 100)) {
      throw new HttpError(
        422,
        `O preço sobe do Básico ao Premium: o ${PACKAGE_TIER_LABEL[pkg.tier]} não pode custar menos que o ${PACKAGE_TIER_LABEL[lower.tier]} (RN-068)`,
        'package_price_order',
      );
    }
  }
}

/** Pacote só existe no preço fixo (ADR 69): por hora ou a combinar não tem preço de nível. */
function assertPackagesFixed(priceType: string): void {
  if (priceType !== 'fixed') {
    throw new HttpError(
      422,
      'Pacotes só no preço fixo: mude o tipo de preço ou tire os pacotes',
      'packages_require_fixed_price',
    );
  }
}

/** Com pacotes, o preço e o prazo do anúncio são os do Básico: mandar outro junto é 422. */
function assertNoListingWithPackages(input: {
  price?: number | null;
  deliveryDays?: number | null;
}): void {
  if (input.price != null || input.deliveryDays != null) {
    throw new HttpError(
      422,
      'Com pacotes, o preço e o prazo do serviço são os do Básico: não envie price nem deliveryDays',
      'price_from_packages',
    );
  }
}

/** Só se publica em categoria que existe e está ativa (a inexistente estouraria a FK em 500). */
async function assertCategory(categoryId: number): Promise<void> {
  if (!(await servicesRepository.categoryIsActive(categoryId))) {
    throw new HttpError(422, 'Categoria inexistente ou inativa', 'invalid_category');
  }
}

/**
 * As linhas com as tags e os pacotes de cada uma: uma consulta para as tags e outra para os
 * pacotes, da página inteira (RF-024, RF-086; nunca uma consulta por card).
 */
async function withTags(
  rows: ServiceRow[],
): Promise<Array<{ row: ServiceRow; tags: string[]; packages: ServicePackage[] }>> {
  const ids = rows.map((r) => r.id);
  const [tags, packages] = await Promise.all([
    servicesRepository.tagsByServiceIds(ids),
    servicesRepository.packagesByServiceIds(ids),
  ]);
  return rows.map((row) => ({
    row,
    tags: tags.get(row.id) ?? [],
    packages: packages.get(row.id) ?? [],
  }));
}

/** Um serviço com as tags e os pacotes dele, como a API devolve. */
async function serviceWithTags(row: ServiceRow): Promise<Service> {
  const [item] = await withTags([row]);
  return toService(item!.row, item!.tags, item!.packages);
}

/**
 * RF-029: quem abre o detalhe e não é o dono soma uma visualização, uma vez a cada 30 min por
 * visitante (service-views.ts). A falha ao gravar não derruba o detalhe: o número é estatística.
 */
async function countView(row: ServiceRow, viewer: Viewer): Promise<void> {
  if (viewer.userId === row.user_id) return;
  if (!serviceViews.shouldCount(viewKey(row.id, viewer))) return;
  try {
    await servicesRepository.incrementViews(row.id);
  } catch (err) {
    logger.warn({ err, serviceId: row.id }, 'visualização do serviço não foi contada');
  }
}

export const servicesService = {
  async create(ownerId: number, input: CreateServiceInput): Promise<Service> {
    const packages = input.packages ?? [];
    // RF-086: com pacotes, preço fixo, e o preço e o prazo do anúncio são os do Básico.
    if (packages.length > 0) {
      assertPackagesFixed(input.priceType);
      assertNoListingWithPackages(input);
      await assertPackagePrices(packages);
    }
    const listing =
      packages.length > 0
        ? derivePackageListing(packages)
        : { price: input.price ?? null, deliveryDays: input.deliveryDays ?? null };
    await assertMinPrice(input.priceType, listing.price);
    await assertCategory(input.categoryId);
    const id = await servicesRepository.create({
      userId: ownerId,
      categoryId: input.categoryId,
      title: input.title,
      description: input.description,
      priceType: input.priceType,
      price: listing.price,
      deliveryDays: listing.deliveryDays,
      ...modalityColumns(requestedModality(input) ?? 'onsite'),
      tags: input.tags ?? [],
      packages,
    });
    const row = await servicesRepository.findById(id);
    if (!row) throw new HttpError(500, 'Falha ao criar serviço', 'create_failed');
    return serviceWithTags(row);
  },

  async list(input: ListServicesInput): Promise<Paginated<Service>> {
    if (input.period && input.day === undefined) {
      throw new HttpError(422, 'Escolha o dia para filtrar por período', 'period_requires_day');
    }
    const rows = await servicesRepository.list({
      categoryId: input.categoryId,
      ownerId: input.ownerId,
      q: input.q,
      isRemote: input.isRemote,
      lat: input.lat,
      lng: input.lng,
      radiusKm: input.radiusKm,
      minPrice: input.minPrice,
      maxPrice: input.maxPrice,
      maxDeliveryDays: input.maxDeliveryDays,
      minRating: input.minRating,
      day: input.day,
      period: input.period,
      now: input.now ? slotsByZone() : undefined,
      sort: input.sort,
      limit: input.limit,
      offset: (input.page - 1) * input.limit,
    });
    const items = (await withTags(rows)).map(({ row, tags, packages }) =>
      toService(row, tags, packages),
    );
    return { items, page: input.page, limit: input.limit };
  },

  /**
   * "Meus serviços" (RF-030): os do dono, pausados inclusive, para ele pausar e reativar. Só aqui
   * sai o número de visualizações (RF-029): é do dono, não da página pública.
   */
  async listMine(ownerId: number): Promise<Service[]> {
    const rows = await servicesRepository.listByOwner(ownerId);
    return (await withTags(rows)).map(({ row, tags, packages }) => ({
      ...toService(row, tags, packages),
      viewsCount: Number(row.views_count ?? 0),
    }));
  },

  /** O detalhe público (com quem presta e as tags); conta a visualização de quem não é o dono. */
  async getById(id: number, viewer: Viewer = {}): Promise<Service> {
    const row = await servicesRepository.findPublicById(id);
    if (!row) throw new HttpError(404, 'Serviço não encontrado', 'service_not_found');
    await countView(row, viewer);
    return serviceWithTags(row);
  },

  async update(id: number, ownerId: number, input: UpdateServiceInput): Promise<Service> {
    const row = await servicesRepository.findById(id);
    if (!row) throw new HttpError(404, 'Serviço não encontrado', 'service_not_found');
    if (row.user_id !== ownerId) {
      throw new HttpError(403, 'Você não é o dono deste serviço', 'forbidden');
    }
    // RN-016 vale para o serviço como fica depois da edição: price null é tirar o preço.
    const priceType = input.priceType ?? row.price_type;
    // RF-086: os pacotes como ficam depois da edição. Sem `packages` no corpo, ficam os de agora.
    const packages =
      input.packages ?? (await servicesRepository.packagesByServiceIds([id])).get(id) ?? [];
    const listing = packages.length > 0 ? derivePackageListing(packages) : null;
    if (listing) {
      // Pacotes novos, ou o tipo de preço mudando com os pacotes de agora: só no preço fixo.
      if (input.packages !== undefined || input.priceType !== undefined) {
        assertPackagesFixed(priceType);
      }
      assertNoListingWithPackages(input);
      if (input.packages !== undefined) await assertPackagePrices(packages);
    }
    const price = listing
      ? listing.price
      : input.price !== undefined
        ? input.price
        : row.price == null
          ? null
          : Number(row.price);
    if (priceType === 'fixed' && price == null) {
      throw new HttpError(422, 'Preço obrigatório para preço fixo (RN-016)', 'price_required');
    }
    await assertMinPrice(priceType, price);
    if (input.categoryId !== undefined && input.categoryId !== row.category_id) {
      await assertCategory(input.categoryId);
    }

    // Mapeamento fixo input -> colunas (nunca chaves cruas do usuário).
    const fields: Record<string, unknown> = {};
    if (input.categoryId !== undefined) fields.category_id = input.categoryId;
    if (input.title !== undefined) fields.title = input.title;
    if (input.description !== undefined) fields.description = input.description;
    if (input.priceType !== undefined) fields.price_type = input.priceType;
    // Com pacotes, price e deliveryDays nulos no corpo não tiram o "a partir de" do Básico.
    if (input.price !== undefined && !listing) fields.price = input.price;
    if (input.deliveryDays !== undefined && !listing) fields.delivery_days = input.deliveryDays;
    const modality = requestedModality(input);
    if (modality !== undefined) {
      const { isRemote, isOnsite } = modalityColumns(modality);
      fields.is_remote = isRemote ? 1 : 0;
      fields.is_onsite = isOnsite ? 1 : 0;
    }
    if (input.isActive !== undefined) fields.is_active = input.isActive ? 1 : 0;
    // Com pacotes novos, o anúncio guarda o preço e o prazo do Básico (busca, ordem e troca leem
    // dali), na mesma transação que grava os pacotes.
    if (listing && input.packages !== undefined) {
      fields.price = listing.price;
      fields.delivery_days = listing.deliveryDays;
    }

    await servicesRepository.update(id, fields, input.tags, input.packages);
    const updated = await servicesRepository.findById(id);
    return serviceWithTags(updated!);
  },

  async remove(id: number, ownerId: number): Promise<void> {
    const row = await servicesRepository.findById(id);
    if (!row) throw new HttpError(404, 'Serviço não encontrado', 'service_not_found');
    if (row.user_id !== ownerId) {
      throw new HttpError(403, 'Você não é o dono deste serviço', 'forbidden');
    }
    await servicesRepository.softDelete(id);
  },
};
