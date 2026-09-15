import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: { minServicePrice: vi.fn().mockResolvedValue(10) },
}));

vi.mock('./services.repository', () => ({
  servicesRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  },
}));

import { servicesService } from './services.service';
import { servicesRepository, type ServiceRow } from './services.repository';

const repo = vi.mocked(servicesRepository);

type FakeServiceFields = Partial<{
  id: number;
  user_id: number;
  category_id: number;
  title: string;
  description: string;
  price_type: string;
  price: string | null;
  delivery_days: number | null;
  is_remote: number;
  is_active: number;
  views_count: number;
  created_at: Date;
  deleted_at: Date | null;
}>;

function fakeRow(overrides: FakeServiceFields = {}): ServiceRow {
  return {
    id: 1,
    user_id: 1,
    category_id: 10,
    title: 'Landing page',
    description: 'Faço sua landing page responsiva',
    price_type: 'fixed',
    price: '500.00',
    delivery_days: 7,
    is_remote: 1,
    is_active: 1,
    views_count: 0,
    created_at: new Date('2026-01-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  } as unknown as ServiceRow;
}

beforeEach(() => vi.clearAllMocks());

describe('servicesService.create', () => {
  it('cria e mapeia DECIMAL→number e flags→boolean', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeRow());

    const s = await servicesService.create(1, {
      categoryId: 10,
      title: 'Landing page',
      description: 'Faço sua landing page responsiva',
      priceType: 'fixed',
      price: 500,
      deliveryDays: 7,
      isRemote: true,
    });

    expect(s.price).toBe(500);
    expect(s.isRemote).toBe(true);
    expect(s.isActive).toBe(true);
    expect(s.ownerId).toBe(1);
    expect(repo.create).toHaveBeenCalledOnce();
  });
});

describe('servicesService.getById', () => {
  it('lança 404 quando não existe', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(servicesService.getById(999)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('servicesService.update', () => {
  it('lança 403 quando não é o dono', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 2 }));
    await expect(servicesService.update(1, 1, { title: 'Novo título' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('atualiza quando é o dono', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeRow({ user_id: 5 }))
      .mockResolvedValueOnce(fakeRow({ user_id: 5, title: 'Atualizado' }));
    repo.update.mockResolvedValue(undefined);

    const s = await servicesService.update(1, 5, { title: 'Atualizado' });

    expect(repo.update).toHaveBeenCalledOnce();
    expect(s.title).toBe('Atualizado');
    expect(s.ownerId).toBe(5);
  });
});

describe('servicesService.remove', () => {
  it('lança 404 quando não existe', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(servicesService.remove(1, 1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('faz soft delete quando é o dono', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 9 }));
    repo.softDelete.mockResolvedValue(undefined);
    await servicesService.remove(1, 9);
    expect(repo.softDelete).toHaveBeenCalledWith(1);
  });
});

describe('servicesService.list — dias em que o prestador atende (ADR 30)', () => {
  it('repassa day ao repositório e mapeia owner_available_days (JSON string, array ou NULL)', async () => {
    repo.list.mockResolvedValue([
      fakeRow({ id: 1, owner_name: 'A', owner_available_days: '[1,2,3]' } as never),
      fakeRow({ id: 2, owner_name: 'B', owner_available_days: [6, 0] } as never),
      fakeRow({ id: 3, owner_name: 'C', owner_available_days: null } as never),
    ]);

    const page = await servicesService.list({
      day: 6,
      page: 1,
      limit: 20,
      radiusKm: 25,
      sort: 'relevance',
    });

    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ day: 6, limit: 20, offset: 0 }),
    );
    expect(page.items.map((i) => i.ownerAvailableDays)).toEqual([[1, 2, 3], [6, 0], null]);
  });
});
