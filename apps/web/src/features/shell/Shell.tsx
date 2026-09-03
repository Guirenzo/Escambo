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

/** Layout autenticado: topbar + navegação por rotas reais (URL, deep link, voltar). */
export function Shell() {
  const { user, logout } = useAuth();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="logo">Escambo</span>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="navbtn">
              <span className="ico">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="who">{user?.email}</span>
          <button className="ghost" onClick={logout}>
            Sair
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
