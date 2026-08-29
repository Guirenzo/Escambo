import { useEffect, useState } from 'react';
import type { Contract, GamificationProfile, Wallet } from '@escambo/types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ContractsCard } from './ContractsCard';
import { GamificationCard } from './GamificationCard';
import { WalletCard } from './WalletCard';

export function Dashboard() {
  const { user, logout } = useAuth();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [gam, setGam] = useState<GamificationProfile | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    void api.wallet().then(setWallet).catch(() => undefined);
    void api.gamification().then(setGam).catch(() => undefined);
    void api.contracts().then((r) => setContracts(r.items)).catch(() => undefined);
    void api.notifications().then((n) => setUnread(n.unreadCount)).catch(() => undefined);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">Escambo</span>
        <div className="topbar-right">
          {gam && (
            <span className="chip level">
              {gam.levelName} · Nv {gam.level}
            </span>
          )}
          <span className="bell">🔔{unread > 0 && <b>{unread}</b>}</span>
          <span className="who">{user?.email}</span>
          <button className="ghost" onClick={logout}>
            Sair
          </button>
        </div>
      </header>
      <main className="grid">
        <WalletCard wallet={wallet} />
        <GamificationCard profile={gam} />
        <ContractsCard contracts={contracts} />
      </main>
    </div>
  );
}
