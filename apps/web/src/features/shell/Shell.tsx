import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { CarteiraView } from '../views/CarteiraView';
import { InicioView } from '../views/InicioView';
import { NotificacoesView } from '../views/NotificacoesView';
import { PerfilView } from '../views/PerfilView';
import { ServicosView } from '../views/ServicosView';
import { TrocasView } from '../views/TrocasView';

type View = 'inicio' | 'servicos' | 'trocas' | 'carteira' | 'notificacoes' | 'perfil';

const NAV: { key: View; label: string; icon: string }[] = [
  { key: 'inicio', label: 'Início', icon: '🏠' },
  { key: 'servicos', label: 'Serviços', icon: '🗂️' },
  { key: 'trocas', label: 'Trocas', icon: '⇄' },
  { key: 'carteira', label: 'Carteira', icon: '💰' },
  { key: 'notificacoes', label: 'Notificações', icon: '🔔' },
  { key: 'perfil', label: 'Perfil', icon: '👤' },
];

export function Shell() {
  const { user, logout } = useAuth();
  const [view, setView] = useState<View>('inicio');

  return (
    <div className="shell">
      <header className="topbar">
        <span className="logo">Escambo</span>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`navbtn ${view === n.key ? 'active' : ''}`}
              onClick={() => setView(n.key)}
            >
              <span className="ico">{n.icon}</span>
              {n.label}
            </button>
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
        {view === 'inicio' && <InicioView />}
        {view === 'servicos' && <ServicosView />}
        {view === 'trocas' && <TrocasView />}
        {view === 'carteira' && <CarteiraView />}
        {view === 'notificacoes' && <NotificacoesView />}
        {view === 'perfil' && <PerfilView />}
      </main>
    </div>
  );
}
