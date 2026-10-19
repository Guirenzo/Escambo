import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: { minServicePrice: vi.fn().mockResolvedValue(10) },
}));

vi.mock('./services.repository', () => ({
  servicesRepository: {
    create: vi.fn(),
    categoryIsActive: vi.fn().mockResolvedValue(true),
    findById: vi.fn(),
    findPublicById: vi.fn(),
    tagsByServiceIds: vi.fn().mockResolvedValue(new Map()),
    incrementViews: vi.fn(),
    list: vi.fn(),
    listByOwner: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  },
}));

import { modalityColumns, modalityOf, servicesService } from './services.service';
import { servicesRepository, type ServiceRow } from './services.repository';
import { serviceViews } from './service-views';
import { settingsService } from '../settings/settings.service';

const repo = vi.mocked(servicesRepository);
const settings = vi.mocked(settingsService);

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
  is_onsite: number;
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
    expect(repo.create.mock.calls).toEqual([
      [
        {
          userId: 1,
          categoryId: 10,
          title: 'Landing page',
          description: 'Faço sua landing page responsiva',
          priceType: 'fixed',
          price: 500,
          deliveryDays: 7,
          isRemote: true,
          isOnsite: false,
          tags: [],
        },
      ],
    ]);
    // Preço fixo: o mínimo vigente (RN-016) é consultado antes de gravar.
    expect(settings.minServicePrice).toHaveBeenCalledTimes(1);
  });
});

describe('servicesService.getById', () => {
  it('lança 404 quando não existe, e nada é contado', async () => {
    repo.findPublicById.mockResolvedValue(undefined);
    await expect(servicesService.getById(999, { ip: '10.0.0.1' })).rejects.toMatchObject({
      statusCode: 404,
      code: 'service_not_found',
      message: 'Serviço não encontrado',
    });
    expect(repo.findPublicById.mock.calls).toEqual([[999]]);
    expect(repo.incrementViews).not.toHaveBeenCalled();
  });
});

describe('servicesService.update', () => {
  it('lança 403 quando não é o dono', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 2 }));
    await expect(servicesService.update(1, 1, { title: 'Novo título' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Você não é o dono deste serviço',
    });
    expect(repo.update).not.toHaveBeenCalled();
    // A recusa sai logo depois da leitura: o serviço não é relido nem devolvido a quem não é dono.
    expect(repo.findById.mock.calls).toEqual([[1]]);
  });

  it('atualiza quando é o dono', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeRow({ user_id: 5 }))
      .mockResolvedValueOnce(fakeRow({ user_id: 5, title: 'Atualizado' }));
    repo.update.mockResolvedValue(undefined);

    const s = await servicesService.update(1, 5, { title: 'Atualizado' });

    expect(repo.update.mock.calls).toEqual([[1, { title: 'Atualizado' }, undefined]]);
    // Lê o serviço antes (dono) e de novo depois de gravar: o que volta é a linha atualizada.
    expect(repo.findById.mock.calls).toEqual([[1], [1]]);
    expect(s.title).toBe('Atualizado');
    expect(s.ownerId).toBe(5);
  });
});

describe('servicesService.remove', () => {
  it('lança 404 quando não existe', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(servicesService.remove(1, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'service_not_found',
      message: 'Serviço não encontrado',
    });
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('faz soft delete quando é o dono', async () => {
    repo.findById.mockResolvedValue(fakeRow({ id: 4, user_id: 9 }));
    repo.softDelete.mockResolvedValue(undefined);
    expect(await servicesService.remove(4, 9)).toBeUndefined();
    expect(repo.findById.mock.calls).toEqual([[4]]);
    expect(repo.softDelete.mock.calls).toEqual([[4]]);
    // Remover é soft delete: nenhuma outra escrita.
    expect(repo.update).not.toHaveBeenCalled();
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

    // Só o dia, a ordenação, o raio e a paginação: nenhum outro filtro aparece por conta própria.
    expect(repo.list.mock.calls).toEqual([
      [{ day: 6, radiusKm: 25, sort: 'relevance', limit: 20, offset: 0 }],
    ]);
    expect(page.items.map((i) => i.ownerAvailableDays)).toEqual([[1, 2, 3], [6, 0], null]);
    expect(page.items.map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

describe('servicesService.list — período e atende agora (ADR 34)', () => {
  const base = { page: 1, limit: 20, radiusKm: 25, sort: 'relevance' as const };

  it('período sem dia é 422; com dia repassa; now vira o agora de cada fuso (ADR 48)', async () => {
    repo.list.mockResolvedValue([]);
    await expect(servicesService.list({ ...base, period: 'morning' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'period_requires_day',
      message: 'Escolha o dia para filtrar por período',
    });
    // A recusa vem antes da busca: nada vai ao repositório.
    expect(repo.list).not.toHaveBeenCalled();
    await servicesService.list({ ...base, day: 1, period: 'evening', now: true });
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({
        day: 1,
        period: 'evening',
        now: expect.objectContaining({
          'America/Sao_Paulo': expect.objectContaining({ day: expect.any(Number) }),
          'America/Rio_Branco': expect.objectContaining({ day: expect.any(Number) }),
        }),
      }),
    );
  });

  it('now=true manda ao repositório o dia e o período de agora em cada fuso do país; madrugada vai sem período (ADR 48)', async () => {
    // Quarta-feira, 08:30 UTC: 06:30 em Noronha (manhã), 05:30 em Brasília, 04:30 em Cuiabá e
    // Manaus e 03:30 em Rio Branco (madrugada: fora do horário de atendimento).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-02T08:30:00Z'));
    try {
      repo.list.mockResolvedValue([]);
      await servicesService.list({ ...base, now: true });
    } finally {
      vi.useRealTimers();
    }

    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(repo.list.mock.calls[0]![0].now).toEqual({
      'America/Noronha': { day: 3, period: 'morning' },
      'America/Sao_Paulo': { day: 3, period: null },
      'America/Cuiaba': { day: 3, period: null },
      'America/Manaus': { day: 3, period: null },
      'America/Rio_Branco': { day: 3, period: null },
    });
  });

  it('na virada do dia cada fuso leva o seu dia da semana: quinta em Noronha, ainda quarta no resto (ADR 48)', async () => {
    // 02:30 UTC de quinta: 00:30 de quinta em Noronha (madrugada) e a noite de quarta nos demais.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-03T02:30:00Z'));
    try {
      repo.list.mockResolvedValue([]);
      await servicesService.list({ ...base, now: true });
    } finally {
      vi.useRealTimers();
    }

    expect(repo.list.mock.calls[0]![0].now).toEqual({
      'America/Noronha': { day: 4, period: null },
      'America/Sao_Paulo': { day: 3, period: 'evening' },
      'America/Cuiaba': { day: 3, period: 'evening' },
      'America/Manaus': { day: 3, period: 'evening' },
      'America/Rio_Branco': { day: 3, period: 'evening' },
    });
  });

  it('o selo "atende agora" do card sai do prestador: aceitando pedidos, no dia e no período marcados, no fuso dele (ADR 48)', async () => {
    const owner = (id: number, fields: Record<string, unknown>): ServiceRow =>
      fakeRow({
        id,
        owner_name: `Prestador ${id}`,
        owner_is_available: 1,
        owner_available_days: '[3]',
        owner_available_periods: '{"3":["morning"]}',
        owner_timezone: 'America/Sao_Paulo',
        ...fields,
      } as never);
    repo.list.mockResolvedValue([
      owner(1, {}), // quarta de manhã em Brasília, e ele atende quarta de manhã
      owner(2, { owner_timezone: 'America/Manaus' }), // em Manaus ainda é madrugada
      owner(3, { owner_is_available: 0 }), // pausado
      owner(4, { owner_available_periods: '{"3":["evening"]}' }), // quarta, mas só à noite
      owner(5, { owner_available_days: '[1,2]' }), // não atende quarta
      owner(6, { owner_available_periods: null, owner_timezone: null }), // dia todo, fuso padrão
    ]);

    // Quarta-feira, 09:30 UTC: 06:30 em Brasília (manhã) e 05:30 em Manaus (madrugada).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-02T09:30:00Z'));
    let items;
    try {
      ({ items } = await servicesService.list(base));
    } finally {
      vi.useRealTimers();
    }

    expect(items.map((i) => [i.id, i.ownerAvailableNow])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
      [6, true],
    ]);
    expect(items.map((i) => i.ownerTimezone)).toEqual([
      'America/Sao_Paulo',
      'America/Manaus',
      'America/Sao_Paulo',
      'America/Sao_Paulo',
      'America/Sao_Paulo',
      'America/Sao_Paulo',
    ]);
  });

  it('domingo é o dia 0, e 0 não é "sem dia": período com day=0 passa e chega ao repositório (ADR 34)', async () => {
    repo.list.mockResolvedValue([]);

    const page = await servicesService.list({ ...base, day: 0, period: 'afternoon' });

    expect(page).toEqual({ items: [], page: 1, limit: 20 });
    expect(repo.list.mock.calls).toEqual([
      [{ day: 0, period: 'afternoon', radiusKm: 25, sort: 'relevance', limit: 20, offset: 0 }],
    ]);
  });

  it('sem now, o filtro "atende agora" não vai ao repositório', async () => {
    repo.list.mockResolvedValue([]);
    const page = await servicesService.list(base);
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(repo.list.mock.calls[0]![0].now).toBeUndefined();
    // Busca sem resultado: página vazia com a paginação pedida (e não erro).
    expect(page).toEqual({ items: [], page: 1, limit: 20 });
  });

  it('card traz os períodos do prestador e se ele atende agora (pausado, nunca)', async () => {
    repo.list.mockResolvedValue([
      fakeRow({
        id: 1,
        owner_name: 'A',
        owner_available_days: '[0,1,2,3,4,5,6]',
        owner_available_periods: '{"1":["morning"]}',
        owner_is_available: 0,
      } as never),
    ]);
    const page = await servicesService.list(base);
    expect(page.items[0]).toMatchObject({
      ownerAvailablePeriods: { '1': ['morning'] },
      ownerAvailableNow: false,
    });
  });
});

/** O serviço da fakeRow() como a API devolve (sem os campos do prestador, que só vêm na busca). */
const landing = {
  id: 1,
  categoryId: 10,
  ownerId: 1,
  title: 'Landing page',
  description: 'Faço sua landing page responsiva',
  priceType: 'fixed',
  price: 500,
  deliveryDays: 7,
  isRemote: true,
  modality: 'remote',
  tags: [],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('servicesService.create — o que é gravado e o preço mínimo (RN-016)', () => {
  const input = {
    categoryId: 10,
    title: 'Landing page',
    description: 'Faço sua landing page responsiva',
    priceType: 'fixed' as const,
    price: 500,
    isRemote: false,
  };

  it('grava em nome do dono, com preço e prazo ausentes como null, e devolve o serviço relido', async () => {
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(fakeRow());

    const created = await servicesService.create(7, {
      ...input,
      priceType: 'negotiable',
      price: undefined,
    });

    expect(created).toEqual(landing);
    expect(repo.create.mock.calls).toEqual([
      [
        {
          userId: 7,
          categoryId: 10,
          title: 'Landing page',
          description: 'Faço sua landing page responsiva',
          priceType: 'negotiable',
          price: null,
          deliveryDays: null,
          isRemote: false,
          isOnsite: true,
          tags: [],
        },
      ],
    ]);
    // O que volta é a linha relida pelo id que o banco gerou.
    expect(repo.findById.mock.calls).toEqual([[31]]);
    // A combinar não tem preço para comparar: o mínimo nem é consultado.
    expect(settings.minServicePrice).not.toHaveBeenCalled();
  });

  it('modalidade (RF-023): "both" grava remoto e presencial; a modality vale mais que o isRemote', async () => {
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(fakeRow({ is_remote: 1, is_onsite: 1 }));

    const created = await servicesService.create(7, { ...input, modality: 'both' });
    await servicesService.create(7, { ...input, isRemote: true, modality: 'onsite' });

    expect(created).toMatchObject({ isRemote: true, modality: 'both' });
    expect(repo.create.mock.calls.map(([data]) => [data.isRemote, data.isOnsite])).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  it('tags (RF-024): vão ao repositório como vieram do schema, e a resposta traz as gravadas', async () => {
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(fakeRow({ id: 31 }));
    repo.tagsByServiceIds.mockResolvedValueOnce(new Map([[31, ['figma', 'logo']]]));

    const created = await servicesService.create(7, { ...input, tags: ['logo', 'figma'] });

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ tags: ['logo', 'figma'] }));
    expect(created.tags).toEqual(['figma', 'logo']);
    expect(repo.tagsByServiceIds.mock.calls).toEqual([[[31]]]);
  });

  it('preço fixo abaixo do mínimo vigente é 422 price_below_minimum e nada é gravado', async () => {
    await expect(servicesService.create(7, { ...input, price: 9.99 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'price_below_minimum',
      message: 'Preço mínimo é R$ 10,00 (RN-016)',
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('preço fixo igual ao mínimo passa', async () => {
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(fakeRow({ price: '10.00' }));

    const created = await servicesService.create(7, { ...input, price: 10 });

    expect(created.price).toBe(10);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, price: 10 }));
  });

  it('por hora não tem preço mínimo: o piso da RN-016 é só do preço fixo', async () => {
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(fakeRow({ price_type: 'hourly', price: '5.00' }));

    const created = await servicesService.create(7, { ...input, priceType: 'hourly', price: 5 });

    expect(created).toMatchObject({ priceType: 'hourly', price: 5 });
    expect(settings.minServicePrice).not.toHaveBeenCalled();
  });

  it('se o serviço recém-criado não é encontrado, é 500 create_failed', async () => {
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(undefined);
    await expect(servicesService.create(7, input)).rejects.toMatchObject({
      statusCode: 500,
      code: 'create_failed',
      message: 'Falha ao criar serviço',
    });
    // A releitura foi pelo id que o banco gerou, e o INSERT aconteceu uma vez só.
    expect(repo.findById.mock.calls).toEqual([[31]]);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('a falha do banco ao gravar sobe para quem chamou, e o serviço não é relido', async () => {
    const boom = new Error('ER_NO_REFERENCED_ROW_2');
    repo.create.mockRejectedValueOnce(boom);
    await expect(servicesService.create(7, input)).rejects.toBe(boom);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('só se publica em categoria que existe e está ativa: a consulta é pela categoria enviada', async () => {
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(fakeRow());

    await servicesService.create(7, input);

    expect(repo.categoryIsActive.mock.calls).toEqual([[10]]);
    expect(repo.categoryIsActive.mock.invocationCallOrder[0]!).toBeLessThan(
      repo.create.mock.invocationCallOrder[0]!,
    );
  });

  it('categoria inexistente ou inativa é 422 invalid_category e nada é gravado (e não o 500 da FK)', async () => {
    repo.categoryIsActive.mockResolvedValueOnce(false);

    await expect(servicesService.create(7, { ...input, categoryId: 999 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'invalid_category',
      message: 'Categoria inexistente ou inativa',
    });

    expect(repo.categoryIsActive.mock.calls).toEqual([[999]]);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('servicesService.getById — o serviço como a API devolve', () => {
  beforeEach(() => serviceViews.clear());

  it('converte a linha do banco: DECIMAL em número, flags em boolean, data em ISO', async () => {
    repo.findPublicById.mockResolvedValue(fakeRow());
    expect(await servicesService.getById(1)).toEqual(landing);
    expect(repo.findPublicById.mock.calls).toEqual([[1]]);
    expect(repo.tagsByServiceIds.mock.calls).toEqual([[[1]]]);
  });

  it('sem preço continua null (não vira 0), e o 404 leva o código service_not_found', async () => {
    repo.findPublicById.mockResolvedValueOnce(
      fakeRow({ price_type: 'negotiable', price: null, delivery_days: null, is_remote: 0 }),
    );
    expect(await servicesService.getById(1)).toEqual({
      ...landing,
      priceType: 'negotiable',
      price: null,
      deliveryDays: null,
      isRemote: false,
      modality: 'onsite',
    });

    repo.findPublicById.mockResolvedValueOnce(undefined);
    await expect(servicesService.getById(2)).rejects.toMatchObject({
      statusCode: 404,
      code: 'service_not_found',
    });
  });

  it('data de criação que chega do banco como texto sai como veio (não passa por Date)', async () => {
    // Com dateStrings no driver a coluna DATETIME chega como texto; toISOString nem existe ali.
    repo.findPublicById.mockResolvedValue(
      fakeRow({ created_at: '2026-01-01 00:00:00' as unknown as Date }),
    );
    expect(await servicesService.getById(1)).toEqual({
      ...landing,
      createdAt: '2026-01-01 00:00:00',
    });
  });

  it('serviço pausado volta com isActive false; nunca traz as visualizações nem a distância', async () => {
    repo.findPublicById.mockResolvedValue(fakeRow({ is_active: 0, views_count: 42 }));
    const service = await servicesService.getById(1);
    expect(service).toEqual({ ...landing, isActive: false });
    for (const key of ['distanceKm', 'viewsCount']) expect(service).not.toHaveProperty(key);
  });

  it('o detalhe traz quem presta, o destaque, a modalidade e as tags', async () => {
    repo.findPublicById.mockResolvedValue(
      fakeRow({
        is_remote: 1,
        is_onsite: 1,
        boosted: 1,
        owner_ulid: '01HZX',
        owner_name: 'Ana',
        owner_avatar_url: null,
        owner_avg_rating: '4.50',
        owner_total_reviews: 3,
        owner_available_days: null,
        owner_available_periods: null,
        owner_is_available: 1,
        owner_timezone: null,
      } as never),
    );
    repo.tagsByServiceIds.mockResolvedValueOnce(new Map([[1, ['figma', 'logo']]]));

    expect(await servicesService.getById(1)).toEqual({
      ...landing,
      modality: 'both',
      tags: ['figma', 'logo'],
      boosted: true,
      ownerUlid: '01HZX',
      ownerName: 'Ana',
      ownerAvatarUrl: null,
      ownerRating: 4.5,
      ownerReviews: 3,
      ownerAvailableDays: null,
      ownerAvailablePeriods: null,
      ownerAvailableNow: false,
      ownerTimezone: 'America/Sao_Paulo',
    });
  });
});

describe('servicesService.getById — visualizações (RF-029)', () => {
  beforeEach(() => {
    serviceViews.clear();
    repo.findPublicById.mockResolvedValue(fakeRow({ id: 1, user_id: 7 }));
  });

  it('o dono abrindo o próprio serviço não conta', async () => {
    await servicesService.getById(1, { userId: 7, ip: '10.0.0.1' });
    expect(repo.incrementViews).not.toHaveBeenCalled();
    expect(serviceViews.size()).toBe(0);
  });

  it('outra conta conta uma vez; recarregar dentro da janela não conta de novo', async () => {
    await servicesService.getById(1, { userId: 8, ip: '10.0.0.1' });
    await servicesService.getById(1, { userId: 8, ip: '10.0.0.2' });
    expect(repo.incrementViews.mock.calls).toEqual([[1]]);
  });

  it('sem login, o visitante é o IP: IPs diferentes contam cada um', async () => {
    await servicesService.getById(1, { ip: '10.0.0.1' });
    await servicesService.getById(1, { ip: '10.0.0.1' });
    await servicesService.getById(1, { ip: '10.0.0.2' });
    await servicesService.getById(1);
    expect(repo.incrementViews).toHaveBeenCalledTimes(3);
  });

  it('a falha ao gravar a visualização não derruba o detalhe', async () => {
    repo.incrementViews.mockRejectedValueOnce(new Error('ER_LOCK_WAIT_TIMEOUT'));
    expect(await servicesService.getById(1, { ip: '10.0.0.9' })).toMatchObject({ id: 1 });
    expect(repo.incrementViews).toHaveBeenCalledTimes(1);
  });
});

describe('modalidade (RF-023): colunas e leitura', () => {
  it.each<[number, number | undefined, string]>([
    [1, 0, 'remote'],
    [0, 1, 'onsite'],
    [1, 1, 'both'],
    // Linha sem is_onsite (montada à mão): o inverso de is_remote, como o DEFAULT da coluna.
    [1, undefined, 'remote'],
    [0, undefined, 'onsite'],
    // Nenhum dos dois (gravado direto no banco) conta como presencial.
    [0, 0, 'onsite'],
  ])('is_remote %s e is_onsite %s é "%s"', (isRemote, isOnsite, modality) => {
    expect(modalityOf({ is_remote: isRemote, is_onsite: isOnsite })).toBe(modality);
  });

  it('cada modalidade vira as duas colunas', () => {
    expect(modalityColumns('remote')).toEqual({ isRemote: true, isOnsite: false });
    expect(modalityColumns('onsite')).toEqual({ isRemote: false, isOnsite: true });
    expect(modalityColumns('both')).toEqual({ isRemote: true, isOnsite: true });
  });
});

describe('servicesService.listMine — meus serviços (RF-030)', () => {
  it('pede ao banco os serviços do dono e devolve cada um no formato da API, pausado e impulsionado inclusive', async () => {
    repo.listByOwner.mockResolvedValue([
      fakeRow({ id: 2, user_id: 7, is_active: 0, boosted: 0 } as FakeServiceFields),
      fakeRow({ id: 1, user_id: 7, boosted: 1 } as FakeServiceFields),
    ]);

    expect(await servicesService.listMine(7)).toEqual([
      { ...landing, id: 2, ownerId: 7, isActive: false, boosted: false, viewsCount: 0 },
      { ...landing, id: 1, ownerId: 7, boosted: true, viewsCount: 0 },
    ]);
    expect(repo.listByOwner.mock.calls).toEqual([[7]]);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('é aqui (e só aqui) que o dono vê as visualizações (RF-029) e as tags de cada serviço, lidas de uma vez', async () => {
    repo.listByOwner.mockResolvedValue([
      fakeRow({ id: 2, user_id: 7, views_count: 15 }),
      fakeRow({ id: 1, user_id: 7, views_count: '3' as unknown as number }),
    ]);
    repo.tagsByServiceIds.mockResolvedValueOnce(new Map([[1, ['logo']]]));

    const mine = await servicesService.listMine(7);

    expect(mine.map((s) => [s.id, s.viewsCount, s.tags])).toEqual([
      [2, 15, []],
      [1, 3, ['logo']],
    ]);
    // Uma consulta para as tags de todos (sem N+1).
    expect(repo.tagsByServiceIds.mock.calls).toEqual([[[2, 1]]]);
  });

  it('quem ainda não publicou nada recebe a lista vazia', async () => {
    repo.listByOwner.mockResolvedValue([]);
    expect(await servicesService.listMine(9)).toEqual([]);
  });
});

describe('servicesService.update — colunas, dono e preço mínimo (RN-016)', () => {
  it('traduz cada campo para a sua coluna (booleanos como 1/0) e só manda o que foi enviado', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));

    await servicesService.update(1, 7, {
      categoryId: 11,
      title: 'Site completo',
      description: 'Site institucional de até cinco páginas',
      priceType: 'hourly',
      price: 80,
      deliveryDays: 3,
      isRemote: false,
      isActive: false,
    });
    await servicesService.update(1, 7, { isRemote: true, isActive: true });
    await servicesService.update(1, 7, {});

    expect(repo.update.mock.calls).toEqual([
      [
        1,
        {
          category_id: 11,
          title: 'Site completo',
          description: 'Site institucional de até cinco páginas',
          price_type: 'hourly',
          price: 80,
          delivery_days: 3,
          // isRemote false (cliente antigo) é presencial: as duas colunas da modalidade.
          is_remote: 0,
          is_onsite: 1,
          is_active: 0,
        },
        undefined,
      ],
      [1, { is_remote: 1, is_onsite: 0, is_active: 1 }, undefined],
      [1, {}, undefined],
    ]);
  });

  it('modalidade (RF-023): "both" grava remoto e presencial, e a modality vale mais que o isRemote', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));

    await servicesService.update(1, 7, { modality: 'both' });
    await servicesService.update(1, 7, { modality: 'onsite', isRemote: true });
    await servicesService.update(1, 7, { modality: 'remote' });

    expect(repo.update.mock.calls).toEqual([
      [1, { is_remote: 1, is_onsite: 1 }, undefined],
      [1, { is_remote: 0, is_onsite: 1 }, undefined],
      [1, { is_remote: 1, is_onsite: 0 }, undefined],
    ]);
  });

  it('tags (RF-024): a lista vai inteira ao repositório (substitui as anteriores), e a resposta traz as gravadas', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));
    repo.tagsByServiceIds.mockResolvedValueOnce(new Map([[1, ['logo', 'programação']]]));

    const updated = await servicesService.update(1, 7, { tags: ['programação', 'logo'] });
    await servicesService.update(1, 7, { tags: [] });

    expect(repo.update.mock.calls).toEqual([
      [1, {}, ['programação', 'logo']],
      [1, {}, []],
    ]);
    // O que volta é o que ficou no banco (relido, em ordem alfabética).
    expect(updated.tags).toEqual(['logo', 'programação']);
    expect(repo.tagsByServiceIds.mock.calls).toEqual([[[1]], [[1]]]);
  });

  it('serviço inexistente é 404 e não altera nada', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(servicesService.update(1, 7, { title: 'Novo título' })).rejects.toMatchObject({
      statusCode: 404,
      code: 'service_not_found',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('quem não é o dono leva 403 forbidden antes de qualquer outra checagem', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 2 }));
    await expect(servicesService.update(1, 7, { price: 1 })).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    expect(settings.minServicePrice).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('baixar o preço de um serviço de preço fixo para menos que o mínimo é recusado', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));
    await expect(servicesService.update(1, 7, { price: 5 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'price_below_minimum',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('passar para preço fixo um serviço cujo preço atual está abaixo do mínimo é recusado', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7, price_type: 'hourly', price: '5.00' }));
    await expect(servicesService.update(1, 7, { priceType: 'fixed' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'price_below_minimum',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('o tipo novo é o que vale: preço baixo junto com a troca para por hora passa', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));
    await servicesService.update(1, 7, { priceType: 'hourly', price: 5 });
    expect(repo.update.mock.calls).toEqual([[1, { price_type: 'hourly', price: 5 }, undefined]]);
  });

  it('preço fixo igual ao mínimo passa na edição, e o que volta é o serviço relido', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeRow({ user_id: 7 }))
      .mockResolvedValueOnce(fakeRow({ user_id: 7, price: '10.00' }));

    const updated = await servicesService.update(1, 7, { price: 10 });

    expect(updated).toEqual({ ...landing, ownerId: 7, price: 10 });
    expect(repo.update.mock.calls).toEqual([[1, { price: 10 }, undefined]]);
    expect(settings.minServicePrice).toHaveBeenCalledTimes(1);
  });

  it('o mínimo vigente vem das configurações da plataforma, não de um valor fixo no código', async () => {
    settings.minServicePrice.mockResolvedValueOnce(25.5);
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));
    await expect(servicesService.update(1, 7, { price: 20 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'price_below_minimum',
      message: 'Preço mínimo é R$ 25,50 (RN-016)',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('editar o título de um serviço a combinar sem preço não esbarra no mínimo: sem preço não há o que comparar', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7, price_type: 'negotiable', price: null }));

    const updated = await servicesService.update(1, 7, { title: 'Consultoria' });

    expect(updated).toMatchObject({ priceType: 'negotiable', price: null });
    expect(repo.update.mock.calls).toEqual([[1, { title: 'Consultoria' }, undefined]]);
    expect(settings.minServicePrice).not.toHaveBeenCalled();
  });

  it('null é valor, não ausência: tirar o prazo e passar para a combinar sem preço gravam NULL nas colunas', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));

    await servicesService.update(1, 7, { deliveryDays: null });
    await servicesService.update(1, 7, { priceType: 'negotiable', price: null });

    expect(repo.update.mock.calls).toEqual([
      [1, { delivery_days: null }, undefined],
      [1, { price_type: 'negotiable', price: null }, undefined],
    ]);
    // A combinar não tem piso (RN-016 é do preço fixo): o mínimo nem é consultado na segunda edição.
    expect(settings.minServicePrice).toHaveBeenCalledTimes(1);
  });

  it('a falha do banco ao gravar a edição sobe para quem chamou, e o serviço não é relido', async () => {
    const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));
    repo.update.mockRejectedValueOnce(boom);

    await expect(servicesService.update(1, 7, { title: 'Novo título' })).rejects.toBe(boom);

    expect(repo.update.mock.calls).toEqual([[1, { title: 'Novo título' }, undefined]]);
    expect(repo.findById.mock.calls).toEqual([[1]]);
  });

  it('pausar e reativar (isActive) não mexe nas outras colunas', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));
    await servicesService.update(1, 7, { isActive: false });
    await servicesService.update(1, 7, { isActive: true });
    expect(repo.update.mock.calls).toEqual([
      [1, { is_active: 0 }, undefined],
      [1, { is_active: 1 }, undefined],
    ]);
  });

  it('tirar o preço (null) de um serviço de preço fixo é 422 price_required: preço fixo sem preço não existe (RN-016)', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));

    await expect(servicesService.update(1, 7, { price: null })).rejects.toMatchObject({
      statusCode: 422,
      code: 'price_required',
      message: 'Preço obrigatório para preço fixo (RN-016)',
    });

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('passar para preço fixo um serviço a combinar sem preço, sem mandar o preço, é 422 price_required (RN-016)', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7, price_type: 'negotiable', price: null }));

    await expect(servicesService.update(1, 7, { priceType: 'fixed' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'price_required',
    });
    await expect(
      servicesService.update(1, 7, { priceType: 'fixed', price: null }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'price_required' });

    expect(repo.update).not.toHaveBeenCalled();
    // A recusa vem antes da consulta do mínimo: não há preço para comparar.
    expect(settings.minServicePrice).not.toHaveBeenCalled();
  });

  it('passar para preço fixo mandando o preço junto passa, e o mínimo vale para o preço novo', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7, price_type: 'negotiable', price: null }));

    await servicesService.update(1, 7, { priceType: 'fixed', price: 50 });

    expect(repo.update.mock.calls).toEqual([[1, { price_type: 'fixed', price: 50 }, undefined]]);
    expect(settings.minServicePrice).toHaveBeenCalledTimes(1);
  });

  it('tirar o preço de um serviço por hora continua valendo: RN-016 só cobra preço do preço fixo', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7, price_type: 'hourly', price: '80.00' }));

    await servicesService.update(1, 7, { price: null });

    expect(repo.update.mock.calls).toEqual([[1, { price: null }, undefined]]);
  });

  it('trocar para uma categoria inexistente ou inativa é 422 invalid_category e nada é gravado', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7, category_id: 10 }));
    repo.categoryIsActive.mockResolvedValueOnce(false);

    await expect(servicesService.update(1, 7, { categoryId: 99 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'invalid_category',
      message: 'Categoria inexistente ou inativa',
    });

    expect(repo.categoryIsActive.mock.calls).toEqual([[99]]);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('manter a categoria atual não consulta a categoria: o serviço já está nela', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7, category_id: 10 }));

    await servicesService.update(1, 7, { categoryId: 10, title: 'Site completo' });

    expect(repo.categoryIsActive).not.toHaveBeenCalled();
    expect(repo.update.mock.calls).toEqual([
      [1, { category_id: 10, title: 'Site completo' }, undefined],
    ]);
  });
});

describe('servicesService.remove — só o dono', () => {
  it('quem não é o dono leva 403 forbidden e o serviço continua no ar', async () => {
    repo.findById.mockResolvedValue(fakeRow({ user_id: 2 }));
    await expect(servicesService.remove(1, 7)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Você não é o dono deste serviço',
    });
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('a falha do banco ao remover sobe para quem chamou (não é engolida)', async () => {
    const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
    repo.findById.mockResolvedValue(fakeRow({ user_id: 7 }));
    repo.softDelete.mockRejectedValueOnce(boom);
    await expect(servicesService.remove(1, 7)).rejects.toBe(boom);
    expect(repo.softDelete.mock.calls).toEqual([[1]]);
  });
});

describe('servicesService.list — filtros, paginação e o card da busca', () => {
  it('repassa cada filtro, converte a página em offset e devolve itens, página e limite', async () => {
    repo.list.mockResolvedValue([fakeRow()]);

    const page = await servicesService.list({
      categoryId: 3,
      ownerId: 9,
      q: 'logo',
      isRemote: true,
      lat: -26.3,
      lng: -48.85,
      radiusKm: 10,
      minPrice: 50,
      maxPrice: 500,
      maxDeliveryDays: 7,
      minRating: 4,
      day: 6,
      period: 'morning',
      now: false,
      sort: 'price_asc',
      page: 3,
      limit: 15,
    });

    expect(page).toEqual({ items: [landing], page: 3, limit: 15 });
    expect(repo.list.mock.calls).toEqual([
      [
        {
          categoryId: 3,
          ownerId: 9,
          q: 'logo',
          isRemote: true,
          lat: -26.3,
          lng: -48.85,
          radiusKm: 10,
          minPrice: 50,
          maxPrice: 500,
          maxDeliveryDays: 7,
          minRating: 4,
          day: 6,
          period: 'morning',
          sort: 'price_asc',
          limit: 15,
          offset: 30,
        },
      ],
    ]);
    // now=false não é "atende agora": o filtro não vai ao repositório.
    expect(repo.list.mock.calls[0]![0].now).toBeUndefined();
  });

  it('o card traz distância com uma casa, destaque como boolean e o prestador com nota, avaliações e fuso', async () => {
    repo.list.mockResolvedValue([
      fakeRow({
        id: 1,
        distance_km: '1.26',
        boosted: 1,
        owner_ulid: '01HZX',
        owner_name: 'Ana',
        owner_avatar_url: '/api/media/a.webp',
        owner_avg_rating: '4.50',
        owner_total_reviews: 12,
        owner_available_days: null,
        owner_available_periods: null,
        owner_is_available: 1,
        owner_timezone: 'America/Manaus',
      } as never),
      // Prestador sem perfil (LEFT JOIN): nome nulo, sem nota, sem foto, fuso de Brasília.
      fakeRow({
        id: 2,
        boosted: 0,
        owner_ulid: null,
        owner_name: null,
        owner_avatar_url: null,
        owner_avg_rating: null,
        owner_total_reviews: null,
        owner_available_days: null,
        owner_available_periods: null,
        owner_is_available: null,
        owner_timezone: null,
      } as never),
    ]);

    const { items } = await servicesService.list({
      page: 1,
      limit: 20,
      radiusKm: 25,
      sort: 'relevance',
    });

    expect(items[0]).toEqual({
      ...landing,
      distanceKm: 1.3,
      boosted: true,
      ownerUlid: '01HZX',
      ownerName: 'Ana',
      ownerAvatarUrl: '/api/media/a.webp',
      ownerRating: 4.5,
      ownerReviews: 12,
      ownerAvailableDays: null,
      ownerAvailablePeriods: null,
      // Sem dias informados, "atende agora" é sempre falso.
      ownerAvailableNow: false,
      ownerTimezone: 'America/Manaus',
    });
    expect(items[1]).toEqual({
      ...landing,
      id: 2,
      boosted: false,
      ownerName: null,
      ownerAvatarUrl: null,
      ownerRating: 0,
      ownerReviews: 0,
      ownerAvailableDays: null,
      ownerAvailablePeriods: null,
      ownerAvailableNow: false,
      ownerTimezone: 'America/Sao_Paulo',
    });
    expect(items[1]).not.toHaveProperty('distanceKm');
  });

  it('distância zero (prestador no próprio ponto da busca) aparece como 0, e não some do card', async () => {
    repo.list.mockResolvedValue([
      fakeRow({ id: 1, distance_km: 0 } as never),
      fakeRow({ id: 2, distance_km: '0' } as never),
      fakeRow({ id: 3, distance_km: '12.449' } as never),
      fakeRow({ id: 4, distance_km: null } as never),
    ]);

    const { items } = await servicesService.list({
      lat: -26.3,
      lng: -48.85,
      page: 1,
      limit: 20,
      radiusKm: 25,
      sort: 'distance',
    });

    expect(items.map((i) => [i.id, i.distanceKm])).toEqual([
      [1, 0],
      [2, 0],
      [3, 12.4],
      [4, undefined],
    ]);
    expect(items[0]).toHaveProperty('distanceKm', 0);
    expect(items[3]).not.toHaveProperty('distanceKm');
  });

  it('o destaque que o banco manda como texto vale pelo número: "0" não é destaque, "1" é', async () => {
    repo.list.mockResolvedValue([
      fakeRow({ id: 1, boosted: '0' } as never),
      fakeRow({ id: 2, boosted: '1' } as never),
    ]);

    const { items } = await servicesService.list({
      page: 1,
      limit: 20,
      radiusKm: 25,
      sort: 'relevance',
    });

    expect(items.map((i) => [i.id, i.boosted])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('as tags dos cards vêm numa consulta só, para a página inteira (sem N+1)', async () => {
    repo.list.mockResolvedValue([fakeRow({ id: 5 }), fakeRow({ id: 6 }), fakeRow({ id: 7 })]);
    repo.tagsByServiceIds.mockResolvedValueOnce(
      new Map([
        [5, ['figma', 'ui/ux']],
        [7, ['react']],
      ]),
    );

    const { items } = await servicesService.list({
      page: 1,
      limit: 20,
      radiusKm: 25,
      sort: 'relevance',
    });

    expect(items.map((i) => [i.id, i.tags])).toEqual([
      [5, ['figma', 'ui/ux']],
      [6, []],
      [7, ['react']],
    ]);
    expect(repo.tagsByServiceIds.mock.calls).toEqual([[[5, 6, 7]]]);
    // A busca pública nunca traz as visualizações.
    for (const item of items) expect(item).not.toHaveProperty('viewsCount');
  });

  it('a falha do banco na busca sobe para quem chamou (não vira página vazia)', async () => {
    const boom = new Error('ER_QUERY_INTERRUPTED');
    repo.list.mockRejectedValueOnce(boom);
    await expect(
      servicesService.list({ page: 1, limit: 20, radiusKm: 25, sort: 'relevance' }),
    ).rejects.toBe(boom);
  });
});
