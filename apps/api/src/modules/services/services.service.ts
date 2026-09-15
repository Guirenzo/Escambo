import type { Paginated, Service, ServicePriceType } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { servicesRepository, type ServiceRow } from './services.repository';
import type { CreateServiceInput, ListServicesInput, UpdateServiceInput } from './services.schema';
import { parseDays } from '../profiles/profiles.service';
import { settingsService } from '../settings/settings.service';
import { currentSlot, isAvailableNow, parsePeriods } from '../profiles/availability';

function toService(row: ServiceRow): Service {
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
    isActive: Boolean(row.is_active),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
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
          }),
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

export const servicesService = {
  async create(ownerId: number, input: CreateServiceInput): Promise<Service> {
    await assertMinPrice(input.priceType, input.price);
    const id = await servicesRepository.create({
      userId: ownerId,
      categoryId: input.categoryId,
      title: input.title,
      description: input.description,
      priceType: input.priceType,
      price: input.price ?? null,
      deliveryDays: input.deliveryDays ?? null,
      isRemote: input.isRemote,
    });
    const row = await servicesRepository.findById(id);
    if (!row) throw new HttpError(500, 'Falha ao criar serviço', 'create_failed');
    return toService(row);
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
      now: input.now ? currentSlot() : undefined,
      sort: input.sort,
      limit: input.limit,
      offset: (input.page - 1) * input.limit,
    });
    return { items: rows.map(toService), page: input.page, limit: input.limit };
  },

  async getById(id: number): Promise<Service> {
    const row = await servicesRepository.findById(id);
    if (!row) throw new HttpError(404, 'Serviço não encontrado', 'service_not_found');
    return toService(row);
  },

  async update(id: number, ownerId: number, input: UpdateServiceInput): Promise<Service> {
    const row = await servicesRepository.findById(id);
    if (!row) throw new HttpError(404, 'Serviço não encontrado', 'service_not_found');
    if (row.user_id !== ownerId) {
      throw new HttpError(403, 'Você não é o dono deste serviço', 'forbidden');
    }
    await assertMinPrice(
      input.priceType ?? row.price_type,
      input.price ?? (row.price == null ? null : Number(row.price)),
    );

    // Mapeamento fixo input -> colunas (nunca chaves cruas do usuário).
    const fields: Record<string, unknown> = {};
    if (input.categoryId !== undefined) fields.category_id = input.categoryId;
    if (input.title !== undefined) fields.title = input.title;
    if (input.description !== undefined) fields.description = input.description;
    if (input.priceType !== undefined) fields.price_type = input.priceType;
    if (input.price !== undefined) fields.price = input.price;
    if (input.deliveryDays !== undefined) fields.delivery_days = input.deliveryDays;
    if (input.isRemote !== undefined) fields.is_remote = input.isRemote ? 1 : 0;
    if (input.isActive !== undefined) fields.is_active = input.isActive ? 1 : 0;

    await servicesRepository.update(id, fields);
    const updated = await servicesRepository.findById(id);
    return toService(updated!);
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
