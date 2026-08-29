import { useCallback, useEffect, useState } from 'react';
import type { Contract, GamificationProfile, Wallet } from '@escambo/types';
import { api } from '../../lib/api';
import { ContractsCard } from '../dashboard/ContractsCard';
import { GamificationCard } from '../dashboard/GamificationCard';
import { WalletCard } from '../dashboard/WalletCard';

export function InicioView() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [gam, setGam] = useState<GamificationProfile | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);

  const load = useCallback(() => {
    void api.wallet().then(setWallet).catch(() => undefined);
    void api.gamification().then(setGam).catch(() => undefined);
    void api
      .contracts()
      .then((r) => setContracts(r.items))
      .catch(() => undefined);
  }, []);
  useEffect(() => load(), [load]);

  return (
    <div className="grid">
      <WalletCard wallet={wallet} />
      <GamificationCard profile={gam} />
      <ContractsCard contracts={contracts} onChange={load} />
    </div>
  );
}
