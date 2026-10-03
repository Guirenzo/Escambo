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
    reorderPortfolio: vi.fn(),
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

  it('o portfólio cabe 12 trabalhos: com 11 o próximo ainda entra; com 12 é 409 e nada é gravado', async () => {
    repo.countPortfolio.mockResolvedValueOnce(11).mockResolvedValueOnce(12);
    repo.createPortfolioItem.mockResolvedValue(40);
    repo.listPortfolio.mockResolvedValue([item(40)]);
    const input = { title: 'Mais um', externalUrl: 'https://x.test' };

    const list = await profilesService.addPortfolioItem(7, input);
    expect(list.map((i) => i.id)).toEqual([40]);
    // O limite é o do portfólio de quem está criando.
    expect(repo.countPortfolio).toHaveBeenCalledWith(7);
    expect(repo.createPortfolioItem).toHaveBeenCalledTimes(1);
    expect(repo.listPortfolio).toHaveBeenCalledWith(7);

    await expect(profilesService.addPortfolioItem(7, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'portfolio_full',
      message: 'O portfólio tem no máximo 12 itens',
    });
    // A recusa vem antes de gravar e de reler a lista.
    expect(repo.createPortfolioItem).toHaveBeenCalledTimes(1);
    expect(repo.listPortfolio).toHaveBeenCalledTimes(1);
  });

  it('quem não tem perfil de freelancer recebe 409 no_freelancer_profile, e a lista nem é lida', async () => {
    repo.countPortfolio.mockResolvedValue(0);
    repo.createPortfolioItem.mockResolvedValue(null);

    await expect(
      profilesService.addPortfolioItem(7, { title: 'Sem perfil', externalUrl: 'https://x.test' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'no_freelancer_profile',
      message: 'Crie seu perfil de freelancer antes do portfólio',
    });
    expect(repo.createPortfolioItem).toHaveBeenCalledWith(7, {
      title: 'Sem perfil',
      description: null,
      imageUrl: null,
      externalUrl: 'https://x.test',
    });
    expect(repo.listPortfolio).not.toHaveBeenCalled();
  });

  it('descrição, imagem e link preenchidos chegam ao banco como vieram, na criação e na edição', async () => {
    repo.countPortfolio.mockResolvedValue(0);
    repo.createPortfolioItem.mockResolvedValue(10);
    repo.updatePortfolioItem.mockResolvedValue(true);
    repo.listPortfolio.mockResolvedValue([item(10)]);
    const input = {
      title: 'Site da padaria',
      description: 'Loja virtual',
      imageUrl: 'https://img.escambo.test/a.png',
      externalUrl: 'https://padaria.test',
    };

    await profilesService.addPortfolioItem(7, input);
    await profilesService.updatePortfolioItem(7, 10, input);

    expect(repo.createPortfolioItem).toHaveBeenCalledWith(7, input);
    expect(repo.updatePortfolioItem).toHaveBeenCalledWith(7, 10, input);
  });

  it('editar deixando só a imagem apaga o link e a descrição que o trabalho tinha', async () => {
    repo.updatePortfolioItem.mockResolvedValue(true);
    repo.listPortfolio.mockResolvedValue([item(10)]);

    await profilesService.updatePortfolioItem(7, 10, {
      title: 'Site da padaria',
      imageUrl: 'https://img.escambo.test/a.png',
    });

    expect(repo.updatePortfolioItem).toHaveBeenCalledWith(7, 10, {
      title: 'Site da padaria',
      description: null,
      imageUrl: 'https://img.escambo.test/a.png',
      externalUrl: null,
    });
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

  it('a lista do portfólio sai no formato da API, na ordem que o banco devolveu', async () => {
    repo.listPortfolio.mockResolvedValueOnce([
      { ...item(4), sort_order: 1, description: 'Loja virtual' } as PortfolioRow,
      { ...item(2), image_url: null, external_url: 'https://x.test' } as PortfolioRow,
    ]);

    expect(await profilesService.listMyPortfolio(7)).toEqual([
      {
        id: 4,
        title: 'Trabalho 4',
        description: 'Loja virtual',
        imageUrl: 'https://img.escambo.test/a.png',
        externalUrl: null,
        sortOrder: 1,
      },
      {
        id: 2,
        title: 'Trabalho 2',
        description: null,
        imageUrl: null,
        externalUrl: 'https://x.test',
        sortOrder: 2,
      },
    ]);
    expect(repo.listPortfolio).toHaveBeenCalledWith(7);
  });

  it('editar e remover o próprio trabalho grava em nome do dono e devolve a lista de agora', async () => {
    repo.updatePortfolioItem.mockResolvedValue(true);
    repo.deletePortfolioItem.mockResolvedValue(true);
    repo.listPortfolio.mockResolvedValueOnce([item(1), item(12)]).mockResolvedValueOnce([item(1)]);

    const edited = await profilesService.updatePortfolioItem(7, 12, {
      title: 'Novo título',
      externalUrl: 'https://x.test',
    });
    // O que a pessoa deixou em branco vai como null: editar apaga a imagem que saiu do formulário.
    expect(repo.updatePortfolioItem).toHaveBeenCalledWith(7, 12, {
      title: 'Novo título',
      description: null,
      imageUrl: null,
      externalUrl: 'https://x.test',
    });
    expect(edited.map((i) => i.id)).toEqual([1, 12]);

    const left = await profilesService.removePortfolioItem(7, 12);
    expect(repo.deletePortfolioItem).toHaveBeenCalledWith(7, 12);
    expect(left.map((i) => i.id)).toEqual([1]);

    // A lista devolvida é sempre a do próprio dono, lida depois da gravação.
    expect(repo.listPortfolio).toHaveBeenCalledTimes(2);
    expect(repo.listPortfolio).toHaveBeenNthCalledWith(1, 7);
    expect(repo.listPortfolio).toHaveBeenNthCalledWith(2, 7);
  });

  it('quando o trabalho não é do usuário, nada é lido de volta: a recusa vem antes da lista', async () => {
    repo.updatePortfolioItem.mockResolvedValue(false);
    repo.deletePortfolioItem.mockResolvedValue(false);

    await expect(
      profilesService.updatePortfolioItem(7, 99, {
        title: 'Novo título',
        externalUrl: 'https://x.test',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'portfolio_item_not_found' });
    await expect(profilesService.removePortfolioItem(7, 99)).rejects.toMatchObject({
      statusCode: 404,
      code: 'portfolio_item_not_found',
    });
    expect(repo.listPortfolio).not.toHaveBeenCalled();
  });

  it('reordenar devolve a lista lida depois da gravação, já na ordem nova (ADR 43)', async () => {
    repo.listPortfolio
      .mockResolvedValueOnce([item(1), item(2), item(3)])
      .mockResolvedValueOnce([item(3), item(1), item(2)]);

    const list = await profilesService.reorderPortfolio(7, [3, 1, 2]);

    expect(repo.reorderPortfolio).toHaveBeenCalledWith(7, [3, 1, 2]);
    expect(list.map((i) => i.id)).toEqual([3, 1, 2]);
    // A conferência e a lista devolvida são do portfólio do próprio dono.
    expect(repo.listPortfolio).toHaveBeenCalledTimes(2);
    expect(repo.listPortfolio).toHaveBeenNthCalledWith(1, 7);
    expect(repo.listPortfolio).toHaveBeenNthCalledWith(2, 7);
    // Primeiro confere, depois grava, e só então relê: a lista devolvida já tem a ordem gravada.
    const [checked, reread] = repo.listPortfolio.mock.invocationCallOrder;
    const written = repo.reorderPortfolio.mock.invocationCallOrder[0]!;
    expect(checked!).toBeLessThan(written);
    expect(written).toBeLessThan(reread!);
  });

  it('portfólio vazio não tem o que reordenar: qualquer lista é 409, sem gravar nem reler', async () => {
    repo.listPortfolio.mockResolvedValue([]);

    await expect(profilesService.reorderPortfolio(7, [1])).rejects.toMatchObject({
      statusCode: 409,
      code: 'portfolio_order_mismatch',
      message: 'O portfólio mudou enquanto você reordenava; recarregue e tente de novo',
    });
    expect(repo.reorderPortfolio).not.toHaveBeenCalled();
    expect(repo.listPortfolio).toHaveBeenCalledTimes(1);
  });

  it('reordena só com exatamente os trabalhos de agora; lista diferente é 409 e não grava (ADR 43)', async () => {
    repo.listPortfolio.mockResolvedValue([item(1), item(2), item(3)]);
    await profilesService.reorderPortfolio(7, [3, 1, 2]);
    expect(repo.reorderPortfolio).toHaveBeenCalledWith(7, [3, 1, 2]);

    repo.reorderPortfolio.mockClear();
    for (const ids of [
      [3, 1],
      [3, 1, 2, 4],
      [3, 1, 9],
    ]) {
      await expect(profilesService.reorderPortfolio(7, ids)).rejects.toMatchObject({
        statusCode: 409,
        code: 'portfolio_order_mismatch',
      });
    }
    expect(repo.reorderPortfolio).not.toHaveBeenCalled();
  });
});

describe('horário de atendimento no perfil (ADR 34)', () => {
  it('normaliza os períodos pelos dias marcados e expõe availablePeriods e availableNow', async () => {
    repo.findFreelancerByUserId.mockResolvedValueOnce(
      freelancerRow({
        available_days: [1],
        available_periods: '{"1":["morning"]}',
        is_available: 0,
      }),
    );
    const p = await profilesService.upsertFreelancer(7, {
      fullName: 'Bruno Costa',
      availableDays: [1],
      availablePeriods: { '1': ['morning', 'morning'], '2': ['evening'] },
    });
    expect(repo.upsertFreelancer).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ availablePeriods: '{"1":["morning"]}' }),
    );
    expect(p.availablePeriods).toEqual({ '1': ['morning'] });
    expect(p.availableNow).toBe(false); // pausado nunca atende agora
  });
});
