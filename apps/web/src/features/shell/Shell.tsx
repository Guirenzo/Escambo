import { ArrowLeftRight, Bell, Briefcase, Home, LogOut, Trophy, User, Wallet, type LucideIcon } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../lib/auth';

const NAV: { to: string; label: string; Icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'Início', Icon: Home, end: true },
  { to: '/servicos', label: 'Serviços', Icon: Briefcase },
  { to: '/trocas', label: 'Trocas', Icon: ArrowLeftRight },
  { to: '/ranking', label: 'Ranking', Icon: Trophy },
  { to: '/carteira', label: 'Carteira', Icon: Wallet },
  { to: '/notificacoes', label: 'Notificações', Icon: Bell },
  { to: '/perfil', label: 'Perfil', Icon: User },
];

const ROLE_LABEL: Record<string, string> = { client: 'Cliente', freelancer: 'Freelancer', admin: 'Admin' };

/** App shell: sidebar fixa à esquerda (marca, navegação, usuário) + área de conteúdo que usa a largura da tela. */
export function Shell() {
  const { user, logout } = useAuth();
  const handle = user?.email?.split('@')[0] ?? '';
  const initial = handle[0]?.toUpperCase() ?? '?';

  return (
    <div className="app">
      <aside className="sidebar">
        <NavLink to="/" end className="brand">
          <span className="brand-mark">
            <ArrowLeftRight size={18} strokeWidth={2.5} />
          </span>
          <span className="brand-name">Escambo</span>
        </NavLink>

        <nav className="side-nav" aria-label="Principal">
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="side-link" title={label}>
              <Icon size={18} strokeWidth={2} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="side-user">
          <span className="avatar sm">{initial}</span>
          <div className="side-user-info">
            <strong title={user?.email}>{handle}</strong>
            <span className="muted tiny">{ROLE_LABEL[user?.role ?? ''] ?? user?.role}</span>
          </div>
          <button className="icon-btn" onClick={logout} title="Sair" aria-label="Sair">
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
