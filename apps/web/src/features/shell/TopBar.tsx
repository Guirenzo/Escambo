import { ArrowLeftRight, Bell, ChevronDown, LifeBuoy, LogOut, Search, User } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';

/** "1 não lida", "7 não lidas": o mesmo texto no menu lateral e no sino. */
export const unreadLabel = (n: number): string => `${n} não lida${n > 1 ? 's' : ''}`;

/**
 * Barra superior do app: busca global (leva à busca de serviços com o texto), o sino com as não
 * lidas e o menu da conta. No celular a busca vira um ícone que abre o campo logo abaixo da barra.
 */
export function TopBar({
  name,
  email,
  role,
  avatarUrl,
  unread,
  onLogout,
}: {
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
  unread: number;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Trocar de tela fecha a busca do celular e o menu da conta.
  useEffect(() => {
    setSearchOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  // Menu da conta: Esc fecha e devolve o foco ao botão; clique fora fecha.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      menuBtn.current?.focus();
    };
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  function submit(): void {
    const text = q.trim();
    navigate(text ? `/servicos?q=${encodeURIComponent(text)}` : '/servicos');
    setQ('');
    setSearchOpen(false);
  }

  const bellLabel =
    unread > 0 ? `Abrir notificações, ${unreadLabel(unread)}` : 'Abrir notificações';

  return (
    <header className={`topbar${searchOpen ? ' searching' : ''}`}>
      <Link to="/" className="brand topbar-brand" aria-label="Escambo, ir para o início">
        <span className="brand-mark">
          <ArrowLeftRight size={18} strokeWidth={2.5} />
        </span>
        <span className="brand-name">Escambo</span>
      </Link>
      <button
        ref={searchBtn}
        type="button"
        className="topbar-icon topbar-search-btn"
        aria-expanded={searchOpen}
        aria-controls="busca-global"
        aria-label={searchOpen ? 'Fechar busca' : 'Abrir busca'}
        onClick={() => setSearchOpen((o) => !o)}
      >
        <Search size={20} aria-hidden="true" />
      </button>
      <form
        id="busca-global"
        role="search"
        aria-label="Busca no Escambo"
        className="global-search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && searchOpen) {
            setSearchOpen(false);
            searchBtn.current?.focus();
          }
        }}
      >
        <Search size={18} aria-hidden="true" />
        <input
          ref={searchInput}
          type="search"
          aria-label="Buscar serviços no Escambo"
          placeholder="Buscar serviços ou tags…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          enterKeyHint="search"
        />
      </form>
      <div className="topbar-actions">
        <Link
          to="/notificacoes"
          className={`topbar-icon${pathname === '/notificacoes' ? ' active' : ''}`}
          aria-label={bellLabel}
          title={bellLabel}
        >
          <Bell size={20} aria-hidden="true" />
          {unread > 0 && (
            <span className="topbar-count" aria-hidden="true" data-testid="topbar-count">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Link>
        <div className="account" ref={menuRef}>
          <button
            ref={menuBtn}
            type="button"
            className="account-btn"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label="Menu da conta"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Avatar url={avatarUrl} name={name} size="sm" />
            <ChevronDown size={16} aria-hidden="true" className="account-chevron" />
          </button>
          {menuOpen && (
            <div className="account-menu" id={menuId}>
              <div className="account-menu-head">
                <Avatar url={avatarUrl} name={name} size="sm" />
                <div>
                  <strong>{name}</strong>
                  <span>{email}</span>
                  <span>{role}</span>
                </div>
              </div>
              <ul>
                <li>
                  <Link to="/perfil" className="menu-item">
                    <User size={18} aria-hidden="true" /> Meu perfil
                  </Link>
                </li>
                <li>
                  <Link to="/suporte" className="menu-item">
                    <LifeBuoy size={18} aria-hidden="true" /> Ajuda e suporte
                  </Link>
                </li>
                <li>
                  <button type="button" className="menu-item danger-item" onClick={onLogout}>
                    <LogOut size={18} aria-hidden="true" /> Sair da conta
                  </button>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
