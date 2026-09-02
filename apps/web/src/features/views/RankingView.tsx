import { useEffect, useState } from 'react';
import type { GamificationProfile, LeaderboardEntry } from '@escambo/types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

const MEDAL = ['🥇', '🥈', '🥉'];
const initials = (name: string | null): string =>
  (name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export function RankingView() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [me, setMe] = useState<GamificationProfile | null>(null);

  useEffect(() => {
    void api.leaderboard().then(setEntries).catch(() => undefined);
    void api.gamification().then(setMe).catch(() => undefined);
  }, []);

  const isMe = (e: LeaderboardEntry): boolean => e.userUlid === user?.ulid;
  const top3 = entries.slice(0, 3);
  const rest = entries.slice(3);
  const meInBoard = entries.some(isMe);
  // ordem visual do pódio: 2º, 1º, 3º
  const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean) as LeaderboardEntry[];

  return (
    <div className="view">
      <div className="view-head">
        <h2>🏆 Ranking</h2>
        {me?.rank != null && <span className="chip level">Você é #{me.rank}</span>}
      </div>
      <p className="muted">Os freelancers com mais XP na plataforma. Conclua contratos e ganhe badges para subir.</p>

      {entries.length === 0 ? (
        <p className="muted">Ranking ainda vazio.</p>
      ) : (
        <>
          <div className="podium">
            {podiumOrder.map((e) => (
              <div key={e.userUlid} className={`podium-col p${e.rank} ${isMe(e) ? 'me' : ''}`}>
                <div className="medal">{MEDAL[e.rank - 1]}</div>
                <div className="avatar">{initials(e.name)}</div>
                <strong className="pname">{e.name ?? 'Anônimo'}</strong>
                <span className="chip rank">{e.levelName}</span>
                <span className="xp">{e.totalXp} XP</span>
                <div className="stand">{e.rank}º</div>
              </div>
            ))}
          </div>

          {rest.length > 0 && (
            <section className="card wide">
              <ul className="list rank-list">
                {rest.map((e) => (
                  <li key={e.userUlid} className={isMe(e) ? 'me-row' : ''}>
                    <div className="rank-left">
                      <span className="pos">{e.rank}º</span>
                      <div className="avatar sm">{initials(e.name)}</div>
                      <div>
                        <strong>{e.name ?? 'Anônimo'}</strong>
                        {isMe(e) && <span className="chip level tiny"> você</span>}
                        <div className="muted tiny">{e.levelName} · Nível {e.level}</div>
                      </div>
                    </div>
                    <span className="price">{e.totalXp} XP</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!meInBoard && me?.rank != null && (
            <section className="card wide me-standing">
              <div className="rank-left">
                <span className="pos">{me.rank}º</span>
                <div>
                  <strong>Você</strong>
                  <div className="muted tiny">
                    {me.levelName} · Nível {me.level}
                  </div>
                </div>
              </div>
              <span className="price">{me.totalXp} XP</span>
            </section>
          )}
        </>
      )}
    </div>
  );
}
