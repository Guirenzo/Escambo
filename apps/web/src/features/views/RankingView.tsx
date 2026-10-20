import { MapPin, Trophy } from 'lucide-react';
import { useState } from 'react';
import type { LeaderboardEntry, LeaderboardQuery } from '@escambo/types';
import { Button, Chip, PageHeader, QueryState, Select } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { useToast } from '../../lib/toast';
import { useCategories, useGamification, useLeaderboard } from '../../lib/hooks';
import { flattenCategories } from '../services/ServiceForm';

const initials = (name: string | null): string =>
  (name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

/** "★ 4,8 · 12 concluídas · a 3,2 km": os critérios da RN-056 de cada freelancer. */
function criteria(e: LeaderboardEntry): string {
  const parts = [
    `★ ${e.avgRating.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}`,
    `${e.completedContracts} ${e.completedContracts === 1 ? 'concluída' : 'concluídas'}`,
  ];
  if (e.distanceKm != null) {
    parts.push(`a ${e.distanceKm.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`);
  }
  return parts.join(' · ');
}

/**
 * Ranking (RF-067). Sem filtro, o geral por XP, onde está a posição de quem olha. Com uma categoria
 * e/ou "perto de mim" (a localização do navegador, como na busca), é o top 10 da RN-056: nota
 * média, depois contratações concluídas, depois XP, num raio que a plataforma define.
 */
export function RankingView() {
  usePageTitle('Ranking');
  const { user } = useAuth();
  const toast = useToast();
  const [categoryId, setCategoryId] = useState(0);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const categories = useCategories();
  const flat = categories.data ? flattenCategories(categories.data) : [];
  const filter: LeaderboardQuery | undefined =
    categoryId || geo ? { ...(categoryId ? { categoryId } : {}), ...(geo ?? {}) } : undefined;
  const filtered = filter !== undefined;
  const board = useLeaderboard(filter);
  const me = useGamification();
  const isMe = (e: LeaderboardEntry): boolean => e.userUlid === user?.ulid;

  function toggleNearMe(): void {
    if (geo) {
      setGeo(null);
      return;
    }
    if (!('geolocation' in navigator)) {
      toast.error('Seu navegador não oferece geolocalização');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        toast.error('Não consegui obter sua localização');
        setLocating(false);
      },
      { timeout: 8000 },
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Ranking"
        subtitle={
          filtered
            ? 'Os 10 melhores pela nota média, depois pelas contratações concluídas, depois pelo XP.'
            : 'Os freelancers com mais XP na plataforma. Conclua contratos e ganhe badges para subir.'
        }
        action={
          !filtered && me.data?.rank != null ? (
            <Chip kind="level">
              <Trophy size={12} /> Você é #{me.data.rank}
            </Chip>
          ) : undefined
        }
      />

      <div className="geo-bar">
        <Select
          aria-label="Categoria do ranking"
          value={categoryId}
          onChange={(e) => setCategoryId(Number(e.target.value))}
        >
          <option value={0}>Todas as categorias</option>
          {flat.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          className={`toggle ${geo ? 'on' : ''}`}
          onClick={toggleNearMe}
          disabled={locating}
          aria-pressed={geo !== null}
        >
          <MapPin size={16} />{' '}
          {locating ? 'Localizando…' : geo ? 'Perto de mim: ativo' : 'Perto de mim'}
        </Button>
      </div>

      <QueryState
        isLoading={board.isLoading}
        error={board.error}
        data={board.data}
        isEmpty={(d) => d.length === 0}
        empty={filtered ? 'Ninguém nesse filtro ainda.' : 'Ranking ainda vazio.'}
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
                    <div className="avatar" aria-hidden="true">
                      {initials(e.name)}
                    </div>
                    <strong className="pname">{e.name ?? 'Anônimo'}</strong>
                    <Chip>{e.levelName}</Chip>
                    <span className="xp">{filtered ? criteria(e) : `${e.totalXp} XP`}</span>
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
                          <div className="avatar sm" aria-hidden="true">
                            {initials(e.name)}
                          </div>
                          <div>
                            <strong>{e.name ?? 'Anônimo'}</strong>
                            {isMe(e) && <span className="chip level tiny">você</span>}
                            <div className="muted tiny">
                              {filtered ? criteria(e) : `${e.levelName} · Nível ${e.level}`}
                            </div>
                          </div>
                        </div>
                        <span className="price">{e.totalXp} XP</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {!filtered && !meInBoard && me.data?.rank != null && (
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
