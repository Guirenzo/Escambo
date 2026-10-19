import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Category, Service } from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { MyServices } from './MyServices';

/**
 * "Meus serviços" (RF-030): a lista do dono com os pausados marcados, pausar e reativar, e a
 * edição do serviço (RF-022 e RF-023) com tipo de preço, prazo e modalidade.
 */

const api = vi.hoisted(() => ({
  myServices: vi.fn(),
  updateService: vi.fn(),
  categories: vi.fn(),
  publicSettings: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 3, timezone: 'America/Sao_Paulo' } }),
}));

const service = (o: Partial<Service> = {}): Service => ({
  id: 21,
  categoryId: 2,
  ownerId: 3,
  title: 'Aula de violão',
  description: 'Aula para iniciantes, no seu ritmo.',
  priceType: 'hourly',
  price: 80,
  deliveryDays: 3,
  isRemote: false,
  isActive: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  boosted: false,
  ...o,
});

const categories: Category[] = [
  {
    id: 1,
    parentId: null,
    name: 'Música',
    slug: 'musica',
    iconUrl: null,
    children: [{ id: 2, parentId: 1, name: 'Aulas', slug: 'aulas', iconUrl: null, children: [] }],
  },
];

function renderList(onBoost = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <MyServices onBoost={onBoost} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onBoost };
}

/** O card de um serviço, achado pelo título. */
const card = (title: string) => within(screen.getByText(title).closest('.card') as HTMLElement);
/** Espera a lista chegar e devolve o card do serviço. */
const found = async (title: string) =>
  within((await screen.findByText(title)).closest('.card') as HTMLElement);
const dialog = () => within(screen.getByRole('dialog', { name: 'Editar serviço' }));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.categories.mockResolvedValue(categories);
  api.publicSettings.mockResolvedValue({ minServicePrice: 10, barterEnabled: true });
  api.myServices.mockResolvedValue([
    service(),
    service({ id: 22, title: 'Logo pausado', priceType: 'fixed', price: 150, isActive: false }),
  ]);
  api.updateService.mockResolvedValue(service());
});

describe('MyServices: a lista', () => {
  it('enquanto carrega mostra o esqueleto; depois os serviços com a contagem e o pausado marcado', async () => {
    renderList();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();

    expect(await screen.findByText('Aula de violão')).toBeVisible();
    expect(screen.getByTestId('my-services-count')).toHaveTextContent('2 serviços · 1 pausado');
    expect(card('Logo pausado').getByText('Pausado')).toBeVisible();
    expect(card('Aula de violão').queryByText('Pausado')).toBeNull();
    // Os dados de quem presta não aparecem: é a lista do próprio dono. Link, só os títulos (detalhe).
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/servicos/21',
      '/servicos/22',
    ]);
  });

  it('um serviço só, ativo: contagem no singular e sem a parte dos pausados', async () => {
    api.myServices.mockResolvedValue([service()]);
    renderList();
    expect(await screen.findByTestId('my-services-count')).toHaveTextContent(/^1 serviço$/);
  });

  it('vários pausados: a contagem diz quantos', async () => {
    api.myServices.mockResolvedValue([
      service({ isActive: false }),
      service({ id: 22, title: 'Logo', isActive: false }),
    ]);
    renderList();
    expect(await screen.findByTestId('my-services-count')).toHaveTextContent(
      '2 serviços · 2 pausados',
    );
  });

  it('sem nenhum serviço, explica como publicar o primeiro', async () => {
    api.myServices.mockResolvedValue([]);
    renderList();
    expect(
      await screen.findByText(
        'Você ainda não publicou nenhum serviço. Use "Novo serviço" para publicar o primeiro.',
      ),
    ).toBeVisible();
  });

  it('erro ao carregar: mostra o motivo e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup();
    api.myServices.mockRejectedValueOnce(new Error('Sem conexão com a API.'));
    renderList();
    expect(await screen.findByText('Sem conexão com a API.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Aula de violão')).toBeVisible();
    expect(api.myServices).toHaveBeenCalledTimes(2);
  });

  it('"Impulsionar" devolve o serviço ativo a quem abre o impulsionamento', async () => {
    const user = userEvent.setup();
    const { onBoost } = renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Impulsionar' }));
    expect(onBoost).toHaveBeenCalledWith(service());
    expect(card('Logo pausado').queryByRole('button', { name: 'Impulsionar' })).toBeNull();
  });
});

describe('MyServices: pausar e reativar (RF-030)', () => {
  it('"Pausar" manda só isActive false, avisa o que muda e recarrega a lista', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Pausar' }));

    expect(api.updateService).toHaveBeenCalledWith(21, { isActive: false });
    expect(
      await screen.findByText(
        '"Aula de violão" pausado: saiu da busca e não recebe propostas novas.',
      ),
    ).toBeVisible();
    await waitFor(() => expect(api.myServices).toHaveBeenCalledTimes(2));
  });

  it('"Reativar" manda isActive true e avisa que voltou para a busca', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click((await found('Logo pausado')).getByRole('button', { name: 'Reativar' }));

    expect(api.updateService).toHaveBeenCalledWith(22, { isActive: true });
    expect(await screen.findByText('"Logo pausado" reativado: voltou para a busca.')).toBeVisible();
  });

  it('enquanto salva, só o botão daquele serviço trava em "Salvando…"', async () => {
    const user = userEvent.setup();
    let finish: (s: Service) => void = () => undefined;
    api.updateService.mockReturnValue(
      new Promise<Service>((resolve) => {
        finish = resolve;
      }),
    );
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Pausar' }));

    expect(
      await (await found('Aula de violão')).findByRole('button', { name: 'Salvando…' }),
    ).toBeDisabled();
    expect(card('Logo pausado').getByRole('button', { name: 'Reativar' })).toBeEnabled();
    await act(async () => finish(service({ isActive: false })));
    expect(
      await screen.findByText(
        '"Aula de violão" pausado: saiu da busca e não recebe propostas novas.',
      ),
    ).toBeVisible();
  });

  it('recusa da API: mostra o motivo, e sem motivo uma mensagem genérica', async () => {
    const user = userEvent.setup();
    api.updateService
      .mockRejectedValueOnce(new Error('Conta suspensa: esta ação está indisponível.'))
      .mockRejectedValueOnce('falha sem mensagem');
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Pausar' }));
    expect(await screen.findByText('Conta suspensa: esta ação está indisponível.')).toBeVisible();

    await user.click(card('Logo pausado').getByRole('button', { name: 'Reativar' }));
    expect(await screen.findByText('Não foi possível salvar.')).toBeVisible();
  });
});

describe('MyServices: editar (RF-022 e RF-023)', () => {
  it('abre com o serviço como está: categoria, tipo de preço, preço, prazo e modalidade', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Editar' }));

    expect(dialog().getByLabelText('Título')).toHaveValue('Aula de violão');
    expect(dialog().getByLabelText('Descrição')).toHaveValue('Aula para iniciantes, no seu ritmo.');
    await waitFor(() => expect(dialog().getByLabelText('Categoria')).toHaveValue('2'));
    expect(dialog().getByLabelText('Tipo de preço')).toHaveValue('hourly');
    expect(dialog().getByLabelText('Preço por hora (R$)')).toHaveValue(80);
    expect(dialog().getByLabelText('Prazo de entrega em dias (opcional)')).toHaveValue(3);
    expect(dialog().getByLabelText('Modalidade')).toHaveValue('onsite');
  });

  it('salva o serviço inteiro pelo PATCH: a combinar sem preço, sem prazo e remoto; depois fecha', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Editar' }));
    await waitFor(() => expect(dialog().getByLabelText('Categoria')).toHaveValue('2'));
    await user.clear(dialog().getByLabelText('Título'));
    await user.type(dialog().getByLabelText('Título'), 'Aula de violão online');
    await user.selectOptions(dialog().getByLabelText('Tipo de preço'), 'A combinar');
    await user.clear(dialog().getByLabelText('Prazo de entrega em dias (opcional)'));
    await user.selectOptions(dialog().getByLabelText('Modalidade'), 'Remoto');
    await user.click(dialog().getByRole('button', { name: 'Salvar alterações' }));

    expect(api.updateService).toHaveBeenCalledWith(21, {
      categoryId: 2,
      title: 'Aula de violão online',
      description: 'Aula para iniciantes, no seu ritmo.',
      priceType: 'negotiable',
      price: null,
      deliveryDays: null,
      isRemote: true,
      modality: 'remote',
      tags: [],
    });
    expect(await screen.findByText('Serviço atualizado!')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a edição traz a modalidade e as tags do serviço; tirar uma tag e salvar manda a lista nova (RF-023, RF-024)', async () => {
    const user = userEvent.setup();
    api.myServices.mockResolvedValue([
      service({ isRemote: true, modality: 'both', tags: ['violão', 'iniciantes'], viewsCount: 5 }),
    ]);
    renderList();
    expect((await found('Aula de violão')).getByTestId('views-count')).toHaveTextContent(
      '5 visualizações',
    );
    await user.click(card('Aula de violão').getByRole('button', { name: 'Editar' }));
    expect(dialog().getByLabelText('Modalidade')).toHaveValue('both');
    const chips = dialog().getByRole('list', { name: 'Tags do serviço' });
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['violão', 'iniciantes']);

    await user.click(dialog().getByRole('button', { name: 'Remover a tag iniciantes' }));
    await user.click(dialog().getByRole('button', { name: 'Salvar alterações' }));
    expect(api.updateService).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ modality: 'both', isRemote: true, tags: ['violão'] }),
    );
  });

  it('a combinar que vira preço fixo pede o preço, com o mínimo da plataforma (RN-016)', async () => {
    const user = userEvent.setup();
    api.publicSettings.mockResolvedValue({ minServicePrice: 25, barterEnabled: true });
    api.myServices.mockResolvedValue([
      service({ priceType: 'negotiable', price: null, deliveryDays: null, isRemote: true }),
    ]);
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Editar' }));
    expect(dialog().getByLabelText('Tipo de preço')).toHaveValue('negotiable');
    expect(dialog().getByLabelText('Prazo de entrega em dias (opcional)')).toHaveValue(null);
    expect(dialog().getByLabelText('Modalidade')).toHaveValue('remote');

    await user.selectOptions(dialog().getByLabelText('Tipo de preço'), 'Preço fixo');
    const price = await dialog().findByLabelText('Preço (R$) · mínimo R$ 25,00');
    expect(price).toHaveValue(null);
    expect(price).toBeRequired();
    expect(price).toHaveAttribute('min', '25');
    await user.click(dialog().getByRole('button', { name: 'Salvar alterações' }));
    expect(api.updateService).not.toHaveBeenCalled();

    await user.type(price, '40');
    await user.click(dialog().getByRole('button', { name: 'Salvar alterações' }));
    expect(api.updateService).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ priceType: 'fixed', price: 40 }),
    );
  });

  it('recusa da API: mostra o motivo e a edição continua aberta com o que foi digitado', async () => {
    const user = userEvent.setup();
    api.updateService.mockRejectedValue(new Error('Preço mínimo é R$ 10,00 (RN-016)'));
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Editar' }));
    await user.clear(dialog().getByLabelText('Título'));
    await user.type(dialog().getByLabelText('Título'), 'Aula nova');
    await user.click(dialog().getByRole('button', { name: 'Salvar alterações' }));

    expect(await screen.findByText('Preço mínimo é R$ 10,00 (RN-016)')).toBeVisible();
    expect(dialog().getByLabelText('Título')).toHaveValue('Aula nova');
    expect(screen.queryByText('Serviço atualizado!')).toBeNull();
  });

  it('recusa sem mensagem: aviso genérico', async () => {
    const user = userEvent.setup();
    api.updateService.mockRejectedValue('falha sem mensagem');
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Editar' }));
    await user.click(dialog().getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByText('Não foi possível salvar.')).toBeVisible();
  });

  it('enquanto salva, o botão fica desabilitado dizendo "Salvando…", e os cards não travam', async () => {
    const user = userEvent.setup();
    api.updateService.mockReturnValue(new Promise(() => undefined));
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Editar' }));
    await user.click(dialog().getByRole('button', { name: 'Salvar alterações' }));
    expect(await dialog().findByRole('button', { name: 'Salvando…' })).toBeDisabled();
    expect(card('Aula de violão').getByRole('button', { name: 'Pausar' })).toBeEnabled();
  });

  it('"Cancelar" fecha sem salvar', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click((await found('Aula de violão')).getByRole('button', { name: 'Editar' }));
    await user.click(dialog().getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.updateService).not.toHaveBeenCalled();
  });

  it('Esc também fecha sem salvar, e o foco volta para o "Editar" que abriu', async () => {
    const user = userEvent.setup();
    renderList();
    const edit = (await found('Aula de violão')).getByRole('button', { name: 'Editar' });
    await user.click(edit);
    expect(screen.getByRole('dialog', { name: 'Editar serviço' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(edit).toHaveFocus();
    expect(api.updateService).not.toHaveBeenCalled();
  });
});
