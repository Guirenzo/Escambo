import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../lib/auth';

const NAV: { to: string; label: string; icon: string; end?: boolean }[] = [
  { to: '/', label: 'Início', icon: '🏠', end: true },
  { to: '/servicos', label: 'Serviços', icon: '🗂️' },
  { to: '/trocas', label: 'Trocas', icon: '⇄' },
  { to: '/ranking', label: 'Ranking', icon: '🏆' },
  { to: '/carteira', label: 'Carteira', icon: '💰' },
  { to: '/notificacoes', label: 'Notificações', icon: '🔔' },
  { to: '/perfil', label: 'Perfil', icon: '👤' },
];

/** Layout autenticado: topbar fixa com marca + navegação por rotas reais (URL, deep link, voltar). */
export function Shell() {
  const { user, logout } = useAuth();
  const initial = user?.email?.[0]?.toUpperCase() ?? '?';
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand brand-sm" end>
            <span className="brand-mark">⇄</span>
            <span className="brand-name">Escambo</span>
          </NavLink>
          <nav className="nav" aria-label="Principal">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className="navbtn">
                <span className="ico">{n.icon}</span>
                <span className="lbl">{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="topbar-right">
            <span className="avatar sm user-avatar" title={user?.email}>
              {initial}
            </span>
            <span className="who">{user?.email}</span>
            <button className="ghost" onClick={logout}>
              Sair
            </button>
          </div>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
