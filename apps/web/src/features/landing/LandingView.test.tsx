import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Category, PublicSettings, Service } from '@escambo/types';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingView } from './LandingView';

/**
 * A página inicial pública: o que ela promete tem de bater com as regras da API. Taxa, aprovação
 * automática e saque mínimo vêm dos parâmetros públicos (nunca escritos no código), e sem eles o
 * texto sai sem número; com a troca desligada no painel, a troca some da página. A busca do topo
 * filtra a vitrine de serviços reais sem pedir login.
 */

const settings = { data: undefined as PublicSettings | undefined };
const categories = { data: undefined as Category[] | undefined };
vi.mock('../../lib/hooks', () => ({
  usePublicSettings: () => settings,
  useCategories: () => categories,
}));

const api = vi.hoisted(() => ({ listServices: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: null }) }));

const PUBLIC = {
  platformFeePercentage: 15,
  tacitApprovalDays: 5,
  minWithdrawalAmount: 20,
  barterEnabled: true,
} as PublicSettings;

const CATALOG: Category[] = [
  {
    id: 1,
    parentId: null,
    name: 'Tecnologia',
    slug: 'tecnologia',
    iconUrl: null,
    children: [
      {
        id: 10,
        parentId: 1,
        name: 'Desenvolvimento Web',
        slug: 'desenvolvimento-web',
        iconUrl: null,
        children: [],
      },
    ],
  },
  { id: 2, parentId: null, name: 'Design', slug: 'design', iconUrl: null, children: [] },
  { id: 7, parentId: null, name: 'Jardinagem', slug: 'jardinagem', iconUrl: null, children: [] },
];

const SERVICE: Service = {
  id: 41,
  categoryId: 10,
  ownerId: 9,
  title: 'Landing page em React',
  description: 'Landing page completa.',
  priceType: 'fixed',
  price: 1200,
  deliveryDays: 7,
  isRemote: true,
  isActive: true,
  createdAt: '2026-10-01T12:00:00.000Z',
  ownerUlid: '01BRUNO',
  ownerName: 'Bruno Costa',
  ownerAvatarUrl: null,
  ownerRating: 5,
  ownerReviews: 2,
};

/** Onde o app foi parar depois de um clique num link. */
function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
}

function renderLanding() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LandingView />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** O texto que a pessoa lê, com o espaço inseparável do Intl como espaço comum. */
const text = (el: HTMLElement = document.body): string =>
  (el.textContent ?? '').replace(/\s/g, ' ');

const section = (name: string | RegExp): HTMLElement => screen.getByRole('region', { name });

beforeEach(() => {
  settings.data = PUBLIC;
  categories.data = CATALOG;
  api.listServices.mockReset();
  api.listServices.mockResolvedValue({ items: [SERVICE], page: 1, limit: 8 });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('LandingView: estrutura', () => {
  it('título próprio, um h1, marcos da página e o "pular" como primeiro link', () => {
    renderLanding();
    expect(document.title).toBe('Contrate ou troque serviços · Escambo');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Troque o que você sabe fazer pelo que você precisa.',
    );
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'conteudo');
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getAllByRole('link')[0]).toHaveTextContent('Pular para o conteúdo');
  });

  it('as âncoras do topo levam às seções que existem na página, na ordem delas', () => {
    renderLanding();
    const nav = screen.getByRole('navigation', { name: 'Seções da página' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      'Como funciona',
      'Troca',
      'Garantia',
      'Dúvidas',
    ]);
    for (const a of links) {
      const id = a.getAttribute('href')!.slice(1);
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it('cada seção do corpo é uma região com o título h2 como nome, na ordem da página', () => {
    renderLanding();
    const names = [
      'Descubra serviços',
      'O que dá para contratar (ou trocar)',
      'Do primeiro contato ao pagamento',
      'Três jeitos de fechar negócio',
      'Como funciona uma troca',
      'Combinado é garantido',
      'Perguntas frequentes',
      'Comece com o que você já sabe fazer.',
    ];
    for (const name of names)
      expect(within(section(name)).getByRole('heading', { level: 2, name })).toBeInTheDocument();
    const order = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((t) => names.includes(t ?? ''));
    expect(order).toEqual(names);
  });

  it('as telas do topo são ilustração: legenda que diz isso e nada lido dentro delas', () => {
    renderLanding();
    const figure = screen.getByRole('figure', {
      name: 'Telas do app Escambo. Nomes e valores são ilustrativos.',
    });
    const stage = figure.querySelector('.lp-stage')!;
    expect(stage).toHaveAttribute('aria-hidden', 'true');
    expect(text(stage as HTMLElement)).toContain('Torna: você completa R$ 400');
    expect(text(stage as HTMLElement)).toContain('Pagamento liberado');
    expect(text(stage as HTMLElement)).toContain('Nova proposta de troca');
  });

  it('a faixa de garantias do topo: regras, nenhum número', () => {
    renderLanding();
    const assure = document.querySelector('.lp-assure') as HTMLElement;
    expect(
      within(assure)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Pagamento guardado até você aprovar',
      'Torna calculada pelo app',
      'Disputa com mediação da equipe',
      'Criar conta não custa nada',
    ]);
  });
});

describe('LandingView: regras vindas da API', () => {
  it('com os parâmetros públicos, taxa, prazo e saque mínimo aparecem com o número', () => {
    renderLanding();
    expect(text(section('Três jeitos de fechar negócio'))).toContain(
      '15% sobre o valor, descontados de quem recebe',
    );
    expect(text(section('Três jeitos de fechar negócio'))).toContain(
      'Com torna, 15% só sobre a torna',
    );
    const trade = section('Como funciona uma troca');
    expect(text(trade)).toContain('Troca equilibrada não paga taxa. Com torna, 15% só sobre ela.');
    const calc = within(trade).getByRole('group', { name: 'Simule a torna' });
    expect(text(calc)).toContain('Você completa R$ 400');
    expect(text(calc)).toContain('Taxa de 15%, só sobre a torna− R$ 60');
    expect(text(calc)).toContain('A outra pessoa recebeR$ 340');
    expect(text(section('Do primeiro contato ao pagamento'))).toContain('com 15% de taxa');
    expect(text(section('Combinado é garantido'))).toContain(
      'Se você não responder em 5 dias, a entrega é aprovada automaticamente.',
    );
    const faq = text(section('Perguntas frequentes'));
    expect(faq).toContain('a plataforma fica com 15% do valor, descontados de quem recebe');
    expect(faq).toContain('Na troca, a taxa incide só sobre a torna.');
    expect(faq).toContain('Sem resposta do cliente em 5 dias, a aprovação é automática.');
    expect(faq).toContain('O saque mínimo é de R$ 20.');
  });

  it('a conta da calculadora segue a taxa do painel', () => {
    settings.data = { ...PUBLIC, platformFeePercentage: 10, tacitApprovalDays: 1 };
    renderLanding();
    const calc = screen.getByRole('group', { name: 'Simule a torna' });
    expect(text(calc)).toContain('Taxa de 10%, só sobre a torna− R$ 40');
    expect(text(calc)).toContain('R$ 360');
    expect(text(section('Combinado é garantido'))).toContain('Se você não responder em 1 dia,');
  });

  it('sem os parâmetros (carregando ou erro), nenhum número de regra: o texto cai na versão sem número', () => {
    settings.data = undefined;
    renderLanding();
    const page = text(document.querySelector('main') as HTMLElement);
    expect(page).not.toMatch(/\d+%/);
    expect(page).not.toContain('saque mínimo');
    expect(text(section('Três jeitos de fechar negócio'))).toContain(
      'Uma taxa sobre o valor, descontada de quem recebe',
    );
    expect(text(section('Três jeitos de fechar negócio'))).toContain(
      'Com torna, a taxa vale só sobre a torna',
    );
    expect(text(section('Como funciona uma troca'))).toContain(
      'Com torna, a taxa vale só sobre ela.',
    );
    const calc = screen.getByRole('group', { name: 'Simule a torna' });
    expect(text(calc)).toContain('Quem recebe a torna fica comR$ 400 menos a taxa');
    expect(text(section('Do primeiro contato ao pagamento'))).toContain(
      'com a taxa da plataforma só sobre ela',
    );
    expect(text(section('Combinado é garantido'))).toContain(
      'Sem resposta no prazo, a entrega é aprovada automaticamente.',
    );
    const faq = text(section('Perguntas frequentes'));
    expect(faq).toContain('a plataforma fica com uma parte do valor');
    expect(faq).toContain('Sem resposta do cliente no prazo, a aprovação é automática.');
  });

  it('com a troca desligada no painel, a troca some (topo, seção, âncora, aba, dúvida e textos)', () => {
    settings.data = { ...PUBLIC, barterEnabled: false };
    renderLanding();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Contrate freelancers com o pagamento protegido.',
    );
    expect(document.getElementById('troca')).toBeNull();
    const figure = screen.getByRole('figure', { name: /Telas do app Escambo/ });
    expect(text(figure)).not.toContain('Proposta de troca');
    expect(text(figure)).toContain('Valor em garantia');
    expect(
      within(screen.getByRole('navigation', { name: 'Seções da página' })).queryByRole('link', {
        name: 'Troca',
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver como funciona' })).toHaveAttribute(
      'href',
      '#como-funciona',
    );
    expect(screen.queryByRole('tab', { name: 'Trocar' })).not.toBeInTheDocument();
    expect(
      within(section('Dois jeitos de fechar negócio')).queryByRole('heading', {
        name: 'Troca de serviços',
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'O que dá para contratar' })).toBeInTheDocument();
    expect(screen.queryByText('O que é torna?')).not.toBeInTheDocument();
    expect(text(section('Perguntas frequentes'))).not.toContain('torna');
    expect(text(section('Comece com o que você já sabe fazer.'))).toContain(
      'faça a primeira contratação',
    );
    expect(text()).toContain('Pagamento por etapas em projetos grandes');
  });
});

describe('LandingView: busca do topo e vitrine', () => {
  it('a vitrine abre com os serviços reais, sem filtro, e o cartão leva ao serviço', async () => {
    renderLanding();
    const vitrine = section('Descubra serviços');
    const card = await within(vitrine).findByRole('link', { name: 'Landing page em React' });
    expect(card).toHaveAttribute('href', '/servicos/41');
    expect(api.listServices).toHaveBeenCalledWith({ limit: 8 });
  });

  it('buscar filtra a vitrine pelo texto e leva o foco ao título dela', async () => {
    const user = userEvent.setup();
    renderLanding();
    await screen.findByRole('link', { name: 'Landing page em React' });
    const search = screen.getByRole('search', { name: 'Buscar serviços' });
    await user.type(within(search).getByLabelText('O que você precisa?'), '  logo  ');
    await user.click(within(search).getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith({ q: 'logo', limit: 8 }));
    const title = screen.getByRole('heading', { level: 2, name: 'Resultados da busca' });
    expect(title).toHaveFocus();
    expect(title.scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole('list', { name: 'Filtros da vitrine' })).toHaveTextContent('“logo”');
  });

  it('os atalhos são as categorias raiz: um clique filtra, outro desfaz', async () => {
    const user = userEvent.setup();
    renderLanding();
    const shortcuts = screen.getByRole('group', { name: 'Atalhos' });
    expect(
      within(shortcuts)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Tecnologia', 'Design', 'Jardinagem']);
    const design = within(shortcuts).getByRole('button', { name: 'Design' });
    expect(design).toHaveAttribute('aria-pressed', 'false');
    await user.click(design);
    expect(design).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(api.listServices).toHaveBeenLastCalledWith({ categoryId: 2, limit: 8 }),
    );
    expect(screen.getByRole('link', { name: 'Ver todos os serviços' })).toHaveAttribute(
      'href',
      '/servicos?categoria=2',
    );
    await user.click(design);
    expect(design).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith({ limit: 8 }));
  });

  it('tirar a busca pelo "x" do filtro também limpa o campo do topo', async () => {
    const user = userEvent.setup();
    renderLanding();
    const field = screen.getByLabelText('O que você precisa?');
    await user.type(field, 'logo{Enter}');
    await user.click(screen.getByRole('button', { name: 'Tirar a busca “logo”' }));
    expect(field).toHaveValue('');
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith({ limit: 8 }));
  });

  it('sem categorias, sem atalhos e sem a seção de categorias', () => {
    categories.data = undefined;
    renderLanding();
    expect(screen.queryByRole('group', { name: 'Atalhos' })).not.toBeInTheDocument();
    expect(document.getElementById('categorias')).toBeNull();
  });
});

describe('LandingView: categorias', () => {
  it('as categorias reais viram blocos com foto, e as subcategorias, atalhos', () => {
    renderLanding();
    const cats = section('O que dá para contratar (ou trocar)');
    expect(within(cats).getByRole('link', { name: 'Tecnologia' })).toHaveAttribute(
      'href',
      '/servicos?categoria=1',
    );
    expect(within(cats).getByRole('link', { name: 'Desenvolvimento Web' })).toHaveAttribute(
      'href',
      '/servicos?categoria=10',
    );
    expect(within(cats).getByRole('link', { name: 'Desenvolvimento Web' })).toHaveClass('lp-chip');
    // Categoria nova (sem foto própria) também aparece, com o desenho da categoria.
    expect(within(cats).getByRole('link', { name: 'Jardinagem' })).toHaveAttribute(
      'href',
      '/servicos?categoria=7',
    );
    expect(within(cats).getByRole('list', { name: 'Subcategorias' })).toBeInTheDocument();
  });
});

describe('LandingView: chamadas e navegação', () => {
  it('criar conta leva ao cadastro, já com o perfil quando a pessoa escolheu o lado', async () => {
    const user = userEvent.setup();
    renderLanding();
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: 'Criar conta' }),
    ).toHaveAttribute('href', '/cadastro');
    expect(screen.getByRole('link', { name: /Criar conta de cliente/ })).toHaveAttribute(
      'href',
      '/cadastro?perfil=cliente',
    );
    await user.click(screen.getByRole('link', { name: /Criar conta de freelancer/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/cadastro?perfil=freelancer');
  });

  it('entrar, documentos, categorias e o rodapé', () => {
    renderLanding();
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'Termos de Uso' })).toHaveAttribute(
      'href',
      '/termos',
    );
    expect(within(footer).getByRole('link', { name: 'Política de Privacidade' })).toHaveAttribute(
      'href',
      '/privacidade',
    );
    expect(within(footer).getByRole('link', { name: 'Esqueci minha senha' })).toHaveAttribute(
      'href',
      '/esqueci-senha',
    );
    expect(within(footer).getByRole('link', { name: 'Design' })).toHaveAttribute(
      'href',
      '/servicos?categoria=2',
    );
    expect(within(footer).getByRole('link', { name: 'Serviços' })).toHaveAttribute(
      'href',
      '#vitrine',
    );
    expect(within(footer).getByRole('link', { name: 'Código-fonte no GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/Guirenzo/Escambo',
    );
    expect(text(footer)).toContain(`© ${new Date().getFullYear()} Escambo`);
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: 'Entrar' }),
    ).toHaveAttribute('href', '/login');
  });

  it('as dúvidas são <details> nativos, fechados de início, e abrem pelo resumo', async () => {
    const user = userEvent.setup();
    renderLanding();
    const faq = section('Perguntas frequentes');
    const items = faq.querySelectorAll('details');
    expect(items).toHaveLength(8);
    expect([...items].every((d) => !d.open)).toBe(true);
    await user.click(within(faq).getByText('Posso contratar e também oferecer serviços?'));
    expect(items[5]!.open).toBe(true);
    expect(text(items[5]!)).toContain('A mesma conta contrata e publica serviços');
  });

  it('saindo da landing, a tela seguinte abre no topo', () => {
    const { unmount } = renderLanding();
    document.documentElement.scrollTop = 1200;
    unmount();
    expect(document.documentElement.scrollTop).toBe(0);
  });
});
