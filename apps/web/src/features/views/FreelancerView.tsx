import {
  ArrowLeft,
  Briefcase,
  CalendarDays,
  Clock,
  ExternalLink,
  Flag,
  Heart,
  Images,
  Link2,
  MapPin,
  ShieldCheck,
  Star,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { Avatar } from '../../components/Avatar';
import { ScoreBadge } from '../../components/ScoreBadge';
import { Stars } from '../../components/Stars';
import { Button, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { dtm, formatAvailability, formatHours } from '../../lib/format';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
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
import { ModerationButtons } from '../admin/ModerationButtons';
import { ReportModal, type ReportSubject } from '../profile/ReportModal';

/** Perfil público do freelancer: reputação explicada, serviços contratáveis e avaliações. */
export function FreelancerView() {
  const { ulid } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const profile = usePublicFreelancer(ulid);
  usePageTitle(profile.data?.fullName ?? 'Freelancer');
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
  const [report, setReport] = useState<ReportSubject[] | null>(null);

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
                <Avatar url={p.avatarUrl} name={p.fullName} size="lg" />
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
                    {p.availableDays && p.availableDays.length > 0 && (
                      <span className="muted tiny" data-testid="available-days">
                        <CalendarDays size={12} /> atende{' '}
                        {formatAvailability(p.availableDays, p.availablePeriods)}
                      </span>
                    )}
                    {p.availableNow && (
                      <span className="chip now" data-testid="available-now">
                        atende agora
                      </span>
                    )}
                    {p.responseTimeHours != null && (
                      <span className="muted tiny" data-testid="response-time">
                        <Clock size={12} /> responde em {formatHours(p.responseTimeHours)}
                      </span>
                    )}
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
                  {userId !== myId && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        userId &&
                        setReport([
                          {
                            targetType: 'user',
                            targetId: userId,
                            label: 'O perfil',
                            hint: 'golpe, spam, negociação por fora ou comportamento',
                          },
                          ...(p.avatarUrl
                            ? [
                                {
                                  targetType: 'avatar' as const,
                                  targetId: userId,
                                  label: 'A foto do perfil',
                                  hint: 'imagem ofensiva, falsa ou de outra pessoa',
                                  imageUrl: p.avatarUrl,
                                },
                              ]
                            : []),
                        ])
                      }
                    >
                      <Flag size={14} /> Denunciar
                    </Button>
                  )}
                  {user?.role === 'admin' && userId !== myId && (
                    <ModerationButtons ulid={p.userUlid} />
                  )}
                </div>
              </div>
              {p.bio && <p className="profile-bio">{p.bio}</p>}
            </section>

            {p.portfolio.length > 0 && (
              <section className="card" style={{ marginTop: 16 }} data-testid="portfolio">
                <div className="card-head">
                  <h3>
                    <Images size={16} /> Portfólio
                  </h3>
                  <span className="muted tiny">
                    {p.portfolio.length} trabalho{p.portfolio.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="portfolio-grid">
                  {p.portfolio.map((i) => (
                    <figure className="portfolio-item" key={i.id}>
                      {i.imageUrl ? (
                        <img
                          src={mediaVariant(i.imageUrl, MEDIA_THUMB.card)}
                          alt={i.title}
                          loading="lazy"
                        />
                      ) : (
                        <div className="portfolio-placeholder" aria-hidden="true">
                          <Link2 size={22} />
                        </div>
                      )}
                      {i.imageUrl && userId !== myId && (
                        <button
                          type="button"
                          className="icon-btn portfolio-report"
                          aria-label={`Denunciar imagem de ${i.title}`}
                          title="Denunciar imagem"
                          onClick={() =>
                            setReport([
                              {
                                targetType: 'portfolio_item',
                                targetId: i.id,
                                label: `Imagem de “${i.title}”`,
                                imageUrl: i.imageUrl,
                              },
                            ])
                          }
                        >
                          <Flag size={14} />
                        </button>
                      )}
                      <figcaption>
                        <strong>{i.title}</strong>
                        {i.description && <span className="muted tiny">{i.description}</span>}
                        {i.externalUrl && (
                          <a
                            href={i.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tiny"
                          >
                            Ver trabalho <ExternalLink size={12} />
                          </a>
                        )}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </section>
            )}

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
                          onProposeBarter={
                            user?.role === 'freelancer'
                              ? (svc) => navigate(`/trocas?propor=${svc.id}`)
                              : undefined
                          }
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

      {report && <ReportModal subjects={report} onClose={() => setReport(null)} />}
      {contratar && <ContratarModal service={contratar} onClose={() => setContratar(null)} />}
      {boost && <BoostModal service={boost} onClose={() => setBoost(null)} />}
    </div>
  );
}
