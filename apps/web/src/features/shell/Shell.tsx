import {
  ArrowLeftRight,
  Bell,
  Briefcase,
  Home,
  LogOut,
  LifeBuoy,
  MailWarning,
  Menu,
  ShieldAlert,
  Trophy,
  User,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { displayName } from '../../lib/format';
import { Avatar } from '../../components/Avatar';
import { SkipLink } from '../../components/ui';
import { useConsents, useNotifications, useProfilesMe } from '../../lib/hooks';
import { useRealtimeNotifications } from '../../lib/realtime';
import { browserBrazilZone } from '../../lib/timezones';
import { useToast } from '../../lib/toast';
import { pickBanner } from './banners';
import { LegalUpdateBanner } from './LegalUpdateBanner';
import { TimezoneBanner } from './TimezoneBanner';
import { TopBar, unreadLabel } from './TopBar';

/** Conta ainda sem e-mail confirmado: lembrete discreto com reenvio do link. */
function VerifyEmailBanner({ email }: { email: string }) {
  const toast = useToast();
  const [sending, setSending] = useState(false);
  async function resend(): Promise<void> {
    setSending(true);
    try {
      await api.resendVerification();
      toast.success(`Link reenviado para ${email}.`);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível reenviar');
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="verify-banner" role="status" data-testid="verify-banner">
      <MailWarning size={16} />
      <span>
        Confirme seu e-mail: enviamos um link para <strong>{email}</strong>.
      </span>
      <button type="button" className="link" onClick={() => void resend()} disabled={sending}>
        {sending ? 'Reenviando…' : 'Reenviar e-mail'}
      </button>
    </div>
  );
}

interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  end?: boolean;
  adminOnly?: boolean;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * A navegação em grupos, na ordem de importância. Os dois primeiros grupos são a barra de baixo do
 * celular (com "Mais"); os outros vão para a folha do "Mais" no celular e para o pé da lateral.
 */
const PRIMARY: NavGroup[] = [
  {
    id: 'trabalho',
    label: 'Trabalho',
    items: [
      { to: '/', label: 'Início', Icon: Home, end: true },
      { to: '/servicos', label: 'Serviços', Icon: Briefcase },
      { to: '/trocas', label: 'Trocas', Icon: ArrowLeftRight },
    ],
  },
  {
    id: 'dinheiro',
    label: 'Dinheiro',
    items: [{ to: '/carteira', label: 'Carteira', Icon: Wallet }],
  },
];
const SECONDARY: NavGroup[] = [
  {
    id: 'comunidade',
    label: 'Comunidade',
    items: [
      { to: '/ranking', label: 'Ranking', Icon: Trophy },
      { to: '/notificacoes', label: 'Notificações', Icon: Bell },
    ],
  },
  {
    id: 'conta',
    label: 'Conta',
    items: [
      { to: '/perfil', label: 'Perfil', Icon: User },
      { to: '/suporte', label: 'Suporte', Icon: LifeBuoy },
      { to: '/admin', label: 'Admin', Icon: ShieldAlert, adminOnly: true },
    ],
  },
];

const SECONDARY_PATHS = SECONDARY.flatMap((g) => g.items.map((i) => i.to));

export const ROLE_LABEL: Record<string, string> = {
  client: 'Cliente',
  freelancer: 'Freelancer',
  admin: 'Admin',
};

/**
 * App shell: barra lateral escura (marca, navegação agrupada, quem está logado), barra superior
 * (busca global, notificações e conta) e o conteúdo. No tablet a lateral vira um trilho de ícones;
 * no celular, a barra de baixo com 5 itens rotulados, e o "Mais" abre o resto numa folha.
 */
export function Shell() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();

  // Badge de não lidas + push em tempo real (socket) para qualquer tela.
  const profiles = useProfilesMe();
  const avatarUrl =
    profiles.data?.freelancer?.avatarUrl ?? profiles.data?.client?.avatarUrl ?? null;
  const name = displayName(
    profiles.data?.freelancer?.fullName ?? profiles.data?.client?.fullName,
    user?.email,
  );
  const notifications = useNotifications();
  const unread = notifications.data?.unreadCount ?? 0;
  useRealtimeNotifications();
  // Uma faixa por vez no topo (ADR 54): atualização da política, sugestão de fuso (ADR 51) ou
  // e-mail não confirmado, nessa ordem.
  const [detected] = useState(browserBrazilZone);
  const consents = useConsents();
  const banner = pickBanner(user, consents.data, detected);

  // Folha do "Mais" (só no celular): fecha ao trocar de tela, no Esc e no fundo escurecido.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => setMoreOpen(false), [pathname]);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setMoreOpen(false);
      moreBtn.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  const isAdmin = user?.role === 'admin' && user.status !== 'suspended';
  const visible = (i: NavItem): boolean => !i.adminOnly || isAdmin;
  const inSecondary = SECONDARY_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  const renderGroup = (g: NavGroup) => (
    <div key={g.id} className={`nav-group${g.id === 'conta' ? ' nav-group-account' : ''}`}>
      <p className="nav-group-label" id={`nav-${g.id}`}>
        {g.label}
      </p>
      <ul className="nav-list" aria-labelledby={`nav-${g.id}`}>
        {g.items.filter(visible).map(({ to, label, Icon, end }) => (
          <li key={to}>
            {/* No trilho de ícones o rótulo sai da tela, mas fica para o leitor de tela (styles.css):
                com o contador, o link continua "Notificações 3 não lidas", e não só o número. */}
            <NavLink to={to} end={end} className="side-link" title={label}>
              <Icon size={20} strokeWidth={2} aria-hidden="true" />
              <span className="side-label">{label}</span>
              {to === '/notificacoes' && unread > 0 && (
                <span
                  className="nav-badge"
                  aria-label={unreadLabel(unread)}
                  data-testid="nav-badge"
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="app">
      <SkipLink target="conteudo" />
      <aside className="sidebar">
        <NavLink to="/" end className="brand side-brand">
          <span className="brand-mark">
            <ArrowLeftRight size={18} strokeWidth={2.5} />
          </span>
          <span className="brand-name">Escambo</span>
        </NavLink>

        <nav className="side-nav" aria-label="Principal">
          <div className="nav-primary">
            {PRIMARY.map(renderGroup)}
            <button
              ref={moreBtn}
              type="button"
              className={`nav-more-btn${inSecondary ? ' active' : ''}`}
              aria-expanded={moreOpen}
              aria-controls="nav-more"
              onClick={() => setMoreOpen((o) => !o)}
            >
              <Menu size={20} aria-hidden="true" />
              <span className="side-label">Mais</span>
            </button>
          </div>
          <div className="nav-more" id="nav-more" data-open={moreOpen || undefined}>
            {SECONDARY.map(renderGroup)}
            {moreOpen && (
              <button
                type="button"
                className="menu-item danger-item nav-sheet-logout"
                onClick={logout}
              >
                <LogOut size={18} aria-hidden="true" /> Sair da conta
              </button>
            )}
          </div>
        </nav>

        <div className="side-user">
          <Avatar url={avatarUrl} name={name} size="sm" />
          <div className="side-user-info">
            <strong title={user?.email}>{name}</strong>
            <span className="side-user-role">{ROLE_LABEL[user?.role ?? ''] ?? user?.role}</span>
          </div>
          <button className="icon-btn" onClick={logout} title="Sair" aria-label="Sair">
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      {moreOpen && (
        <div className="nav-backdrop" aria-hidden="true" onClick={() => setMoreOpen(false)} />
      )}

      <main className="main" id="conteudo" tabIndex={-1}>
        <TopBar
          name={name}
          email={user?.email ?? ''}
          role={ROLE_LABEL[user?.role ?? ''] ?? user?.role ?? ''}
          avatarUrl={avatarUrl}
          unread={unread}
          onLogout={logout}
        />
        <div className="shell-banners">
          {user && banner === 'suspended' && (
            <div className="verify-banner" role="status" data-testid="suspended-banner">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>
                <strong>Conta suspensa: acesso somente para consulta.</strong> Contratações,
                alterações e movimentações estão bloqueadas. Seus dados e as contestações
                disponíveis continuam acessíveis no <Link to="/perfil">Perfil</Link>. Você também
                pode <Link to="/suporte">falar com o suporte</Link>.
              </span>
            </div>
          )}
          {user && banner === 'legal' && consents.data && (
            <LegalUpdateBanner kind="privacidade" consents={consents.data} />
          )}
          {user && banner === 'terms' && consents.data && (
            <LegalUpdateBanner kind="termos" consents={consents.data} />
          )}
          {user && banner === 'timezone' && detected && (
            <TimezoneBanner user={user} detected={detected} />
          )}
          {user && banner === 'verify-email' && <VerifyEmailBanner email={user.email} />}
        </div>
        <Outlet />
      </main>
    </div>
  );
}
