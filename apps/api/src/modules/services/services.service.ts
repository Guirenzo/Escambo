import type { Paginated, Service, ServicePriceType } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { servicesRepository, type ServiceRow } from './services.repository';
import type { CreateServiceInput, ListServicesInput, UpdateServiceInput } from './services.schema';

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
  };
}

export const servicesService = {
  async create(ownerId: number, input: CreateServiceInput): Promise<Service> {
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
    const rows = await servicesRepository.list({
      categoryId: input.categoryId,
      q: input.q,
      isRemote: input.isRemote,
      lat: input.lat,
      lng: input.lng,
      radiusKm: input.radiusKm,
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
