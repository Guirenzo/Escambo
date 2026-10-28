import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  LoginRequest,
  MfaChallenge,
  MfaLoginRequest,
  PublicUser,
  RegisterRequest,
} from '@escambo/types';
import {
  ACCOUNT_STATUS_EVENT,
  api,
  EMAIL_UNVERIFIED_EVENT,
  getRefreshToken,
  getToken,
  isAccountStatus,
  isMfaChallenge,
  SESSION_EXPIRED_EVENT,
  setSession,
} from './api';
import { disconnectSocket, getSocket } from './socket';
import { currentSubscription, lastDeviceEndpoint, rememberDeviceEndpoint } from './push';
import { browserBrazilZone } from './timezones';
import { AccountAccessProvider } from './account-access';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  error: string | null;
  /**
   * Entra com e-mail e senha. Conta com verificação em duas etapas: devolve o pedido do segundo
   * fator e ainda não abre a sessão (ela sai de `loginMfa`); sem 2FA, entra e devolve null.
   */
  login: (input: LoginRequest) => Promise<MfaChallenge | null>;
  /** Segundo passo do login (RF-090): o erro fica com quem chama, que o mostra junto do campo. */
  loginMfa: (input: MfaLoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => void;
  /** Recarrega o usuário da sessão (ex.: depois de confirmar o e-mail). */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const statusGeneration = useRef(0);
  const refreshingUser = useRef<Promise<void> | null>(null);

  const refreshUser = useCallback(async (): Promise<void> => {
    if (!getToken() && !getRefreshToken()) return;
    if (refreshingUser.current) return refreshingUser.current;
    const session = generation.current;
    const status = statusGeneration.current;
    const request = (async () => {
      try {
        const next = await api.me();
        if (session !== generation.current || (!getToken() && !getRefreshToken())) return;
        setUser((current) =>
          status === statusGeneration.current || !current
            ? next
            : { ...next, status: current.status },
        );
      } catch {
        /* O client HTTP avisa quando a sessão realmente deixa de ser válida. */
      }
    })();
    refreshingUser.current = request;
    await request;
    if (refreshingUser.current === request) refreshingUser.current = null;
  }, []);

  // Sessão salva: valida (o client renova o access token sozinho se tiver vencido).
  useEffect(() => {
    if (!getToken() && !getRefreshToken()) {
      setLoading(false);
      return;
    }
    let mounted = true;
    const session = generation.current;
    api
      .me()
      .then((next) => {
        if (mounted && session === generation.current && (getToken() || getRefreshToken()))
          setUser(next);
      })
      .catch(() => {
        if (mounted && session === generation.current) setSession(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // O client HTTP avisa quando a renovação falha (refresh token vencido/revogado).
  useEffect(() => {
    const onExpired = (): void => {
      generation.current += 1;
      refreshingUser.current = null;
      setUser(null);
      disconnectSocket();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // Cabeçalho HTTP e Socket.IO mantêm a tela coerente com a moderação sem derrubar suspensos.
  useEffect(() => {
    const onStatus = (event: Event): void => {
      const status = (event as CustomEvent<unknown>).detail;
      if (!isAccountStatus(status) || (!getToken() && !getRefreshToken())) return;
      statusGeneration.current += 1;
      if (status === 'banned') {
        generation.current += 1;
        setSession(null);
        disconnectSocket();
        setUser(null);
      } else setUser((current) => (current ? { ...current, status } : current));
    };
    window.addEventListener(ACCOUNT_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(ACCOUNT_STATUS_EVENT, onStatus);
  }, []);

  // A API recusou uma ação por e-mail não confirmado (RF-006): a tela achava que estava confirmado
  // (sessão antiga), então passa a mostrar os avisos no lugar das ações críticas.
  useEffect(() => {
    const onUnverified = (): void => {
      if (!getToken() && !getRefreshToken()) return;
      setUser((current) =>
        current && current.emailVerified ? { ...current, emailVerified: false } : current,
      );
    };
    window.addEventListener(EMAIL_UNVERIFIED_EVENT, onUnverified);
    return () => window.removeEventListener(EMAIL_UNVERIFIED_EVENT, onUnverified);
  }, []);

  const userId = user?.id;
  useEffect(() => {
    if (userId === undefined) return;
    const socket = getSocket();
    const onStatus = (payload: { status?: unknown }): void => {
      if (isAccountStatus(payload?.status)) {
        window.dispatchEvent(new CustomEvent(ACCOUNT_STATUS_EVENT, { detail: payload.status }));
      }
    };
    const refreshVisible = (): void => {
      if (document.visibilityState !== 'hidden') void refreshUser();
    };
    socket.on('account:status', onStatus);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    const timer = window.setInterval(refreshVisible, 30_000);
    return () => {
      socket.off('account:status', onStatus);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.clearInterval(timer);
    };
  }, [userId, refreshUser]);

  async function login(input: LoginRequest): Promise<MfaChallenge | null> {
    const session = ++generation.current;
    refreshingUser.current = null;
    setError(null);
    try {
      const res = await api.login(input);
      if (session !== generation.current) return null;
      if (isMfaChallenge(res)) return res;
      setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      setUser(res.user);
      return null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao entrar');
      throw e;
    }
  }

  /** Com o código certo, a sessão abre como no login sem 2FA. */
  async function loginMfa(input: MfaLoginRequest): Promise<void> {
    const session = ++generation.current;
    refreshingUser.current = null;
    const res = await api.loginMfa(input);
    if (session !== generation.current) return;
    setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    setUser(res.user);
  }

  async function register(input: RegisterRequest): Promise<void> {
    setError(null);
    try {
      // O fuso do aparelho vai junto (ADR 51): a conta já nasce no relógio de quem se cadastra.
      const timezone = input.timezone ?? browserBrazilZone() ?? undefined;
      // O aceite vai no próprio cadastro e a API grava o consentimento na versão vigente (ADR 54):
      // toda conta nasce com a trilha, sem depender de uma segunda requisição do cliente.
      await api.register(timezone ? { ...input, timezone } : input);
      await login({ email: input.email, password: input.password });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao cadastrar');
      throw e;
    }
  }

  /** Sai: revoga o refresh token no servidor (melhor esforço) e limpa a sessão local. */
  function logout(): void {
    generation.current += 1;
    refreshingUser.current = null;
    const refreshToken = getRefreshToken();
    // Sair desliga os avisos deste aparelho (ADR 52): o pedido sai antes de a sessão ser apagada,
    // e a assinatura do navegador cai junto para o aparelho não receber aviso de conta nenhuma.
    const pushEndpoint = lastDeviceEndpoint();
    if (pushEndpoint) void api.pushUnsubscribe(pushEndpoint).catch(() => undefined);
    rememberDeviceEndpoint(null);
    void currentSubscription()
      .then((sub) => sub?.unsubscribe())
      .catch(() => undefined);
    if (refreshToken) void api.logout(refreshToken).catch(() => undefined);
    setSession(null);
    disconnectSocket();
    setUser(null);
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, error, login, loginMfa, register, logout, refreshUser }}
    >
      <AccountAccessProvider status={user?.status}>{children}</AccountAccessProvider>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  return ctx;
}
