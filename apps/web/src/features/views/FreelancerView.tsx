import { ArrowLeft, Briefcase, Heart, MapPin, ShieldCheck, Star } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { ScoreBadge } from '../../components/ScoreBadge';
import { Stars } from '../../components/Stars';
import { Button, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { dtm } from '../../lib/format';
import {
  useFavorites,
  useFreelancerReviews,
  usePublicFreelancer,
  useServices,
  useToggleFavorite,
} from '../../lib/hooks';
import { BoostModal } from '../services/BoostModal';
import { ContratarModal } from '../services/ContratarModal';
import { ServiceCard } from '../services/ServiceCard';

/** Perfil público do freelancer: reputação explicada, serviços contratáveis e avaliações. */
export function FreelancerView() {
  const { ulid } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const profile = usePublicFreelancer(ulid);
  const userId = profile.data?.userId;
  const services = useServices(userId ? { ownerId: userId, limit: 50 } : undefined);
  const reviews = useFreelancerReviews(userId);
  const favorites = useFavorites();
  const toggleFav = useToggleFavorite();
  const isFav = !!favorites.data?.some(
    (f) => f.targetType === 'freelancer' && f.targetId === userId,
  );
  const [contratar, setContratar] = useState<Service | null>(null);
  const [boost, setBoost] = useState<Service | null>(null);

  return (
    <div className="page">
      <div>
        <Button variant="ghost" className="mini" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> Voltar
        </Button>
      </div>

      <QueryState
        isLoading={profile.isLoading}
        error={profile.error}
        data={profile.data}
        onRetry={() => void profile.refetch()}
      >
        {(p) => (
          <>
            <section className="card" style={{ marginTop: 12 }}>
              <div className="profile-hero">
                <span className="profile-avatar" aria-hidden="true">
                  {p.fullName[0]}
                </span>
                <div>
                  <h1 style={{ margin: 0, fontSize: '1.5rem' }}>{p.fullName}</h1>
                  {p.headline && (
                    <p className="muted" style={{ margin: '2px 0 0' }}>
                      {p.headline}
                    </p>
                  )}
                  <div className="profile-meta">
                    <Stars value={p.avgRating} count={p.totalReviews} size={14} />
                    <span className="chip level">
                      Nível {p.level} · {p.levelName}
                    </span>
                    {(p.city || p.state) && (
                      <span className="muted tiny">
                        <MapPin size={12} /> {[p.city, p.state].filter(Boolean).join(', ')}
                      </span>
                    )}
                    <span className="muted tiny">{p.totalContracts} contratos concluídos</span>
                    {!p.isAvailable && <span className="pill">indisponível</span>}
                  </div>
                </div>
                <div className="stack">
                  <ScoreBadge score={p.escamboScore} />
                  {userId !== myId && (
                    <Button
                      variant={isFav ? 'secondary' : 'ghost'}
                      className="toggle"
                      aria-pressed={isFav}
                      disabled={toggleFav.isPending || !userId}
                      onClick={() =>
                        userId &&
                        toggleFav.mutate({
                          targetType: 'freelancer',
                          targetId: userId,
                          favorited: isFav,
                        })
                      }
                    >
                      <Heart size={14} /> {isFav ? 'Favorito' : 'Favoritar'}
                    </Button>
                  )}
                </div>
              </div>
              {p.bio && <p className="profile-bio">{p.bio}</p>}
            </section>

            <div className="two-col" style={{ marginTop: 16 }}>
              <section className="card">
                <div className="card-head">
                  <h3>
                    <Briefcase size={16} /> Serviços
                  </h3>
                </div>
                <QueryState
                  isLoading={services.isLoading}
                  error={services.error}
                  data={services.data}
                  empty="Este freelancer ainda não publicou serviços."
                  onRetry={() => void services.refetch()}
                >
                  {(d) => (
                    <div className="cards-grid">
                      {d.items.map((s) => (
                        <ServiceCard
                          key={s.id}
                          service={s}
                          mine={s.ownerId === myId}
                          showOwner={false}
                          onContratar={setContratar}
                          onBoost={setBoost}
                        />
                      ))}
                    </div>
                  )}
                </QueryState>
              </section>

              <div className="stack">
                <section className="card">
                  <div className="card-head">
                    <h3>
                      <ShieldCheck size={16} /> Escambo Score
                    </h3>
                  </div>
                  <ScoreBadge score={p.escamboScore} detailed />
                </section>

                <section className="card">
                  <div className="card-head">
                    <h3>
                      <Star size={16} /> Avaliações
                    </h3>
                  </div>
                  <QueryState
                    isLoading={reviews.isLoading}
                    error={reviews.error}
                    data={reviews.data}
                    empty="Nenhuma avaliação ainda."
                    onRetry={() => void reviews.refetch()}
                  >
                    {(d) => (
                      <ul className="review-list">
                        {d.items.map((r) => (
                          <li key={r.id} className="review">
                            <div className="review-head">
                              <Stars value={r.rating} showValue={false} size={14} />
                              <span className="muted tiny">{dtm(r.createdAt)}</span>
                            </div>
                            <p>{r.comment ?? <span className="muted">Sem comentário.</span>}</p>
                            {r.response && (
                              <div className="review-response">
                                <strong>Resposta do freelancer</strong>
                                <p>{r.response}</p>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </QueryState>
                </section>
              </div>
            </div>
          </>
        )}
      </QueryState>

      {contratar && <ContratarModal service={contratar} onClose={() => setContratar(null)} />}
      {boost && <BoostModal service={boost} onClose={() => setBoost(null)} />}
    </div>
  );
}
