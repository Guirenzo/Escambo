import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicUser } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { api, getRefreshToken, getToken, SESSION_EXPIRED_EVENT, setSession, setToken } from './api';
import { AuthProvider, useAuth } from './auth';
import { currentSubscription, lastDeviceEndpoint, rememberDeviceEndpoint } from './push';
import { disconnectSocket } from './socket';
import { browserBrazilZone } from './timezones';

/**
 * A sessão do app: quem está logado, o que a tela vê enquanto a sessão guardada é conferida, e o
 * que entrar, cadastrar e sair fazem com os tokens, o socket e os avisos deste aparelho.
 */

// Só as chamadas HTTP são de mentira; os tokens da sessão são os de verdade (em memória + storage).
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    api: {
      me: vi.fn(),
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      pushUnsubscribe: vi.fn(),
    },
  };
});
vi.mock('./socket', () => ({ disconnectSocket: vi.fn() }));
vi.mock('./push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./push')>();
  return { ...actual, currentSubscription: vi.fn() };
});
vi.mock('./timezones', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./timezones')>();
  return { ...actual, browserBrazilZone: vi.fn() };
});

const apiMock = api as unknown as Record<
  'me' | 'login' | 'register' | 'logout' | 'pushUnsubscribe',
  Mock
>;

const ana = { id: 1, ulid: 'u1', email: 'ana@escambo.test', role: 'freelancer' } as PublicUser;
const tokens = { accessToken: 'acesso-1', refreshToken: 'refresh-1' };

/** O que uma tela mostraria da sessão, com os botões que mexem nela. */
function SessionProbe() {
  const { user, loading, error, login, logout } = useAuth();
  if (loading) return <p>Carregando sessão…</p>;
  return (
    <div>
      <p>{user ? `Olá, ${user.email}` : 'Visitante'}</p>
      {error && <p role="alert">{error}</p>}
      <button
        onClick={() =>
          void login({ email: 'ana@escambo.test', password: 'senha-1' }).catch(() => undefined)
        }
      >
        Entrar
      </button>
      <button onClick={logout}>Sair</button>
    </div>
  );
}

const mountHook = () => renderHook(() => useAuth(), { wrapper: AuthProvider });

/** Monta já com a sessão de Ana conferida. */
async function mountLoggedIn() {
  setSession(tokens);
  apiMock.me.mockResolvedValue(ana);
  const view = mountHook();
  await waitFor(() => expect(view.result.current.user).toEqual(ana));
  return view;
}

beforeEach(() => {
  vi.resetAllMocks();
  setSession(null);
  rememberDeviceEndpoint(null);
  apiMock.logout.mockResolvedValue(undefined);
  apiMock.pushUnsubscribe.mockResolvedValue(undefined);
  vi.mocked(currentSubscription).mockResolvedValue(null);
  vi.mocked(browserBrazilZone).mockReturnValue(null);
});
afterEach(() => {
  setSession(null);
  rememberDeviceEndpoint(null);
});

describe('sessão ao abrir o app', () => {
  it('sem sessão guardada: é visitante na hora, sem consultar a API', () => {
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );
    expect(screen.getByText('Visitante')).toBeInTheDocument();
    expect(apiMock.me).not.toHaveBeenCalled();
  });

  it('com sessão guardada: mostra carregando até a API dizer quem é', async () => {
    setSession(tokens);
    let answer!: (user: PublicUser) => void;
    apiMock.me.mockReturnValue(new Promise<PublicUser>((resolve) => (answer = resolve)));

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );

    expect(screen.getByText('Carregando sessão…')).toBeInTheDocument();
    expect(apiMock.me).toHaveBeenCalledTimes(1);

    await act(async () => answer(ana));

    expect(screen.getByText('Olá, ana@escambo.test')).toBeInTheDocument();
  });

  it('só com o refresh token guardado a sessão ainda é conferida (o client renova o acesso)', async () => {
    setSession(tokens);
    setToken(null);
    expect(getToken()).toBeNull();
    apiMock.me.mockResolvedValue(ana);

    const { result } = mountHook();

    await waitFor(() => expect(result.current.user).toEqual(ana));
    expect(result.current.loading).toBe(false);
  });

  it('sessão guardada que a API recusa é apagada e a pessoa vira visitante', async () => {
    setSession(tokens);
    apiMock.me.mockRejectedValue(new Error('Token inválido'));

    const { result } = mountHook();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });
});

describe('entrar', () => {
  it('manda as credenciais, guarda os dois tokens e mostra o usuário', async () => {
    const user = userEvent.setup();
    apiMock.login.mockResolvedValue({ ...tokens, user: ana });
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByText('Olá, ana@escambo.test')).toBeInTheDocument();
    expect(apiMock.login).toHaveBeenCalledWith({ email: 'ana@escambo.test', password: 'senha-1' });
    expect(getToken()).toBe('acesso-1');
    expect(getRefreshToken()).toBe('refresh-1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('credenciais recusadas: a tela recebe a mensagem da API e ninguém entra', async () => {
    const user = userEvent.setup();
    apiMock.login.mockRejectedValue(new Error('E-mail ou senha incorretos'));
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos');
    expect(screen.getByText('Visitante')).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });

  it('o erro também é devolvido a quem chamou, e some na tentativa seguinte', async () => {
    apiMock.login.mockRejectedValueOnce(new Error('E-mail ou senha incorretos'));
    apiMock.login.mockResolvedValueOnce({ ...tokens, user: ana });
    const { result } = mountHook();

    await act(async () => {
      await expect(result.current.login({ email: 'a@b.com', password: 'x' })).rejects.toThrow(
        'E-mail ou senha incorretos',
      );
    });
    expect(result.current.error).toBe('E-mail ou senha incorretos');

    await act(async () => {
      await result.current.login({ email: 'a@b.com', password: 'certa' });
    });
    expect(result.current.error).toBeNull();
    expect(result.current.user).toEqual(ana);
  });

  it('falha que não é um Error vira a mensagem genérica de entrar', async () => {
    apiMock.login.mockRejectedValue('timeout');
    const { result } = mountHook();
    await act(async () => {
      await expect(result.current.login({ email: 'a@b.com', password: 'x' })).rejects.toBe(
        'timeout',
      );
    });
    expect(result.current.error).toBe('Erro ao entrar');
  });
});

describe('cadastrar', () => {
  const input = {
    email: 'bia@escambo.test',
    password: 'senha-forte',
    legalAccepted: true,
  } as const;

  it('manda o fuso do aparelho junto e já entra com o e-mail e a senha', async () => {
    vi.mocked(browserBrazilZone).mockReturnValue('America/Manaus');
    apiMock.register.mockResolvedValue(ana);
    apiMock.login.mockResolvedValue({ ...tokens, user: ana });
    const { result } = mountHook();

    await act(async () => {
      await result.current.register(input);
    });

    expect(apiMock.register).toHaveBeenCalledWith({ ...input, timezone: 'America/Manaus' });
    // O login não leva o aceite nem o fuso: só as credenciais.
    expect(apiMock.login).toHaveBeenCalledWith({
      email: 'bia@escambo.test',
      password: 'senha-forte',
    });
    expect(result.current.user).toEqual(ana);
    expect(getToken()).toBe('acesso-1');
  });

  it('fuso escolhido no formulário vale mais que o do aparelho', async () => {
    vi.mocked(browserBrazilZone).mockReturnValue('America/Manaus');
    apiMock.register.mockResolvedValue(ana);
    apiMock.login.mockResolvedValue({ ...tokens, user: ana });
    const { result } = mountHook();

    await act(async () => {
      await result.current.register({ ...input, timezone: 'America/Rio_Branco' });
    });

    expect(apiMock.register).toHaveBeenCalledWith({ ...input, timezone: 'America/Rio_Branco' });
  });

  it('aparelho fora do Brasil não manda fuso: a conta nasce no padrão da API', async () => {
    apiMock.register.mockResolvedValue(ana);
    apiMock.login.mockResolvedValue({ ...tokens, user: ana });
    const { result } = mountHook();

    await act(async () => {
      await result.current.register(input);
    });

    expect(apiMock.register).toHaveBeenCalledWith(input);
    expect(apiMock.register.mock.calls[0]![0]).not.toHaveProperty('timezone');
  });

  it('cadastro recusado: mostra a mensagem da API e nem tenta entrar', async () => {
    apiMock.register.mockRejectedValue(new Error('E-mail já cadastrado'));
    const { result } = mountHook();

    await act(async () => {
      await expect(result.current.register(input)).rejects.toThrow('E-mail já cadastrado');
    });

    expect(result.current.error).toBe('E-mail já cadastrado');
    expect(apiMock.login).not.toHaveBeenCalled();
    expect(result.current.user).toBeNull();
  });

  it('falha que não é um Error vira a mensagem genérica de cadastrar', async () => {
    apiMock.register.mockRejectedValue({ status: 500 });
    const { result } = mountHook();
    await act(async () => {
      await expect(result.current.register(input)).rejects.toEqual({ status: 500 });
    });
    expect(result.current.error).toBe('Erro ao cadastrar');
  });
});

describe('sair', () => {
  it('desliga os avisos deste aparelho, revoga o refresh token e limpa a sessão', async () => {
    const view = await mountLoggedIn();
    rememberDeviceEndpoint('https://push.example/aparelho-1');
    const unsubscribe = vi.fn().mockResolvedValue(true);
    vi.mocked(currentSubscription).mockResolvedValue({
      unsubscribe,
    } as unknown as PushSubscription);
    // O pedido de desligar precisa sair ainda com a sessão: depois dela apagada, a API recusaria.
    let tokenAtUnsubscribe: string | null = null;
    apiMock.pushUnsubscribe.mockImplementation(async () => {
      tokenAtUnsubscribe = getToken();
    });

    act(() => view.result.current.logout());

    expect(apiMock.pushUnsubscribe).toHaveBeenCalledWith('https://push.example/aparelho-1');
    expect(tokenAtUnsubscribe).toBe('acesso-1');
    expect(apiMock.logout).toHaveBeenCalledWith('refresh-1');
    expect(lastDeviceEndpoint()).toBeNull();
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(disconnectSocket).toHaveBeenCalledTimes(1);
    expect(view.result.current.user).toBeNull();
    // A assinatura do navegador cai junto, para o aparelho não receber aviso de conta nenhuma.
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });

  it('pela tela: clicar em Sair volta a mostrar visitante', async () => {
    const user = userEvent.setup();
    setSession(tokens);
    apiMock.me.mockResolvedValue(ana);
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );
    await screen.findByText('Olá, ana@escambo.test');

    await user.click(screen.getByRole('button', { name: 'Sair' }));

    expect(screen.getByText('Visitante')).toBeInTheDocument();
  });

  it('aparelho sem avisos ligados e sem refresh token: não chama a API à toa', async () => {
    const view = mountHook();

    act(() => view.result.current.logout());

    expect(apiMock.pushUnsubscribe).not.toHaveBeenCalled();
    expect(apiMock.logout).not.toHaveBeenCalled();
    expect(disconnectSocket).toHaveBeenCalledTimes(1);
  });

  it('servidor fora do ar não impede de sair: a sessão local é limpa do mesmo jeito', async () => {
    const view = await mountLoggedIn();
    rememberDeviceEndpoint('https://push.example/aparelho-1');
    apiMock.pushUnsubscribe.mockRejectedValue(new Error('Failed to fetch'));
    apiMock.logout.mockRejectedValue(new Error('Failed to fetch'));
    vi.mocked(currentSubscription).mockRejectedValue(new Error('sem service worker'));

    act(() => view.result.current.logout());
    // As três falhas são engolidas: uma rejeição solta derrubaria o teste.
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.result.current.user).toBeNull();
    expect(getToken()).toBeNull();
    expect(lastDeviceEndpoint()).toBeNull();
  });
});

describe('sessão encerrada pelo cliente HTTP', () => {
  it('o aviso de sessão expirada tira o usuário da tela e derruba o socket', async () => {
    const view = await mountLoggedIn();

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    });

    expect(view.result.current.user).toBeNull();
    expect(disconnectSocket).toHaveBeenCalledTimes(1);
  });

  it('depois de desmontado, o provider não reage mais ao aviso', async () => {
    const view = await mountLoggedIn();
    view.unmount();

    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));

    expect(disconnectSocket).not.toHaveBeenCalled();
  });
});

describe('refreshUser', () => {
  it('recarrega o usuário (ex.: depois de confirmar o e-mail)', async () => {
    const view = await mountLoggedIn();
    const verified = { ...ana, emailVerified: true };
    apiMock.me.mockResolvedValue(verified);

    await act(async () => {
      await view.result.current.refreshUser();
    });

    expect(view.result.current.user).toEqual(verified);
    expect(apiMock.me).toHaveBeenCalledTimes(2);
  });

  it('sem sessão não consulta a API', async () => {
    const view = mountHook();
    await act(async () => {
      await view.result.current.refreshUser();
    });
    expect(apiMock.me).not.toHaveBeenCalled();
    expect(view.result.current.user).toBeNull();
  });

  it('se a consulta falha, mantém o usuário que já estava na tela', async () => {
    const view = await mountLoggedIn();
    apiMock.me.mockRejectedValue(new Error('Failed to fetch'));

    await act(async () => {
      await expect(view.result.current.refreshUser()).resolves.toBeUndefined();
    });

    expect(view.result.current.user).toEqual(ana);
  });
});

describe('useAuth fora do provider', () => {
  it('acusa o uso errado com uma mensagem clara', () => {
    // O React repete o erro no console e o jsdom o reporta na janela: silêncio só neste teste.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const swallow = (e: ErrorEvent): void => e.preventDefault();
    window.addEventListener('error', swallow);
    expect(() => renderHook(() => useAuth())).toThrow(
      'useAuth deve ser usado dentro de <AuthProvider>',
    );
    window.removeEventListener('error', swallow);
    quiet.mockRestore();
  });
});
