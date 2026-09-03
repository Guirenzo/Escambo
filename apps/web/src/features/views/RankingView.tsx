import { Trophy } from 'lucide-react';
import type { LeaderboardEntry } from '@escambo/types';
import { Chip, PageHeader, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useGamification, useLeaderboard } from '../../lib/hooks';

const initials = (name: string | null): string =>
  (name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export function RankingView() {
  const { user } = useAuth();
  const board = useLeaderboard();
  const me = useGamification();
  const isMe = (e: LeaderboardEntry): boolean => e.userUlid === user?.ulid;

  return (
    <div className="page">
      <PageHeader
        title="Ranking"
        subtitle="Os freelancers com mais XP na plataforma. Conclua contratos e ganhe badges para subir."
        action={me.data?.rank != null ? <Chip kind="level"><Trophy size={12} /> Você é #{me.data.rank}</Chip> : undefined}
      />

      <QueryState
        isLoading={board.isLoading}
        error={board.error}
        data={board.data}
        isEmpty={(d) => d.length === 0}
        empty="Ranking ainda vazio."
        onRetry={() => void board.refetch()}
      >
        {(entries) => {
          const top3 = entries.slice(0, 3);
          const rest = entries.slice(3);
          const meInBoard = entries.some(isMe);
          const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean) as LeaderboardEntry[];
          return (
            <>
              <div className="podium">
                {podiumOrder.map((e) => (
                  <div key={e.userUlid} className={`podium-col p${e.rank} ${isMe(e) ? 'me' : ''}`}>
                    <span className="medal">{e.rank}</span>
                    <div className="avatar">{initials(e.name)}</div>
                    <strong className="pname">{e.name ?? 'Anônimo'}</strong>
                    <Chip>{e.levelName}</Chip>
                    <span className="xp">{e.totalXp} XP</span>
                    <div className="stand">{e.rank}º</div>
                  </div>
                ))}
              </div>

              {rest.length > 0 && (
                <section className="card">
                  <ul className="list rank-list">
                    {rest.map((e) => (
                      <li key={e.userUlid} className={isMe(e) ? 'me-row' : ''}>
                        <div className="rank-left">
                          <span className="pos">{e.rank}º</span>
                          <div className="avatar sm">{initials(e.name)}</div>
                          <div>
                            <strong>{e.name ?? 'Anônimo'}</strong>
                            {isMe(e) && <span className="chip level tiny">você</span>}
                            <div className="muted tiny">
                              {e.levelName} · Nível {e.level}
                            </div>
                          </div>
                        </div>
                        <span className="price">{e.totalXp} XP</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {!meInBoard && me.data?.rank != null && (
                <section className="card me-standing">
                  <div className="rank-left">
                    <span className="pos">{me.data.rank}º</span>
                    <div>
                      <strong>Você</strong>
                      <div className="muted tiny">
                        {me.data.levelName} · Nível {me.data.level}
                      </div>
                    </div>
                  </div>
                  <span className="price">{me.data.totalXp} XP</span>
                </section>
              )}
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
