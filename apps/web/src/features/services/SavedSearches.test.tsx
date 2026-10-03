import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SavedSearch } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { SavedSearchesBar, SaveSearchButton, type CurrentSearch } from './SavedSearches';

const savedSearches = vi.fn();
const createSavedSearch = vi.fn();
const updateSavedSearch = vi.fn();
const deleteSavedSearch = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    savedSearches: () => savedSearches(),
    createSavedSearch: (body: unknown) => createSavedSearch(body),
    updateSavedSearch: (id: number, body: unknown) => updateSavedSearch(id, body),
    deleteSavedSearch: (id: number) => deleteSavedSearch(id),
  },
}));

/** A hora do resumo do dia (ADR 42) entra na frase do alerta diário; sem sessão, a frase é genérica. */
const session: { user: { id: number; digestHour: number } | null } = {
  user: { id: 1, digestHour: 8 },
};
vi.mock('../../lib/auth', () => ({ useAuth: () => session }));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

const saved = (o: Partial<SavedSearch> = {}): SavedSearch => ({
  id: 1,
  name: 'Logos baratos',
  query: 'logo',
  filters: { maxPrice: 500, isRemote: true },
  alertEnabled: true,
  alertFrequency: 'instant',
  lastAlertAt: null,
  createdAt: '2026-09-20T12:00:00.000Z',
  ...o,
});

const CURRENT: CurrentSearch = { query: 'logo', filters: { maxPrice: 500, isRemote: true } };

beforeEach(() => {
  savedSearches.mockReset();
  savedSearches.mockResolvedValue([]);
  createSavedSearch.mockReset();
  createSavedSearch.mockResolvedValue(saved());
  updateSavedSearch.mockReset();
  updateSavedSearch.mockResolvedValue(saved());
  deleteSavedSearch.mockReset();
  deleteSavedSearch.mockResolvedValue(undefined);
  session.user = { id: 1, digestHour: 8 };
});

/** Botão "Salvar busca" (ADR 35 e 37): guarda a busca da tela com nome, alerta e frequência. */
describe('SaveSearchButton', () => {
  it('sem texto nem filtro não há o que salvar: o botão fica desabilitado e explica', () => {
    render(wrap(<SaveSearchButton current={{ query: null, filters: {} }} />));

    const button = screen.getByRole('button', { name: 'Salvar busca' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Busque um texto ou escolha um filtro para salvar');
  });

  it('só com filtro já dá para salvar; a tela pode travar o botão (disabled)', () => {
    const { unmount } = render(
      wrap(<SaveSearchButton current={{ query: null, filters: { minRating: 4 } }} />),
    );
    const enabled = screen.getByRole('button', { name: 'Salvar busca' });
    expect(enabled).toBeEnabled();
    expect(enabled).not.toHaveAttribute('title');
    unmount();

    render(wrap(<SaveSearchButton current={CURRENT} disabled />));
    expect(screen.getByRole('button', { name: 'Salvar busca' })).toBeDisabled();
  });

  it('abre com o texto buscado como nome, o resumo da busca e o alerta de hora em hora', async () => {
    const user = userEvent.setup();
    render(wrap(<SaveSearchButton current={CURRENT} />));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));

    const dialog = screen.getByRole('dialog', { name: 'Salvar busca' });
    expect(within(dialog).getByText('“logo” · 2 filtros')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Nome')).toHaveValue('logo');
    expect(
      within(dialog).getByRole('switch', { name: 'Me avisar de serviços novos' }),
    ).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /^Na hora/ })).not.toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /^De hora em hora/ })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /^Uma vez por dia/ })).not.toBeChecked();
    expect(createSavedSearch).not.toHaveBeenCalled();
  });

  it('o resumo conta um filtro no singular e some com o texto quando só há filtro', async () => {
    const user = userEvent.setup();
    render(wrap(<SaveSearchButton current={{ query: null, filters: { minRating: 4 } }} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));

    const dialog = screen.getByRole('dialog', { name: 'Salvar busca' });
    expect(within(dialog).getByText('1 filtro')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Nome')).toHaveValue('');
  });

  it('salvar manda a busca da tela com nome, alerta e frequência, avisa e fecha', async () => {
    const user = userEvent.setup();
    render(wrap(<SaveSearchButton current={CURRENT} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(createSavedSearch).toHaveBeenCalledTimes(1);
    expect(createSavedSearch).toHaveBeenCalledWith({
      name: 'logo',
      query: 'logo',
      filters: { maxPrice: 500, isRemote: true },
      alertEnabled: true,
      alertFrequency: 'hourly',
    });
    expect(
      await screen.findByText(
        'Busca salva. Avisamos no máximo uma vez por hora quando aparecer serviço novo.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('nome digitado vai sem espaços nas pontas; "Uma vez por dia" avisa a hora do resumo', async () => {
    const user = userEvent.setup();
    render(wrap(<SaveSearchButton current={CURRENT} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    const name = screen.getByLabelText('Nome');
    await user.clear(name);
    await user.type(name, '  Logo até 500  ');
    await user.click(screen.getByRole('radio', { name: /^Uma vez por dia/ }));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(createSavedSearch).toHaveBeenCalledWith({
      name: 'Logo até 500',
      query: 'logo',
      filters: { maxPrice: 500, isRemote: true },
      alertEnabled: true,
      alertFrequency: 'daily',
    });
    expect(
      await screen.findByText(
        'Busca salva. Mandamos um resumo por dia, às 08:00, quando aparecer serviço novo.',
      ),
    ).toBeInTheDocument();
  });

  it('nome em branco vai como null; "Na hora" avisa que é assim que aparecer', async () => {
    const user = userEvent.setup();
    render(wrap(<SaveSearchButton current={CURRENT} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    await user.clear(screen.getByLabelText('Nome'));
    await user.click(screen.getByRole('radio', { name: /^Na hora/ }));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(createSavedSearch).toHaveBeenCalledWith({
      name: null,
      query: 'logo',
      filters: { maxPrice: 500, isRemote: true },
      alertEnabled: true,
      alertFrequency: 'instant',
    });
    expect(
      await screen.findByText('Busca salva. Avisamos assim que aparecer serviço novo.'),
    ).toBeInTheDocument();
  });

  it('alerta desligado: as frequências ficam inativas, a escolha vai guardada e o aviso é curto', async () => {
    const user = userEvent.setup();
    render(wrap(<SaveSearchButton current={CURRENT} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    await user.click(screen.getByRole('radio', { name: /^Na hora/ }));
    await user.click(screen.getByRole('switch', { name: 'Me avisar de serviços novos' }));

    expect(screen.getByRole('group', { name: 'Com que frequência' })).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^Na hora/ })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(createSavedSearch).toHaveBeenCalledWith({
      name: 'logo',
      query: 'logo',
      filters: { maxPrice: 500, isRemote: true },
      alertEnabled: false,
      alertFrequency: 'instant',
    });
    expect(await screen.findByText('Busca salva.')).toBeInTheDocument();
  });

  it('enquanto salva o botão fica travado em "Salvando…"', async () => {
    const user = userEvent.setup();
    let release!: (v: SavedSearch) => void;
    createSavedSearch.mockImplementation(() => new Promise<SavedSearch>((r) => (release = r)));
    render(wrap(<SaveSearchButton current={CURRENT} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByRole('button', { name: 'Salvando…' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Salvar busca' })).toBeInTheDocument();

    release(saved());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('API recusa: mostra a mensagem dela e o formulário continua aberto', async () => {
    const user = userEvent.setup();
    createSavedSearch.mockRejectedValue(new Error('Você já tem 20 buscas salvas.'));
    render(wrap(<SaveSearchButton current={CURRENT} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('Você já tem 20 buscas salvas.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Salvar busca' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeEnabled();
  });

  it('falha sem mensagem vira "Não foi possível salvar a busca"', async () => {
    const user = userEvent.setup();
    createSavedSearch.mockRejectedValue({ status: 500 });
    render(wrap(<SaveSearchButton current={CURRENT} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('Não foi possível salvar a busca')).toBeInTheDocument();
  });

  it('fechar descarta o que foi mexido: reabrir volta ao nome e ao alerta padrão', async () => {
    const user = userEvent.setup();
    render(wrap(<SaveSearchButton current={CURRENT} />));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    await user.type(screen.getByLabelText('Nome'), ' de teste');
    await user.click(screen.getByRole('radio', { name: /^Na hora/ }));
    await user.click(screen.getByRole('switch', { name: 'Me avisar de serviços novos' }));
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(createSavedSearch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    expect(screen.getByLabelText('Nome')).toHaveValue('logo');
    expect(screen.getByRole('switch', { name: 'Me avisar de serviços novos' })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^De hora em hora/ })).toBeChecked();
  });
});

/** Linha das buscas salvas: aplicar, ligar/desligar o alerta, editar e apagar. */
describe('SavedSearchesBar', () => {
  const LIST = [
    saved(),
    saved({
      id: 2,
      name: null,
      query: 'tradução',
      filters: null,
      alertEnabled: false,
      alertFrequency: 'daily',
    }),
    saved({ id: 3, name: null, query: null, filters: { categoryId: 4 }, alertFrequency: 'hourly' }),
  ];

  const bar = () => screen.findByRole('group', { name: 'Buscas salvas' });

  it('enquanto carrega e quando volta sem nenhuma busca salva, a linha não aparece', async () => {
    let answer!: (list: SavedSearch[]) => void;
    savedSearches.mockImplementation(() => new Promise<SavedSearch[]>((r) => (answer = r)));
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));

    await waitFor(() => expect(savedSearches).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('group', { name: 'Buscas salvas' })).not.toBeInTheDocument();

    // A resposta (vazia) chega: continua sem linha, sem rótulo e sem botão nenhum.
    await act(async () => answer([]));
    expect(screen.queryByRole('group', { name: 'Buscas salvas' })).not.toBeInTheDocument();
    expect(screen.queryByText('Salvas')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('salvar uma busca pelo botão faz ela aparecer na linha (a lista é recarregada)', async () => {
    const user = userEvent.setup();
    savedSearches.mockResolvedValueOnce([]).mockResolvedValue([saved({ name: 'logo' })]);
    render(
      wrap(
        <>
          <SaveSearchButton current={CURRENT} />
          <SavedSearchesBar onApply={vi.fn()} />
        </>,
      ),
    );
    await waitFor(() => expect(savedSearches).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('group', { name: 'Buscas salvas' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    const group = await bar();
    expect(within(group).getByRole('button', { name: 'logo' })).toBeInTheDocument();
    expect(savedSearches).toHaveBeenCalledTimes(2);
  });

  it('cada busca aparece pelo nome, pelo texto buscado ou como "Busca salva", com o resumo na dica', async () => {
    savedSearches.mockResolvedValue(LIST);
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
    const group = await bar();

    expect(within(group).getByRole('button', { name: 'Logos baratos' })).toHaveAttribute(
      'title',
      '“logo” · 2 filtros',
    );
    expect(within(group).getByRole('button', { name: 'tradução' })).toHaveAttribute(
      'title',
      '“tradução”',
    );
    expect(within(group).getByRole('button', { name: 'Busca salva' })).toHaveAttribute(
      'title',
      '1 filtro',
    );
  });

  it('o sino mostra se o alerta está ligado e com que frequência', async () => {
    savedSearches.mockResolvedValue(LIST);
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
    await bar();

    const on = screen.getByRole('button', { name: 'Alerta de Logos baratos' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    expect(on).toHaveAttribute('title', 'Alerta: na hora');
    const off = screen.getByRole('button', { name: 'Alerta de tradução' });
    expect(off).toHaveAttribute('aria-pressed', 'false');
    expect(off).toHaveAttribute('title', 'Alerta desligado');
    expect(screen.getByRole('button', { name: 'Alerta de Busca salva' })).toHaveAttribute(
      'title',
      'Alerta: de hora em hora',
    );
  });

  it('clicar na busca aplica exatamente ela', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    savedSearches.mockResolvedValue(LIST);
    render(wrap(<SavedSearchesBar onApply={onApply} />));
    await bar();

    await user.click(screen.getByRole('button', { name: 'tradução' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(LIST[1]);
    expect(updateSavedSearch).not.toHaveBeenCalled();
  });

  it('sino de alerta ligado: desliga, avisa e recarrega a lista', async () => {
    const user = userEvent.setup();
    savedSearches.mockResolvedValue(LIST);
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
    await bar();

    await user.click(screen.getByRole('button', { name: 'Alerta de Logos baratos' }));

    expect(updateSavedSearch).toHaveBeenCalledTimes(1);
    expect(updateSavedSearch).toHaveBeenCalledWith(1, { alertEnabled: false });
    expect(await screen.findByText('Alerta desligado.')).toBeInTheDocument();
    await waitFor(() => expect(savedSearches).toHaveBeenCalledTimes(2));
  });

  it('sino de alerta desligado: liga e diz quando o aviso chega, pela frequência guardada', async () => {
    const user = userEvent.setup();
    savedSearches.mockResolvedValue(LIST);
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
    await bar();

    await user.click(screen.getByRole('button', { name: 'Alerta de tradução' }));

    expect(updateSavedSearch).toHaveBeenCalledWith(2, { alertEnabled: true });
    expect(
      await screen.findByText(
        'Alerta ligado. Mandamos um resumo por dia, às 08:00, quando aparecer serviço novo.',
      ),
    ).toBeInTheDocument();
  });

  it('sem a hora do resumo na sessão, o aviso do alerta diário fala "na hora do seu resumo"', async () => {
    const user = userEvent.setup();
    session.user = null;
    savedSearches.mockResolvedValue(LIST);
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
    await bar();

    await user.click(screen.getByRole('button', { name: 'Alerta de tradução' }));

    expect(
      await screen.findByText(
        'Alerta ligado. Mandamos um resumo por dia, na hora do seu resumo, quando aparecer serviço novo.',
      ),
    ).toBeInTheDocument();
  });

  it('sino que a API recusa: mostra a mensagem, ou "Não foi possível alterar o alerta"', async () => {
    const user = userEvent.setup();
    savedSearches.mockResolvedValue(LIST);
    updateSavedSearch.mockRejectedValueOnce(new Error('Busca não encontrada.'));
    updateSavedSearch.mockRejectedValueOnce(null);
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
    await bar();

    await user.click(screen.getByRole('button', { name: 'Alerta de Logos baratos' }));
    expect(await screen.findByText('Busca não encontrada.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Alerta de Logos baratos' }));
    expect(await screen.findByText('Não foi possível alterar o alerta')).toBeInTheDocument();
    // Nada mudou no servidor: a lista não é recarregada.
    expect(savedSearches).toHaveBeenCalledTimes(1);
  });

  it('o ✕ apaga a busca certa, avisa e a linha some quando a lista volta vazia', async () => {
    const user = userEvent.setup();
    savedSearches.mockResolvedValueOnce([LIST[1]]);
    savedSearches.mockResolvedValue([]);
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
    await bar();

    await user.click(screen.getByRole('button', { name: 'Apagar tradução' }));

    expect(deleteSavedSearch).toHaveBeenCalledTimes(1);
    expect(deleteSavedSearch).toHaveBeenCalledWith(2);
    expect(await screen.findByText('Busca apagada.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Buscas salvas' })).not.toBeInTheDocument(),
    );
  });

  it('apagar que a API recusa: mostra a mensagem, ou "Não foi possível apagar a busca", e a busca fica', async () => {
    const user = userEvent.setup();
    savedSearches.mockResolvedValue(LIST);
    deleteSavedSearch.mockRejectedValueOnce(new Error('Sem permissão.'));
    deleteSavedSearch.mockRejectedValueOnce(undefined);
    render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
    await bar();

    await user.click(screen.getByRole('button', { name: 'Apagar Logos baratos' }));
    expect(await screen.findByText('Sem permissão.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apagar Logos baratos' }));
    expect(await screen.findByText('Não foi possível apagar a busca')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logos baratos' })).toBeInTheDocument();
  });

  describe('editar', () => {
    async function openEditor(label: string) {
      const user = userEvent.setup();
      savedSearches.mockResolvedValue(LIST);
      render(wrap(<SavedSearchesBar onApply={vi.fn()} />));
      await bar();
      await user.click(screen.getByRole('button', { name: `Editar ${label}` }));
      return { user, dialog: screen.getByRole('dialog', { name: 'Editar busca' }) };
    }

    it('abre com o nome, o resumo, o alerta e a frequência gravados', async () => {
      const { dialog } = await openEditor('Logos baratos');

      expect(within(dialog).getByText('“logo” · 2 filtros')).toBeInTheDocument();
      expect(within(dialog).getByLabelText('Nome')).toHaveValue('Logos baratos');
      expect(within(dialog).getByLabelText('Nome')).toHaveAttribute('placeholder', 'logo');
      expect(within(dialog).getByRole('switch')).toBeChecked();
      expect(within(dialog).getByRole('radio', { name: /^Na hora/ })).toBeChecked();
    });

    it('busca sem nome e com o alerta desligado: campo vazio e frequências inativas, com a escolha guardada', async () => {
      const { dialog } = await openEditor('tradução');

      expect(within(dialog).getByLabelText('Nome')).toHaveValue('');
      expect(within(dialog).getByRole('switch')).not.toBeChecked();
      expect(within(dialog).getByRole('group', { name: 'Com que frequência' })).toBeDisabled();
      expect(within(dialog).getByRole('radio', { name: /^Uma vez por dia/ })).toBeChecked();
    });

    it('busca sem texto: o campo do nome sugere um exemplo', async () => {
      const { dialog } = await openEditor('Busca salva');

      expect(within(dialog).getByLabelText('Nome')).toHaveAttribute(
        'placeholder',
        'Ex.: Logo até R$ 500',
      );
    });

    it('salvar sem mudar nada fecha sem chamar a API', async () => {
      const { user } = await openEditor('Logos baratos');

      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(updateSavedSearch).not.toHaveBeenCalled();
    });

    it('mudar só o nome manda só o nome, e o aviso não fala de alerta', async () => {
      const { user } = await openEditor('Logos baratos');

      const name = screen.getByLabelText('Nome');
      await user.clear(name);
      await user.type(name, ' Logos até 500 ');
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(updateSavedSearch).toHaveBeenCalledTimes(1);
      expect(updateSavedSearch).toHaveBeenCalledWith(1, { name: 'Logos até 500' });
      expect(await screen.findByText('Busca atualizada.')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(savedSearches).toHaveBeenCalledTimes(2));
    });

    it('apagar o nome manda null: a busca volta a aparecer pelo texto buscado', async () => {
      const { user } = await openEditor('Logos baratos');

      await user.clear(screen.getByLabelText('Nome'));
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(updateSavedSearch).toHaveBeenCalledWith(1, { name: null });
    });

    it('desligar o alerta manda só isso e avisa que desligou', async () => {
      const { user, dialog } = await openEditor('Logos baratos');

      await user.click(within(dialog).getByRole('switch'));
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(updateSavedSearch).toHaveBeenCalledWith(1, { alertEnabled: false });
      expect(await screen.findByText('Busca atualizada. Alerta desligado.')).toBeInTheDocument();
    });

    it('trocar a frequência com o alerta ligado manda a frequência e diz quando o aviso chega', async () => {
      const { user, dialog } = await openEditor('Logos baratos');

      await user.click(within(dialog).getByRole('radio', { name: /^De hora em hora/ }));
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(updateSavedSearch).toHaveBeenCalledWith(1, { alertFrequency: 'hourly' });
      expect(
        await screen.findByText(
          'Busca atualizada. Avisamos no máximo uma vez por hora quando aparecer serviço novo.',
        ),
      ).toBeInTheDocument();
    });

    it('religar o alerta sem trocar a frequência manda só isso e diz quando o aviso chega', async () => {
      const { user, dialog } = await openEditor('tradução');

      await user.click(within(dialog).getByRole('switch'));
      expect(within(dialog).getByRole('group', { name: 'Com que frequência' })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(updateSavedSearch).toHaveBeenCalledWith(2, { alertEnabled: true });
      expect(
        await screen.findByText(
          'Busca atualizada. Mandamos um resumo por dia, às 08:00, quando aparecer serviço novo.',
        ),
      ).toBeInTheDocument();
    });

    it('religar o alerta trocando a frequência manda os dois', async () => {
      const { user, dialog } = await openEditor('tradução');

      await user.click(within(dialog).getByRole('switch'));
      await user.click(within(dialog).getByRole('radio', { name: /^Na hora/ }));
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(updateSavedSearch).toHaveBeenCalledWith(2, {
        alertEnabled: true,
        alertFrequency: 'instant',
      });
      expect(
        await screen.findByText('Busca atualizada. Avisamos assim que aparecer serviço novo.'),
      ).toBeInTheDocument();
    });

    it('API recusa: mostra a mensagem e o editor continua aberto com o que foi digitado', async () => {
      updateSavedSearch.mockRejectedValue(new Error('Nome muito longo.'));
      const { user } = await openEditor('Logos baratos');

      await user.type(screen.getByLabelText('Nome'), ' 2');
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(await screen.findByText('Nome muito longo.')).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Editar busca' })).toBeInTheDocument();
      expect(screen.getByLabelText('Nome')).toHaveValue('Logos baratos 2');
    });

    it('falha sem mensagem vira "Não foi possível salvar a busca"', async () => {
      updateSavedSearch.mockRejectedValue('x');
      const { user, dialog } = await openEditor('Logos baratos');

      await user.click(within(dialog).getByRole('switch'));
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(await screen.findByText('Não foi possível salvar a busca')).toBeInTheDocument();
    });

    it('enquanto grava o botão fica travado em "Salvando…" e o editor só fecha com a resposta', async () => {
      let release!: (s: SavedSearch) => void;
      updateSavedSearch.mockImplementation(() => new Promise<SavedSearch>((r) => (release = r)));
      const { user, dialog } = await openEditor('Logos baratos');

      await user.click(within(dialog).getByRole('switch'));
      await user.click(screen.getByRole('button', { name: 'Salvar' }));

      expect(await screen.findByRole('button', { name: 'Salvando…' })).toBeDisabled();
      expect(screen.getByRole('dialog', { name: 'Editar busca' })).toBeInTheDocument();

      release(saved({ alertEnabled: false }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('o ✕ fecha o editor sem gravar', async () => {
      const { user, dialog } = await openEditor('Logos baratos');

      await user.type(screen.getByLabelText('Nome'), ' novo');
      await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(updateSavedSearch).not.toHaveBeenCalled();
    });
  });
});
