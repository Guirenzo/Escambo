import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { MAINTENANCE_EVENT } from './lib/api';

/**
 * As rotas do app: o que é público, o que pede sessão, para onde o login volta, quem entra no
 * admin e quando o endereço da sala é válido. As telas grandes têm os próprios testes; aqui elas
 * são substituídas por marcadores, porque a regra em teste é QUAL tela cada endereço abre. A
 * guarda de rota, o modo de manutenção, as páginas legais e a tela de "não existe" são as reais.
 */

const auth = {
  user: null as { id: number; role: string } | null,
  loading: false,
};
vi.mock('./lib/auth', () => ({ useAuth: () => auth }));

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return {
    ...actual,
    api: { publicSettings: () => Promise.resolve({ maintenanceMode: false }) },
  };
});

vi.mock('./features/shell/Shell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    Shell: () => (
      <div>
        <nav aria-label="Principal">menu</nav>
        <Outlet />
      </div>
    ),
  };
});
vi.mock('./features/auth/LoginForm', () => ({ LoginForm: () => <h1>Entrar</h1> }));
vi.mock('./features/auth/AccountViews', () => ({
  ForgotPasswordView: () => <h1>Esqueci a senha</h1>,
  ResetPasswordView: () => <h1>Redefinir senha</h1>,
  VerifyEmailView: () => <h1>Verificar e-mail</h1>,
}));
vi.mock('./features/views/InicioView', () => ({ InicioView: () => <h1>Início</h1> }));
vi.mock('./features/views/ServicosView', () => ({ ServicosView: () => <h1>Serviços</h1> }));
vi.mock('./features/views/TrocasView', () => ({ TrocasView: () => <h1>Trocas</h1> }));
vi.mock('./features/views/RankingView', () => ({ RankingView: () => <h1>Ranking</h1> }));
vi.mock('./features/views/CarteiraView', () => ({ CarteiraView: () => <h1>Carteira</h1> }));
vi.mock('./features/views/NotificacoesView', () => ({
  NotificacoesView: () => <h1>Notificações</h1>,
}));
vi.mock('./features/views/PerfilView', () => ({ PerfilView: () => <h1>Perfil</h1> }));
vi.mock('./features/views/AdminView', () => ({ AdminView: () => <h1>Administração</h1> }));
vi.mock('./features/views/FreelancerView', async () => {
  const { useParams } = await import('react-router-dom');
  return {
    FreelancerView: () => {
      const { ulid } = useParams();
      return <h1>Freelancer {ulid}</h1>;
    },
  };
});
vi.mock('./features/views/SalaContratoView', () => ({
  SalaContratoView: ({ contractId, onBack }: { contractId: number; onBack: () => void }) => (
    <>
      <h1>Sala da contratação {String(contractId)}</h1>
      <button type="button" onClick={onBack}>
        Voltar
      </button>
    </>
  ),
}));

/** Abre o app num endereço, como quem digita a URL (o `state` é o que a guarda de rota guarda). */
function visit(path: string, state?: unknown) {
  window.history.pushState(state === undefined ? null : { usr: state, key: 'teste' }, '', path);
  // gcTime infinito: a consulta dos parâmetros não deixa relógio de limpeza pendurado no fim.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  );
  const { rerender } = render(tree());
  /** A sessão mudou (entrou ou saiu): o app desenha de novo com o usuário atual. */
  return { sessionChanged: () => rerender(tree()) };
}

const heading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? '';
const here = (): string => window.location.pathname + window.location.search + window.location.hash;

beforeEach(() => {
  auth.user = { id: 1, role: 'client' };
  auth.loading = false;
});

describe('App: rotas públicas', () => {
  it.each([
    ['/esqueci-senha', 'Esqueci a senha'],
    ['/redefinir-senha', 'Redefinir senha'],
    ['/verificar-email', 'Verificar e-mail'],
    ['/termos', 'Termos de Uso'],
    ['/privacidade', 'Política de Privacidade'],
  ])('%s abre sem sessão e fora do menu do app', (path, title) => {
    auth.user = null;
    visit(path);
    expect(heading()).toBe(title);
    expect(here()).toBe(path);
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument();
  });

  it('endereço que não existe mostra a página de "não existe", sem mandar para a home', () => {
    visit('/nao-existe/aqui');
    expect(heading()).toBe('Esta página não existe');
    expect(here()).toBe('/nao-existe/aqui');
  });

  it('endereço que não existe continua assim mesmo sem sessão (não vira login)', () => {
    auth.user = null;
    visit('/nao-existe');
    expect(heading()).toBe('Esta página não existe');
    expect(here()).toBe('/nao-existe');
  });
});

describe('App: /login', () => {
  it('sem sessão mostra o formulário de entrada', () => {
    auth.user = null;
    visit('/login');
    expect(heading()).toBe('Entrar');
    expect(here()).toBe('/login');
  });

  it('enquanto a sessão é conferida, mostra o carregando em vez do formulário', () => {
    auth.user = null;
    auth.loading = true;
    visit('/login');
    expect(screen.getByRole('status', { name: 'Carregando…' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('já com sessão, vai para a home', () => {
    visit('/login');
    expect(heading()).toBe('Início');
    expect(here()).toBe('/');
  });

  it('já com sessão, volta para onde a guarda mandou, com busca e âncora', () => {
    auth.user = { id: 9, role: 'admin' };
    visit('/login', { from: '/admin?aba=saude#health-title' });
    expect(heading()).toBe('Administração');
    expect(here()).toBe('/admin?aba=saude#health-title');
  });

  it('nunca volta para fora do app: destino de outro site vira a home', () => {
    visit('/login', { from: '//evil.example/roubo' });
    expect(heading()).toBe('Início');
    expect(here()).toBe('/');
  });
});

describe('App: rotas com sessão', () => {
  it.each([
    ['/', 'Início'],
    ['/servicos', 'Serviços'],
    ['/trocas', 'Trocas'],
    ['/ranking', 'Ranking'],
    ['/carteira', 'Carteira'],
    ['/notificacoes', 'Notificações'],
    ['/perfil', 'Perfil'],
    ['/freelancers/01ARZ3NDEKTSV4RRFFQ69G5FAV', 'Freelancer 01ARZ3NDEKTSV4RRFFQ69G5FAV'],
  ])('%s abre a tela dentro do menu do app', (path, title) => {
    visit(path);
    expect(heading()).toBe(title);
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeInTheDocument();
    expect(here()).toBe(path);
  });

  it('sem sessão, a rota protegida manda para o login', () => {
    auth.user = null;
    visit('/carteira?aba=saques');
    expect(heading()).toBe('Entrar');
    expect(here()).toBe('/login');
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument();
  });

  it('depois de entrar, volta para a tela que a pessoa pediu, com a busca', () => {
    auth.user = null;
    const { sessionChanged } = visit('/carteira?aba=saques');
    expect(heading()).toBe('Entrar');
    auth.user = { id: 1, role: 'client' };
    sessionChanged();
    expect(heading()).toBe('Carteira');
    expect(here()).toBe('/carteira?aba=saques');
  });

  it('enquanto a sessão é conferida, a rota protegida mostra o carregando', () => {
    auth.user = null;
    auth.loading = true;
    visit('/carteira');
    expect(screen.getByRole('status', { name: 'Carregando…' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(here()).toBe('/carteira');
  });
});

describe('App: /admin', () => {
  it('administrador entra', () => {
    auth.user = { id: 9, role: 'admin' };
    visit('/admin');
    expect(heading()).toBe('Administração');
    expect(here()).toBe('/admin');
  });

  it.each(['client', 'freelancer'])('%s volta para a home', (role) => {
    auth.user = { id: 1, role };
    visit('/admin');
    expect(heading()).toBe('Início');
    expect(here()).toBe('/');
  });
});

describe('App: /contratos/:id', () => {
  it('abre a sala com o id do endereço como número', () => {
    visit('/contratos/12');
    expect(heading()).toBe('Sala da contratação 12');
    expect(here()).toBe('/contratos/12');
  });

  it.each(['abc', '0', '-3', '1.5'])('id inválido (%s) volta para a home', (id) => {
    visit(`/contratos/${id}`);
    expect(heading()).toBe('Início');
    expect(here()).toBe('/');
  });

  it('o voltar da sala retorna à tela de onde a pessoa veio', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/carteira');
    visit('/contratos/12');
    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Carteira' })).toBeInTheDocument();
    expect(here()).toBe('/carteira');
  });
});

describe('App: redirecionamentos', () => {
  it.each([
    ['/login', 'login já com sessão'],
    ['/admin', 'admin para quem não é admin'],
    ['/contratos/abc', 'sala com id inválido'],
  ])(
    '%s (%s) troca o endereço sem empilhar: o voltar do navegador leva à tela anterior',
    async (path) => {
      window.history.pushState(null, '', '/carteira');
      visit(path);
      expect(heading()).toBe('Início');
      window.history.back();
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Carteira' }),
      ).toBeInTheDocument();
      expect(here()).toBe('/carteira');
    },
  );
});

describe('App: leitor de tela', () => {
  it('a troca de tela é anunciada com o título da página nova', async () => {
    auth.user = null;
    visit('/termos');
    expect(await screen.findByText('Termos de Uso · Escambo')).toBeInTheDocument();
  });
});

describe('App: manutenção', () => {
  it('o 503 de manutenção troca qualquer tela pela de manutenção', () => {
    visit('/carteira');
    expect(heading()).toBe('Carteira');
    act(() => {
      window.dispatchEvent(new Event(MAINTENANCE_EVENT));
    });
    expect(heading()).toBe('Estamos em manutenção');
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument();
  });
});
