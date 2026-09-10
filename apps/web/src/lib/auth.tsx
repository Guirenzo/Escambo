import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LoginRequest, PublicUser, RegisterRequest } from '@escambo/types';
import { api, getRefreshToken, getToken, SESSION_EXPIRED_EVENT, setSession } from './api';
import { disconnectSocket } from './socket';
import { LEGAL_VERSION } from '../features/legal/content';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  error: string | null;
  login: (input: LoginRequest) => Promise<void>;
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

  // Sessão salva: valida (o client renova o access token sozinho se tiver vencido).
  useEffect(() => {
    if (!getToken() && !getRefreshToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);

  // O client HTTP avisa quando a renovação falha (refresh token vencido/revogado).
  useEffect(() => {
    const onExpired = (): void => {
      setUser(null);
      disconnectSocket();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  async function login(input: LoginRequest): Promise<void> {
    setError(null);
    try {
      const res = await api.login(input);
      setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      setUser(res.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao entrar');
      throw e;
    }
  }

  async function register(input: RegisterRequest): Promise<void> {
    setError(null);
    try {
      await api.register(input);
      await login({ email: input.email, password: input.password });
      // Consentimento LGPD com a versão vigente dos documentos (melhor esforço, não bloqueia).
      await Promise.all(
        (['terms_of_use', 'privacy_policy'] as const).map((type) =>
          api
            .recordConsent({ type, version: LEGAL_VERSION, accepted: true })
            .catch(() => undefined),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao cadastrar');
      throw e;
    }
  }

  async function refreshUser(): Promise<void> {
    if (!getToken() && !getRefreshToken()) return;
    try {
      setUser(await api.me());
    } catch {
      /* sessão inválida: o client HTTP já avisa via SESSION_EXPIRED_EVENT */
    }
  }

  /** Sai: revoga o refresh token no servidor (melhor esforço) e limpa a sessão local. */
  function logout(): void {
    const refreshToken = getRefreshToken();
    if (refreshToken) void api.logout(refreshToken).catch(() => undefined);
    setSession(null);
    disconnectSocket();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, error, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  return ctx;
}
