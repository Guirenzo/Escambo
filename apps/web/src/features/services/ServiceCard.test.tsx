import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Service } from '@escambo/types';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceCard, servicePrice } from './ServiceCard';
import { AccountAccessProvider } from '../../lib/account-access';

const publicSettings = vi.fn();
vi.mock('../../lib/api', () => ({ api: { publicSettings: () => publicSettings() } }));

/** Quem está vendo o card: o fuso dele decide se a agenda do prestador ganha "(horário de …)". */
const viewer: { user: { id: number; timezone: string } | null } = {
  user: { id: 1, timezone: 'America/Sao_Paulo' },
};
vi.mock('../../lib/auth', () => ({ useAuth: () => viewer }));

const service = (o: Partial<Service> = {}): Service => ({
  id: 5,
  categoryId: 2,
  ownerId: 9,
  title: 'Logo profissional',
  description: 'Crio a identidade visual da sua marca.',
  priceType: 'fixed',
  price: 150,
  deliveryDays: 5,
  isRemote: false,
  isActive: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  ownerUlid: '01HZXULIDBRUNA',
  ownerName: 'Bruna Lima',
  ownerAvatarUrl: null,
  ownerRating: 4.5,
  ownerReviews: 12,
  ...o,
});

type Props = ComponentProps<typeof ServiceCard>;

function renderCard(props: Partial<Props> = {}, status: 'active' | 'suspended' = 'active') {
  const handlers = { onContratar: vi.fn(), onBoost: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AccountAccessProvider status={status}>
          <ServiceCard service={service()} mine={false} {...handlers} {...props} />
        </AccountAccessProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return handlers;
}

beforeEach(() => {
  publicSettings.mockReset();
  publicSettings.mockResolvedValue({ barterEnabled: true });
  viewer.user = { id: 1, timezone: 'America/Sao_Paulo' };
});

/** Card de serviço da busca e do perfil público. */
describe('ServiceCard', () => {
  it('suspenso consulta serviço e perfil, mas não contrata, troca nem favorita', async () => {
    const favorite = vi.fn();
    const barter = vi.fn();
    const handlers = renderCard(
      { onToggleFavorite: favorite, onProposeBarter: barter },
      'suspended',
    );
    expect(screen.getByText('Logo profissional')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bruna Lima' })).toHaveAttribute(
      'href',
      '/freelancers/01HZXULIDBRUNA',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Propor troca' })).toBeDisabled(),
    );
    const user = userEvent.setup();
    for (const label of ['Contratar', 'Propor troca', 'Favoritar']) {
      const button = screen.getByRole('button', { name: label });
      expect(button).toBeDisabled();
      await user.click(button);
    }
    expect(handlers.onContratar).not.toHaveBeenCalled();
    expect(favorite).not.toHaveBeenCalled();
    expect(barter).not.toHaveBeenCalled();
  });
  it('mostra título, descrição, preço, prazo e quem presta, com link para o perfil', () => {
    renderCard();

    expect(screen.getByText('Logo profissional')).toBeInTheDocument();
    expect(screen.getByText('Crio a identidade visual da sua marca.')).toBeInTheDocument();
    expect(screen.getByText('R$ 150,00')).toBeInTheDocument();
    expect(screen.getByText('5 dias')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bruna Lima' })).toHaveAttribute(
      'href',
      '/freelancers/01HZXULIDBRUNA',
    );
    expect(screen.getByRole('img', { name: '4.5 de 5, 12 avaliações' })).toBeInTheDocument();
    expect(screen.queryByText('remoto')).not.toBeInTheDocument();
    expect(screen.getByText('presencial')).toBeInTheDocument();
    expect(screen.queryByText('Destaque')).not.toBeInTheDocument();
    expect(screen.queryByText('Pausado')).not.toBeInTheDocument();
  });

  it('preço por hora leva "/h", e prazo de 1 dia fica no singular', () => {
    renderCard({ service: service({ priceType: 'hourly', price: 80, deliveryDays: 1 }) });
    expect(screen.getByText('R$ 80,00/h')).toBeInTheDocument();
    expect(screen.getByText('1 dia')).toBeInTheDocument();
  });

  it('a combinar mostra "a combinar" mesmo com um preço guardado', () => {
    renderCard({ service: service({ priceType: 'negotiable', price: 300 }) });
    expect(screen.getByText('a combinar')).toBeInTheDocument();
    expect(screen.queryByText('R$ 300,00')).not.toBeInTheDocument();
  });

  it('servicePrice: fixo, por hora e a combinar, e sem preço é sempre "a combinar"', () => {
    // O brl separa "R$" do valor com espaço sem quebra; aqui vale o texto como se lê.
    const plain = (text: string): string => text.replace(/\s/g, ' ');
    expect(plain(servicePrice({ priceType: 'fixed', price: 150 }))).toBe('R$ 150,00');
    expect(plain(servicePrice({ priceType: 'hourly', price: 45.5 }))).toBe('R$ 45,50/h');
    expect(servicePrice({ priceType: 'negotiable', price: null })).toBe('a combinar');
    expect(servicePrice({ priceType: 'hourly', price: null })).toBe('a combinar');
  });

  it('sem preço diz "a combinar"; na busca por proximidade a distância toma o lugar do prazo', () => {
    renderCard({ service: service({ price: null, distanceKm: 3.2, isRemote: true }) });

    expect(screen.getByText('a combinar')).toBeInTheDocument();
    expect(screen.getByText('3.2 km de você')).toBeInTheDocument();
    expect(screen.queryByText('5 dias')).not.toBeInTheDocument();
    expect(screen.getByText('remoto')).toBeInTheDocument();
  });

  it('sem distância nem prazo o rodapé fica só com o preço', () => {
    renderCard({ service: service({ deliveryDays: null }) });

    expect(screen.getByText('R$ 150,00')).toBeInTheDocument();
    expect(screen.queryByText(/dias$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/km de você/)).not.toBeInTheDocument();
  });

  it('prestador sem avaliações aparece com a nota zerada, e sem ulid o nome não vira link', () => {
    renderCard({
      service: service({ ownerUlid: undefined, ownerRating: undefined, ownerReviews: undefined }),
    });

    expect(screen.getByText('Bruna Lima')).toBeInTheDocument();
    // Só o título é link (abre o detalhe); o nome de quem presta, sem ulid, não.
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Logo profissional']);
    expect(screen.getByRole('img', { name: '0.0 de 5, 0 avaliações' })).toBeInTheDocument();
  });

  it('serviço sem o nome de quem presta não mostra a linha do prestador', () => {
    renderCard({ service: service({ ownerName: undefined, ownerAvailableNow: true }) });

    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Logo profissional']);
    expect(screen.queryByRole('img', { name: /de 5/ })).not.toBeInTheDocument();
    expect(screen.queryByText('atende agora')).not.toBeInTheDocument();
    expect(screen.getByText('Logo profissional')).toBeInTheDocument();
  });

  it('showOwner desligado (perfil público) esconde quem presta', () => {
    renderCard({ showOwner: false, service: service({ ownerAvailableNow: true }) });

    expect(screen.queryByText('Bruna Lima')).not.toBeInTheDocument();
    expect(screen.queryByText('atende agora')).not.toBeInTheDocument();
    expect(screen.getByText('Logo profissional')).toBeInTheDocument();
  });

  it('agenda do prestador: "atende agora" e os dias com períodos, sem nota de fuso quando é o mesmo', () => {
    renderCard({
      service: service({
        ownerAvailableNow: true,
        ownerAvailableDays: [1, 2, 3, 4, 5],
        ownerAvailablePeriods: {
          '1': ['morning', 'afternoon'],
          '2': ['morning', 'afternoon'],
          '3': ['morning', 'afternoon'],
          '4': ['morning', 'afternoon'],
          '5': ['morning', 'afternoon'],
        },
        ownerTimezone: 'America/Sao_Paulo',
      }),
    });

    expect(screen.getByText('atende agora')).toBeInTheDocument();
    expect(screen.getByText('atende seg a sex · manhã e tarde')).toBeInTheDocument();
  });

  it('prestador em outro fuso: a agenda diz de onde é o horário', () => {
    renderCard({
      service: service({ ownerAvailableDays: [1, 3], ownerTimezone: 'America/Manaus' }),
    });

    expect(screen.getByText('atende seg, qua (horário de Manaus)')).toBeInTheDocument();
    expect(screen.queryByText('atende agora')).not.toBeInTheDocument();
  });

  it('visitante sem sessão é tratado como horário de Brasília', () => {
    viewer.user = null;
    renderCard({
      service: service({ ownerAvailableDays: [6], ownerTimezone: 'America/Sao_Paulo' }),
    });

    expect(screen.getByText('atende sáb')).toBeInTheDocument();
  });

  it('prestador sem dias informados não ganha o selo de agenda', () => {
    renderCard({ service: service({ ownerAvailableDays: [] }) });

    expect(screen.queryByText(/^atende/)).not.toBeInTheDocument();
  });

  it('serviço dos outros: "Contratar" devolve o serviço clicado', async () => {
    const user = userEvent.setup();
    const s = service();
    const { onContratar, onBoost } = renderCard({ service: s });

    await user.click(screen.getByRole('button', { name: 'Contratar' }));

    expect(onContratar).toHaveBeenCalledTimes(1);
    expect(onContratar).toHaveBeenCalledWith(s);
    expect(onBoost).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Impulsionar/ })).not.toBeInTheDocument();
  });

  it('meu serviço: só "Impulsionar", que devolve o serviço; nada de contratar, favoritar ou trocar', async () => {
    const user = userEvent.setup();
    const s = service();
    const onToggleFavorite = vi.fn();
    const onProposeBarter = vi.fn();
    const { onBoost } = renderCard({ service: s, mine: true, onToggleFavorite, onProposeBarter });

    expect(screen.queryByRole('button', { name: 'Contratar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Favoritar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propor troca' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Impulsionar' }));
    expect(onBoost).toHaveBeenCalledTimes(1);
    expect(onBoost).toHaveBeenCalledWith(s);
  });

  it('meu serviço já impulsionado: selo "Destaque" e o botão travado em "Impulsionado"', async () => {
    const user = userEvent.setup();
    const { onBoost } = renderCard({ service: service({ boosted: true }), mine: true });

    expect(screen.getByText('Destaque')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Impulsionado' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onBoost).not.toHaveBeenCalled();
  });

  it('favorito: o coração diz o que vai fazer, mostra o estado e devolve o serviço', async () => {
    const user = userEvent.setup();
    const s = service();
    const onToggleFavorite = vi.fn();
    renderCard({ service: s, onToggleFavorite, favorited: false });

    const heart = screen.getByRole('button', { name: 'Favoritar' });
    expect(heart).toHaveAttribute('aria-pressed', 'false');
    await user.click(heart);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).toHaveBeenCalledWith(s);
  });

  it('já favoritado: o coração fica marcado e oferece remover', () => {
    renderCard({ onToggleFavorite: vi.fn(), favorited: true });

    expect(screen.getByRole('button', { name: 'Remover dos favoritos' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('button', { name: 'Favoritar' })).not.toBeInTheDocument();
  });

  it('sem quem trate o favorito (visitante) o coração não aparece', () => {
    renderCard();

    expect(screen.queryByRole('button', { name: 'Favoritar' })).not.toBeInTheDocument();
  });

  it('"Propor troca" só existe para quem pode propor, e devolve o serviço', async () => {
    const user = userEvent.setup();
    const s = service();
    const onProposeBarter = vi.fn();
    const { onContratar } = renderCard({ service: s, onProposeBarter });

    await user.click(screen.getByRole('button', { name: 'Propor troca' }));
    expect(onProposeBarter).toHaveBeenCalledTimes(1);
    expect(onProposeBarter).toHaveBeenCalledWith(s);
    expect(onContratar).not.toHaveBeenCalled();
  });

  it('cliente (sem onProposeBarter) não vê "Propor troca"', async () => {
    renderCard();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole('button', { name: 'Propor troca' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Contratar' })).toBeInTheDocument();
  });

  describe('meus serviços (RF-030)', () => {
    it('ativo: "Impulsionar", "Editar" e "Pausar", cada um devolvendo o serviço', async () => {
      const user = userEvent.setup();
      const s = service();
      const onEdit = vi.fn();
      const onToggleActive = vi.fn();
      const { onBoost } = renderCard({ service: s, mine: true, onEdit, onToggleActive });

      await user.click(screen.getByRole('button', { name: 'Editar' }));
      await user.click(screen.getByRole('button', { name: 'Pausar' }));
      await user.click(screen.getByRole('button', { name: 'Impulsionar' }));
      expect(onEdit.mock.calls).toEqual([[s]]);
      expect(onToggleActive.mock.calls).toEqual([[s]]);
      expect(onBoost.mock.calls).toEqual([[s]]);
      expect(screen.queryByTestId('paused-note')).not.toBeInTheDocument();
    });

    it('pausado: selo "Pausado" em texto, o aviso do que muda, "Reativar" e nada de impulsionar (RN-017)', async () => {
      const user = userEvent.setup();
      const s = service({ isActive: false });
      const onToggleActive = vi.fn();
      renderCard({ service: s, mine: true, onEdit: vi.fn(), onToggleActive });

      expect(screen.getByText('Pausado')).toBeInTheDocument();
      expect(screen.getByTestId('paused-note')).toHaveTextContent(
        'Fora da busca e sem propostas novas. Os contratos em andamento continuam.',
      );
      expect(screen.queryByRole('button', { name: /Impulsion/ })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Reativar' }));
      expect(onToggleActive.mock.calls).toEqual([[s]]);
    });

    it('enquanto salva a pausa, o botão trava dizendo "Salvando…"', () => {
      renderCard({ mine: true, onToggleActive: vi.fn(), toggling: true });
      expect(screen.getByRole('button', { name: 'Salvando…' })).toBeDisabled();
    });

    it('sem quem trate edição e pausa (busca), o dono só vê "Impulsionar"', () => {
      renderCard({ mine: true });
      expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pausar' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Impulsionar' })).toBeInTheDocument();
    });

    it('conta suspensa não edita nem pausa', async () => {
      renderCard({ mine: true, onEdit: vi.fn(), onToggleActive: vi.fn() }, 'suspended');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Editar' })).toBeDisabled());
      expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled();
    });
  });

  describe('catálogo (RF-023, RF-024, RF-029)', () => {
    it('o título abre o detalhe do serviço', () => {
      renderCard();
      expect(screen.getByRole('link', { name: 'Logo profissional' })).toHaveAttribute(
        'href',
        '/servicos/5',
      );
    });

    it('a modalidade vem da modality; "remoto e presencial" quando atende dos dois jeitos', () => {
      renderCard({ service: service({ isRemote: true, modality: 'both' }) });
      expect(screen.getByText('remoto e presencial')).toBeInTheDocument();
    });

    it('as tags aparecem, cada uma como link para a busca por ela', () => {
      renderCard({ service: service({ tags: ['figma', 'ui/ux'] }) });
      const list = screen.getByRole('list', { name: 'Tags' });
      expect(list).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Buscar pela tag figma' })).toHaveAttribute(
        'href',
        '/servicos?q=figma',
      );
      expect(screen.getByRole('link', { name: 'Buscar pela tag ui/ux' })).toHaveAttribute(
        'href',
        '/servicos?q=ui%2Fux',
      );
    });

    it('sem tags, não há lista de tags', () => {
      renderCard({ service: service({ tags: [] }) });
      expect(screen.queryByRole('list', { name: 'Tags' })).not.toBeInTheDocument();
    });

    it('o dono vê as visualizações, no singular e no plural; na busca, nunca', () => {
      renderCard({ mine: true, service: service({ viewsCount: 1 }) });
      expect(screen.getByTestId('views-count')).toHaveTextContent('1 visualização');
    });

    it('milhar com ponto e plural', () => {
      renderCard({ mine: true, service: service({ viewsCount: 1234 }) });
      expect(screen.getByTestId('views-count')).toHaveTextContent('1.234 visualizações');
    });

    it('fora de "Meus serviços" (ou sem o número), as visualizações não aparecem', () => {
      renderCard({ mine: false, service: service({ viewsCount: 7 }) });
      expect(screen.queryByTestId('views-count')).not.toBeInTheDocument();
    });
  });

  it('com a troca desligada pela plataforma, "Propor troca" some e "Contratar" fica', async () => {
    publicSettings.mockResolvedValue({ barterEnabled: false });
    renderCard({ onProposeBarter: vi.fn() });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Propor troca' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Contratar' })).toBeInTheDocument();
  });
});

describe('ServiceCard: visual de marketplace', () => {
  it('a capa é a primeira imagem do portfólio, decorativa e carregada sob demanda', () => {
    renderCard({ service: service({ ownerCoverUrl: 'https://fotos.test/capa.png' }) });
    const img = document.body.querySelector('.svc-cover img');
    expect(img).toHaveAttribute('src', 'https://fotos.test/capa.png');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img!.closest('.svc-cover')).toHaveAttribute('aria-hidden', 'true');
  });

  it('imagem enviada ao Escambo usa a miniatura do cartão; se falhar, vira a foto da categoria', () => {
    const url = '/api/media/2026/10/01J0000000000000000000CAPA.webp';
    renderCard({
      service: service({ ownerCoverUrl: url }),
      categorySlug: 'design',
      categoryName: 'Design',
    });
    const cover = document.body.querySelector('.svc-cover')!;
    expect(cover).toHaveAttribute('data-cover', 'portfolio');
    const img = cover.querySelector('img')!;
    expect(img).toHaveAttribute('src', `${url}?w=480`);
    fireEvent.error(img);
    expect(cover).toHaveAttribute('data-cover', 'category');
    expect(cover).toHaveClass('cover-violet', 'with-photo');
    expect(cover.querySelector('img')).toHaveClass('svc-cover-photo');
  });

  it('sem capa, a foto da categoria (alternando pelo id do serviço) com o nome dela num selo', () => {
    renderCard({
      service: service({ id: 3, ownerCoverUrl: null }),
      categorySlug: 'design',
      categoryName: 'Design',
    });
    const cover = document.body.querySelector('.svc-cover')!;
    expect(cover).toHaveAttribute('data-cover', 'category');
    // Decorativa: sem texto alternativo e fora da leitura (o selo diz que é da categoria).
    expect(cover).toHaveAttribute('aria-hidden', 'true');
    const img = cover.querySelector('img')!;
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('src', '/img/pessoas/fotografa-400.webp');
    expect(img.getAttribute('srcset')).toContain('/img/pessoas/fotografa.webp 800w');
    expect(cover.querySelector('.svc-cover-cat')).toHaveTextContent('Design');
  });

  it('sem o nome da categoria, a foto vai sem selo', () => {
    renderCard({ service: service({ id: 1, ownerCoverUrl: null }), categorySlug: 'marketing' });
    const cover = document.body.querySelector('.svc-cover')!;
    expect(cover.querySelector('img')).toHaveAttribute('src', '/img/pessoas/social-media-400.webp');
    expect(cover.querySelector('.svc-cover-cat')).toBeNull();
  });

  it('sem capa nem categoria conhecida, o desenho neutro', () => {
    renderCard({ categorySlug: 'categoria-nova' });
    expect(document.body.querySelector('.svc-cover')).toHaveClass('cover-neutral');
    expect(document.body.querySelector('.svc-cover')).toHaveAttribute('data-cover', 'icon');
    expect(document.body.querySelector('.svc-cover img')).toBeNull();
  });

  it('no perfil de quem presta (sem o nome no card), a capa continua sendo o portfólio dele', () => {
    renderCard({
      showOwner: false,
      service: service({ ownerCoverUrl: 'https://fotos.test/capa.png' }),
      categorySlug: 'design',
    });
    expect(document.body.querySelector('.svc-cover img')).toHaveAttribute(
      'src',
      'https://fotos.test/capa.png',
    );
  });

  it('a cidade de quem presta aparece ao lado do nome, com o prazo nos detalhes', () => {
    renderCard({ service: service({ ownerCity: 'Joinville' }) });
    expect(screen.getByText('Joinville')).toBeInTheDocument();
    expect(screen.getByText('5 dias')).toBeInTheDocument();
  });

  it('na busca por proximidade, a distância toma o lugar da cidade', () => {
    renderCard({ service: service({ ownerCity: 'Joinville', distanceKm: 0.6 }) });
    expect(screen.getByText('0.6 km de você')).toBeInTheDocument();
    expect(screen.queryByText('Joinville')).not.toBeInTheDocument();
  });

  it('"a partir de" antes do preço; "a combinar" sozinho', () => {
    renderCard();
    expect(screen.getByText('a partir de')).toBeInTheDocument();
    expect(screen.getByText('R$ 150,00')).toBeInTheDocument();
  });

  it('"a combinar" não leva "a partir de"', () => {
    renderCard({ service: service({ priceType: 'negotiable', price: null }) });
    expect(screen.getByText('a combinar')).toBeInTheDocument();
    expect(screen.queryByText('a partir de')).not.toBeInTheDocument();
  });

  it('quem ainda não tem avaliação aparece como "Novo", com a nota zero para o leitor de tela', () => {
    renderCard({ service: service({ ownerRating: 0, ownerReviews: 0 }) });
    expect(screen.getByRole('img', { name: '0.0 de 5, 0 avaliações' })).toHaveTextContent('Novo');
  });

  it('"Aceita troca" nos serviços dos outros, no ar e com a troca ligada', async () => {
    renderCard();
    expect(await screen.findByText('Aceita troca')).toBeInTheDocument();
  });

  it('meu serviço e serviço pausado não levam "Aceita troca"', async () => {
    renderCard({ mine: true });
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Aceita troca')).not.toBeInTheDocument();
  });

  it('serviço dos outros, mas pausado, também não', async () => {
    renderCard({ service: service({ isActive: false }) });
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Aceita troca')).not.toBeInTheDocument();
    expect(screen.getByText('Pausado')).toBeInTheDocument();
  });

  it('com a troca desligada, nada de "Aceita troca"', async () => {
    publicSettings.mockResolvedValue({ barterEnabled: false });
    renderCard();
    await waitFor(() => expect(screen.queryByText('Aceita troca')).not.toBeInTheDocument());
    expect(publicSettings).toHaveBeenCalledTimes(1);
  });

  it('compacto (carrossel): sem descrição, tags nem botões; o título continua sendo o link', () => {
    renderCard({
      compact: true,
      service: service({ tags: ['figma'] }),
      onToggleFavorite: vi.fn(),
      onProposeBarter: vi.fn(),
    });
    expect(screen.getByRole('link', { name: 'Logo profissional' })).toHaveAttribute(
      'href',
      '/servicos/5',
    );
    expect(screen.queryByText('Crio a identidade visual da sua marca.')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Tags' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contratar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propor troca' })).not.toBeInTheDocument();
  });

  it('o card é um artigo com o título como cabeçalho de nível 3', () => {
    renderCard();
    const heading = screen.getByRole('heading', { level: 3, name: 'Logo profissional' });
    expect(heading.closest('article')).toHaveClass('card', 'service', 'svc-card');
  });
});
