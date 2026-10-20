import { CircleCheck, Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Mission } from '@escambo/types';
import { ErrorState } from '../../components/ui';
import { untilLabel } from '../../lib/deadline';
import { useMissions } from '../../lib/hooks';

const KIND: Record<Mission['type'], string> = {
  daily: 'Diária',
  weekly: 'Semanal',
  achievement: 'Conquista',
};

/** O instante em que o período da missão acaba: o segundo seguinte ao 23:59:59 (null sem prazo). */
const periodEnd = (m: Mission): number | null =>
  m.expiresAt ? Date.parse(m.expiresAt) + 1000 : null;

/** "Cumprida", "Sem prazo" ou quanto falta para o período virar (RN-054). */
export function missionDeadline(m: Mission, now: number): string {
  if (m.completed) return 'Cumprida';
  const end = periodEnd(m);
  return end === null ? 'Sem prazo' : `Expira em ${untilLabel(end - now)}`;
}

/**
 * Missões do período vigente (RF-066, RN-054), no Início. Abrir o cartão conta como o acesso do dia.
 * O "expira em" anda a cada minuto, e quando um período vira as missões são buscadas de novo (o
 * progresso da diária ou da semana recomeça). Quem não tem missões (cliente, conta sem perfil de
 * freelancer) não vê o cartão.
 */
export function MissionsCard() {
  const missions = useMissions();
  const { data, refetch } = missions;
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const ends = (data ?? [])
      .map(periodEnd)
      .filter((end): end is number => end !== null && end > Date.now());
    if (ends.length === 0) return undefined;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        void refetch();
      },
      Math.min(2_147_483_647, Math.min(...ends) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [data, refetch]);

  if (missions.error) {
    return (
      <section className="card missions">
        <h3>
          <Target size={16} /> Missões
        </h3>
        <ErrorState error={missions.error} onRetry={() => void refetch()} />
      </section>
    );
  }
  if (!data || data.length === 0) return null;

  return (
    <section className="card missions" aria-labelledby="missions-title">
      <div className="card-head">
        <h3 id="missions-title">
          <Target size={16} /> Missões
        </h3>
        <span className="muted tiny">
          {data.filter((m) => m.completed).length} de {data.length} cumpridas
        </span>
      </div>
      <ul className="list">
        {data.map((m) => {
          const percent = Math.min(100, Math.round((m.progress / m.target) * 100));
          return (
            <li key={m.id} className={m.completed ? 'done' : undefined}>
              <div className="grow">
                <strong>{m.title}</strong> <span className="chip level tiny">{KIND[m.type]}</span>
                {m.description && <div className="muted tiny">{m.description}</div>}
                <div
                  className="bar"
                  role="progressbar"
                  aria-label={`Progresso de ${m.title}`}
                  aria-valuemin={0}
                  aria-valuemax={m.target}
                  aria-valuenow={m.progress}
                  aria-valuetext={`${m.progress} de ${m.target}`}
                >
                  <div className="bar-fill" style={{ width: `${percent}%` }} />
                </div>
                <span className="muted tiny">
                  {m.progress}/{m.target} · {missionDeadline(m, now)}
                </span>
              </div>
              {/* Cumprida em verde; a recompensa ainda em aberto, neutra. */}
              <span className={`chip ${m.completed ? 'rank' : 'days'}`}>
                {m.completed && <CircleCheck size={12} aria-hidden />} +{m.xpReward} XP
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
