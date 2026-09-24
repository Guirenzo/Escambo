import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Spinner } from './ui';

/**
 * Para onde o login volta: o `from` que a guarda guardou, se for um caminho do próprio app
 * (`/x`, nunca `//outro-site` nem um esquema); senão a home.
 */
export const backTo = (state: unknown): string => {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && /^\/(?!\/)/.test(from) ? from : '/';
};

/**
 * Guarda de rota: sem sessão → /login (lembrando de onde veio, com busca e âncora: o link do
 * relatório da moderação aponta para /admin#health-title); carregando → spinner.
 */
export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="splash">
        <Spinner />
      </div>
    );
  if (!user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search + location.hash }}
      />
    );
  return <Outlet />;
}
