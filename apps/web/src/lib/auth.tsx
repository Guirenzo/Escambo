import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LoginRequest, PublicUser, RegisterRequest } from '@escambo/types';
import { api, getToken, setToken } from './api';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  error: string | null;
  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(input: LoginRequest): Promise<void> {
    setError(null);
    try {
      const res = await api.login(input);
      setToken(res.accessToken);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao cadastrar');
      throw e;
    }
  }

  function logout(): void {
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, error, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  return ctx;
}
