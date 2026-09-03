import { QueryState } from '../../components/ui';
import { useContracts, useGamification, useWallet } from '../../lib/hooks';
import { ContractsCard } from '../dashboard/ContractsCard';
import { GamificationCard } from '../dashboard/GamificationCard';
import { WalletCard } from '../dashboard/WalletCard';

export function InicioView() {
  const wallet = useWallet();
  const gam = useGamification();
  const contracts = useContracts();

  return (
    <div className="grid">
      <WalletCard wallet={wallet.data ?? null} />
      <GamificationCard profile={gam.data ?? null} />
      <section className="card wide">
        <h3>🤝 Minhas contratações</h3>
        <QueryState
          isLoading={contracts.isLoading}
          error={contracts.error}
          data={contracts.data}
          isEmpty={(d) => d.items.length === 0}
          empty="Nenhuma contratação ainda."
          onRetry={() => void contracts.refetch()}
        >
          {(d) => <ContractsCard contracts={d.items} />}
        </QueryState>
      </section>
    </div>
  );
}
