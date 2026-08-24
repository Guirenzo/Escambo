import { useState } from 'react';
import type { AuthResponse, LoginRequest } from '@escambo/types';
import { api } from '../../lib/api';

export function useAuth() {
  const [auth, setAuth] = useState<AuthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function login(input: LoginRequest): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setAuth(await api.login(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro desconhecido');
    } finally {
      setLoading(false);
    }
  }

  function logout(): void {
    setAuth(null);
  }

  return { auth, error, loading, login, logout };
}
