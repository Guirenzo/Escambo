import { Award, Coins, Flame, Lock, TrendingUp, Wallet, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { brl } from '../../lib/format';
import { useContracts, useGamification, useWallet } from '../../lib/hooks';
import { ContractsCard } from '../dashboard/ContractsCard';

function Kpi({
  Icon,
  label,
  value,
  hint,
  tone,
  progress,
}: {
  Icon: LucideIcon;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'amber' | 'blue';
  progress?: number;
}) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-top">
        <span className="kpi-ico">
          <Icon size={18} />
        </span>
        <span className="kpi-label">{label}</span>
      </div>
      <strong className="kpi-value">{value}</strong>
      {progress != null && (
        <div className="bar" aria-label="Progresso de nível">
          <div className="bar-fill" style={{ width: `${progress}%` }} />
        </div>
      )}
      {hint && <span className="muted tiny">{hint}</span>}
    </div>
  );
}

export function InicioView() {
  const { user } = useAuth();
  const wallet = useWallet();
  const gam = useGamification();
  const contracts = useContracts();
  const w = wallet.data;
  const g = gam.data;
  const handle = user?.email?.split('@')[0] ?? '';

  return (
    <div className="page">
      <PageHeader title={`Olá, ${handle}`} subtitle="Resumo da sua atividade no Escambo." />

      <div className="kpis">
        <Kpi Icon={Wallet} label="Saldo disponível" value={w ? brl(w.balance) : '—'} hint="para saque" />
        <Kpi Icon={Lock} label="Em escrow" value={w ? brl(w.balancePending) : '—'} hint="retido em contratações" tone="amber" />
        <Kpi
          Icon={Coins}
          label="Créditos Escambo"
          value={w ? String(w.credits) : '—'}
          hint={w && w.creditsPending > 0 ? `${w.creditsPending} em escrow` : 'para contratar ou impulsionar'}
        />
        <Kpi
          Icon={TrendingUp}
          label={g ? `Nível ${g.level} · ${g.levelName}` : 'Nível'}
          value={g ? `${g.totalXp} XP` : '—'}
          hint={
            g
              ? g.progress.xpToNextLevel != null
                ? `faltam ${g.progress.xpToNextLevel} XP · #${g.rank ?? '—'} no ranking`
                : 'nível máximo'
              : undefined
          }
          progress={g?.progress.percent}
          tone="blue"
        />
      </div>

      <div className="two-col">
        <section className="card">
          <div className="card-head">
            <h3>Minhas contratações</h3>
            {contracts.data && <span className="muted tiny">{contracts.data.items.length} no total</span>}
          </div>
          <QueryState
            isLoading={contracts.isLoading}
            error={contracts.error}
            data={contracts.data}
            isEmpty={(d) => d.items.length === 0}
            empty="Nenhuma contratação ainda. Encontre um serviço em Serviços."
            onRetry={() => void contracts.refetch()}
          >
            {(d) => <ContractsCard contracts={d.items} />}
          </QueryState>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>
              <Award size={16} /> Conquistas
            </h3>
            {g && (
              <span className="chip rank">
                <Flame size={12} /> {g.streakDays} dias ativos
              </span>
            )}
          </div>
          {g ? (
            <div className="badges">
              {g.badges.length === 0 ? (
                <span className="muted tiny">Conclua contratações para ganhar badges.</span>
              ) : (
                g.badges.map((b) => (
                  <span key={b.slug} className="badge" title={b.name}>
                    {b.name}
                  </span>
                ))
              )}
            </div>
          ) : (
            <span className="muted tiny">Carregando…</span>
          )}
        </section>
      </div>
    </div>
  );
}
