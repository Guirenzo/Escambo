import type { GamificationProfile } from '@escambo/types';

export function GamificationCard({ profile }: { profile: GamificationProfile | null }) {
  if (!profile) {
    return (
      <section className="card">
        <h3>🎮 Progresso</h3>
        <p className="muted">carregando…</p>
      </section>
    );
  }
  const { progress } = profile;
  return (
    <section className="card">
      <h3>🎮 Progresso</h3>
      <div className="level-row">
        <span className="chip level">{profile.levelName}</span>
        <span className="muted">Nível {profile.level}</span>
        {profile.rank != null && <span className="chip rank">#{profile.rank}</span>}
      </div>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <p className="muted">
        {profile.totalXp} XP
        {progress.xpToNextLevel != null ? ` · faltam ${progress.xpToNextLevel} p/ o próximo nível` : ' · nível máximo'}
      </p>
      <p className="streak">🔥 {profile.streakDays} dias ativos</p>
      <div className="badges">
        {profile.badges.length === 0 ? (
          <span className="muted">sem badges ainda</span>
        ) : (
          profile.badges.map((b) => (
            <span key={b.slug} className="badge" title={b.name}>
              🏅 {b.name}
            </span>
          ))
        )}
      </div>
    </section>
  );
}
