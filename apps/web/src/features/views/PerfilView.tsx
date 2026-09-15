import { Briefcase, MapPin, ShieldCheck, Star, User } from 'lucide-react';
import type { AvailabilityPeriod, AvailablePeriods } from '@escambo/types';
import { useEffect, useState, type FormEvent } from 'react';
import { Avatar } from '../../components/Avatar';
import { ScoreBadge } from '../../components/ScoreBadge';
import { Stars } from '../../components/Stars';
import { Button, Field, Input, PageHeader, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { dtm, PERIOD_LABEL, PERIOD_ORDER, WEEKDAY_SHORT } from '../../lib/format';
import {
  useFreelancerReviews,
  useProfilesMe,
  usePutClientProfile,
  usePutFreelancerProfile,
  useRespondReview,
} from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { EmailPreferencesCard } from '../profile/EmailPreferencesCard';
import { PortfolioCard } from '../profile/PortfolioCard';
import { PrivacidadeCard } from '../profile/PrivacidadeCard';
import { ImageUploadButton } from '../../components/ImageUploadButton';
import { IMAGE_MAX_SIDE } from '../../lib/image';

/** Avaliações que o freelancer recebeu, com resposta pública (uma por avaliação). */
function AvaliacoesRecebidas({ userId }: { userId: number }) {
  const reviews = useFreelancerReviews(userId);
  const respond = useRespondReview();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  async function reply(id: number): Promise<void> {
    const text = (drafts[id] ?? '').trim();
    if (!text) return;
    try {
      await respond.mutateAsync({ id, response: text });
      toast.success('Resposta publicada');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao responder');
    }
  }

  return (
    <section className="card wide">
      <div className="card-head">
        <h3>
          <Star size={16} /> Avaliações recebidas
        </h3>
      </div>
      <QueryState
        isLoading={reviews.isLoading}
        error={reviews.error}
        data={reviews.data}
        empty="Nenhuma avaliação ainda. Elas chegam quando clientes aprovam suas entregas."
        onRetry={() => void reviews.refetch()}
      >
        {(d) => (
          <ul className="review-list">
            {d.items.map((r) => (
              <li key={r.id} className="review">
                <div className="review-head">
                  <Stars value={r.rating} showValue={false} size={16} />
                  <span className="muted tiny">{dtm(r.createdAt)}</span>
                </div>
                <p>{r.comment ?? <span className="muted">Sem comentário.</span>}</p>
                {r.response ? (
                  <div className="review-response">
                    <strong>Sua resposta</strong>
                    <p>{r.response}</p>
                  </div>
                ) : (
                  <form
                    className="review-reply"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void reply(r.id);
                    }}
                  >
                    <Input
                      value={drafts[r.id] ?? ''}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: e.target.value })}
                      placeholder="Responder (público, uma única vez)"
                      aria-label="Resposta à avaliação"
                      maxLength={1000}
                    />
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={respond.isPending || !(drafts[r.id] ?? '').trim()}
                    >
                      Responder
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}

export function PerfilView() {
  usePageTitle('Perfil');
  const { user } = useAuth();
  const profiles = useProfilesMe();
  const putFreelancer = usePutFreelancerProfile();
  const putClient = usePutClientProfile();
  const toast = useToast();

  const [name, setName] = useState('');
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [city, setCity] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [stateUf, setStateUf] = useState('');
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [locating, setLocating] = useState(false);
  const [availableDays, setAvailableDays] = useState<number[]>([]);
  const toggleDay = (d: number): void =>
    setAvailableDays((days) => (days.includes(d) ? days.filter((x) => x !== d) : [...days, d]));
  // Períodos por dia (ADR 34): dia sem período marcado = o dia todo.
  const [availablePeriods, setAvailablePeriods] = useState<AvailablePeriods>({});
  const [isAvailable, setIsAvailable] = useState(true);
  const togglePeriod = (d: number, p: AvailabilityPeriod): void =>
    setAvailablePeriods((cur) => {
      const list = cur[String(d)] ?? [];
      return { ...cur, [String(d)]: list.includes(p) ? list.filter((x) => x !== p) : [...list, p] };
    });

  // Preenche o formulário quando o perfil chega.
  useEffect(() => {
    const p = profiles.data;
    if (!p) return;
    const base = p.freelancer ?? p.client;
    if (base) {
      setName(base.fullName);
      setCity(base.city ?? '');
      setAvatarUrl(base.avatarUrl ?? '');
    }
    if (p.freelancer) {
      setHeadline(p.freelancer.headline ?? '');
      setBio(p.freelancer.bio ?? '');
      setStateUf(p.freelancer.state ?? '');
      setLat(p.freelancer.latitude);
      setLng(p.freelancer.longitude);
      setAvailableDays(p.freelancer.availableDays ?? []);
      setAvailablePeriods(p.freelancer.availablePeriods ?? {});
      setIsAvailable(p.freelancer.isAvailable);
    }
  }, [profiles.data]);

  /** Localização do freelancer: é o que faz "Perto de mim" encontrá-lo. */
  function locateMe(): void {
    if (!('geolocation' in navigator)) {
      toast.error('Seu navegador não oferece geolocalização');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude);
        setLng(pos.coords.longitude);
        setLocating(false);
      },
      () => {
        toast.error('Não consegui obter sua localização');
        setLocating(false);
      },
      { timeout: 8000 },
    );
  }

  async function saveFreelancer(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await putFreelancer.mutateAsync({
        fullName: name,
        avatarUrl: avatarUrl.trim() || null,
        headline,
        bio,
        city,
        state: stateUf.trim().toUpperCase() || null,
        latitude: lat,
        longitude: lng,
        availableDays,
        // Só os dias marcados; o servidor normaliza (nenhum ou os três períodos = o dia todo).
        availablePeriods: Object.fromEntries(
          availableDays.map((d) => [String(d), availablePeriods[String(d)] ?? []]),
        ),
        isAvailable,
      });
      toast.success('Perfil de freelancer salvo!');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro');
    }
  }

  async function saveClient(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await putClient.mutateAsync({ fullName: name, city, avatarUrl: avatarUrl.trim() || null });
      toast.success('Perfil de cliente salvo!');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro');
    }
  }

  return (
    <div className="page">
      <PageHeader title="Perfil" subtitle="Como você aparece para clientes e freelancers." />
      <QueryState
        isLoading={profiles.isLoading}
        error={profiles.error}
        data={profiles.data}
        onRetry={() => void profiles.refetch()}
      >
        {(p) => (
          <div className="grid">
            {/* Escambo Score (diferencial #3) — reputação multifator explicável */}
            {p.freelancer && (
              <section className="card wide">
                <div className="card-head">
                  <h3>
                    <ShieldCheck size={16} /> Escambo Score
                  </h3>
                  <span className="muted tiny">
                    <Stars
                      value={p.freelancer.avgRating}
                      count={p.freelancer.totalReviews}
                      size={12}
                    />{' '}
                    · {p.freelancer.totalContracts} contratos
                  </span>
                </div>
                <ScoreBadge score={p.freelancer.escamboScore} detailed />
                <p className="muted tiny">
                  Qualidade (nota), experiência (contratos), prova social (avaliações) e
                  responsividade (tempo de resposta), ponderadas em um índice de confiança de 0 a
                  100.
                </p>
              </section>
            )}

            {p.freelancer && user && <AvaliacoesRecebidas userId={user.id} />}

            <form className="card" onSubmit={saveFreelancer}>
              <h3>
                <Briefcase size={16} /> Freelancer
              </h3>
              <Field label="Nome">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={2}
                />
              </Field>
              <Field label="Foto (URL da imagem)">
                <div className="loc-row">
                  <Avatar url={avatarUrl.trim() || null} name={name || '?'} size="sm" />
                  <Input
                    type="text"
                    inputMode="url"
                    value={avatarUrl}
                    onChange={(e) => setAvatarUrl(e.target.value)}
                    placeholder="https://…/sua-foto.jpg ou envie do aparelho"
                    maxLength={512}
                  />
                  <ImageUploadButton
                    maxSide={IMAGE_MAX_SIDE.avatar}
                    label="Enviar foto"
                    testId="avatar-upload"
                    onUploaded={(url) => {
                      setAvatarUrl(url);
                      toast.success('Foto enviada. Salve o perfil para aplicar.');
                    }}
                  />
                </div>
              </Field>
              <Field label="Headline">
                <Input
                  value={headline}
                  onChange={(e) => setHeadline(e.target.value)}
                  placeholder="Dev Full Stack | 5 anos"
                />
              </Field>
              <Field label="Bio">
                <Input value={bio} onChange={(e) => setBio(e.target.value)} />
              </Field>
              <Field label="Cidade">
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
              </Field>
              <Field label="Estado (UF)">
                <Input
                  value={stateUf}
                  onChange={(e) => setStateUf(e.target.value)}
                  maxLength={2}
                  placeholder="SC"
                />
              </Field>
              <div className="stack">
                <span className="muted tiny" id="days-label">
                  Dias em que você atende
                </span>
                <div className="days-row" role="group" aria-labelledby="days-label">
                  {WEEKDAY_SHORT.map((label, d) => (
                    <button
                      key={d}
                      type="button"
                      className={`day-chip ${availableDays.includes(d) ? 'on' : ''}`}
                      aria-pressed={availableDays.includes(d)}
                      onClick={() => toggleDay(d)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {availableDays.length === 0 && (
                  <span className="muted tiny" data-testid="days-hint">
                    Sem dias marcados, você fica fora do filtro "atende no dia" da busca.
                  </span>
                )}
                {availableDays.length > 0 && (
                  <div className="periods-grid" data-testid="periods-grid">
                    {[...availableDays]
                      .sort((a, b) => a - b)
                      .map((d) => (
                        <div key={d} className="periods-row">
                          <span className="periods-day">{WEEKDAY_SHORT[d]}</span>
                          {PERIOD_ORDER.map((p) => {
                            const on = (availablePeriods[String(d)] ?? []).includes(p);
                            return (
                              <button
                                key={p}
                                type="button"
                                className={`day-chip period ${on ? 'on' : ''}`}
                                aria-pressed={on}
                                aria-label={`${WEEKDAY_SHORT[d]} ${PERIOD_LABEL[p]}`}
                                onClick={() => togglePeriod(d, p)}
                              >
                                {PERIOD_LABEL[p]}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    <span className="muted tiny">
                      Sem período marcado, vale o dia todo. Manhã 6h–12h, tarde 12h–18h, noite
                      18h–24h (horário de Brasília).
                    </span>
                  </div>
                )}
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Aceitando novos pedidos"
                    checked={isAvailable}
                    onChange={(e) => setIsAvailable(e.target.checked)}
                  />
                  <span>
                    {isAvailable
                      ? 'Aceitando novos pedidos'
                      : 'Agenda pausada: você não aparece em "atende agora"'}
                  </span>
                </label>
              </div>
              <div className="stack">
                <span className="muted tiny">
                  Localização (é o que faz "Perto de mim" te encontrar)
                </span>
                <div className="loc-row">
                  <Button type="button" variant="secondary" onClick={locateMe} disabled={locating}>
                    <MapPin size={14} /> {locating ? 'Localizando…' : 'Usar minha localização'}
                  </Button>
                  <span className="muted tiny" aria-live="polite">
                    {lat != null && lng != null
                      ? `Definida (${lat.toFixed(4)}, ${lng.toFixed(4)})`
                      : 'Não definida'}
                  </span>
                </div>
              </div>
              <Button type="submit" disabled={putFreelancer.isPending}>
                Salvar freelancer
              </Button>
            </form>

            <form className="card" onSubmit={saveClient}>
              <h3>
                <User size={16} /> Cliente {p.client && <span className="chip rank">ativo</span>}
              </h3>
              <Field label="Nome">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={2}
                />
              </Field>
              <Field label="Foto (URL da imagem)">
                <div className="loc-row">
                  <Avatar url={avatarUrl.trim() || null} name={name || '?'} size="sm" />
                  <Input
                    type="text"
                    inputMode="url"
                    value={avatarUrl}
                    onChange={(e) => setAvatarUrl(e.target.value)}
                    placeholder="https://…/sua-foto.jpg ou envie do aparelho"
                    maxLength={512}
                  />
                  <ImageUploadButton
                    maxSide={IMAGE_MAX_SIDE.avatar}
                    label="Enviar foto"
                    testId="avatar-upload"
                    onUploaded={(url) => {
                      setAvatarUrl(url);
                      toast.success('Foto enviada. Salve o perfil para aplicar.');
                    }}
                  />
                </div>
              </Field>
              <Field label="Cidade">
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
              </Field>
              <Button type="submit" disabled={putClient.isPending}>
                Salvar cliente
              </Button>
            </form>

            {p.freelancer && <PortfolioCard />}
            <EmailPreferencesCard />
            <PrivacidadeCard />
          </div>
        )}
      </QueryState>
    </div>
  );
}
