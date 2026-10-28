import { BusinessForm } from '../../components/BusinessActions';
import { Briefcase, Eye, MapPin, ShieldCheck, Star, User } from 'lucide-react';
import type { AvailabilityPeriod, AvailablePeriods } from '@escambo/types';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { ScoreBadge } from '../../components/ScoreBadge';
import { Stars } from '../../components/Stars';
import { Button, Field, Input, PageHeader, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { useScrollToHashWhenSettled } from '../../lib/useScrollToHash';
import { dtm, PERIOD_LABEL, PERIOD_ORDER, WEEKDAY_SHORT } from '../../lib/format';
import {
  useCpfStatus,
  useFreelancerReviews,
  useProfilesMe,
  usePutClientProfile,
  usePutFreelancerProfile,
  useRespondReview,
} from '../../lib/hooks';
import { timezoneLabel } from '../../lib/timezones';
import { useToast } from '../../lib/toast';
import { EmailPreferencesCard } from '../profile/EmailPreferencesCard';
import { ModeracaoCard } from '../profile/ModeracaoCard';
import { DesistenciasCard } from '../profile/DesistenciasCard';
import { PortfolioCard } from '../profile/PortfolioCard';
import { PushCard } from '../profile/PushCard';
import { PrivacidadeCard } from '../profile/PrivacidadeCard';
import { SenhaCard } from '../profile/SenhaCard';
import { DoisFatoresCard } from '../profile/DoisFatoresCard';
import { EmailCard } from '../profile/EmailCard';
import { TelefoneCard } from '../profile/TelefoneCard';
import { ImageUploadButton } from '../../components/ImageUploadButton';
import { profileIdentity } from '../../lib/documents';
import { CompanyTag } from '../../components/CompanyTag';
import { CpfCard } from '../profile/CpfCard';
import { EmpresaCard } from '../profile/EmpresaCard';

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
    <section className="card wide" id="avaliacoes">
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
                  {r.reviewerCompany && <CompanyTag company={r.reviewerCompany} />}
                  <span className="muted tiny">{dtm(r.createdAt)}</span>
                </div>
                <p>{r.comment ?? <span className="muted">Sem comentário.</span>}</p>
                {r.response ? (
                  <div className="review-response">
                    <strong>Sua resposta</strong>
                    <p>{r.response}</p>
                  </div>
                ) : (
                  <BusinessForm
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
                  </BusinessForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}

/**
 * As seções da página, na ordem em que aparecem: [âncora, rótulo] da navegação lateral. A conta de
 * empresa (RF-018) tem os dados da empresa no lugar dos de cliente; "Dados para receber" (o CPF,
 * RF-020) aparece para quem tem perfil de freelancer ou entrega trabalho.
 */
export function profileSections(
  freelancer: boolean,
  opts: { company?: boolean; payout?: boolean } = {},
): [string, string][] {
  return [
    ['perfil-publico', 'Seu perfil'],
    ...(freelancer
      ? ([
          ['score', 'Escambo Score'],
          ['avaliacoes', 'Avaliações'],
          ['dados-freelancer', 'Dados de freelancer'],
        ] as [string, string][])
      : []),
    (opts.company
      ? ['dados-empresa', 'Dados da empresa']
      : ['dados-cliente', 'Dados de cliente']) as [string, string],
    ...(opts.payout ? ([['dados-recebimento', 'Dados para receber']] as [string, string][]) : []),
    ...(freelancer ? ([['portfolio', 'Portfólio']] as [string, string][]) : []),
    ['email-pref-title', 'E-mails do Escambo'],
    ['push-title', 'Avisos no navegador'],
    ['email-title', 'E-mail da conta'],
    ['telefone-title', 'Telefone'],
    ['senha', 'Senha'],
    ['dois-fatores', 'Verificação em duas etapas'],
    ['privacidade', 'Privacidade e dados'],
  ];
}

export function PerfilView() {
  usePageTitle('Perfil');
  // O painel admin manda para /perfil#dois-fatores quando exige a 2FA: rola até o cartão.
  useScrollToHashWhenSettled();
  const { user } = useAuth();
  const profiles = useProfilesMe();
  const putFreelancer = usePutFreelancerProfile();
  const putClient = usePutClientProfile();
  const cpf = useCpfStatus();
  const toast = useToast();
  // Conta de empresa (RF-018): os dados da empresa no lugar dos de cliente, e sem o formulário de
  // freelancer, a não ser que a conta já tenha esse perfil.
  const isCompany = user?.role === 'company';

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

  /**
   * "Dados para receber" (RF-020): para quem tem perfil de freelancer, se cadastrou como freelancer
   * ou entrega trabalho (o saque pede o CPF). Quem só contrata não vê.
   */
  const showPayout = (hasFreelancer: boolean): boolean =>
    hasFreelancer || user?.role === 'freelancer' || cpf.data?.required === true;

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
      <PageHeader
        title="Perfil"
        subtitle="Como você aparece para clientes e freelancers."
        action={<Link to="/suporte">Falar com o suporte</Link>}
      />
      <QueryState
        isLoading={profiles.isLoading}
        error={profiles.error}
        data={profiles.data}
        onRetry={() => void profiles.refetch()}
      >
        {(p) => (
          <div className="settings-layout">
            {/* Atalhos para as seções desta página longa (âncoras comuns): no desktop uma coluna
                presa à esquerda; no celular, uma fileira que rola de lado. Lista com nome, e não
                <nav>, como as migalhas: nada de marco de navegação no meio do conteúdo. */}
            <div className="settings-nav">
              <ul aria-label="Seções do perfil">
                {profileSections(!!p.freelancer, {
                  company: isCompany,
                  payout: showPayout(p.freelancer !== null),
                }).map(([hash, label]) => (
                  <li key={hash}>
                    <a href={`#${hash}`}>{label}</a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="settings-main">
              {/* Como os outros te veem: a capa, a foto grande, o nome, a linha de apresentação e,
                para quem é freelancer, o atalho para o perfil público. */}
              <section
                className="card wide profile-card own"
                id="perfil-publico"
                aria-labelledby="me-name"
              >
                <div className="profile-cover" aria-hidden="true" />
                <div className="profile-hero">
                  <Avatar
                    url={profileIdentity(p).avatarUrl}
                    name={profileIdentity(p).name ?? user?.email ?? '?'}
                    size="lg"
                  />
                  <div className="profile-names">
                    <h2 id="me-name">{profileIdentity(p).name ?? user?.email ?? 'Seu perfil'}</h2>
                    <p className="profile-headline">
                      {p.company
                        ? p.company.legalName
                        : p.freelancer?.headline ||
                          (p.freelancer ? 'Freelancer no Escambo' : 'Cliente no Escambo')}
                    </p>
                    <div className="profile-meta">
                      {(p.company ?? p.freelancer ?? p.client)?.city && (
                        <span className="muted tiny">
                          <MapPin size={12} aria-hidden="true" />{' '}
                          {(p.company ?? p.freelancer ?? p.client)?.city}
                          {(p.company ?? p.freelancer)?.state
                            ? `, ${(p.company ?? p.freelancer)?.state}`
                            : ''}
                        </span>
                      )}
                      {isCompany && <span className="chip level">Empresa</span>}
                      {p.freelancer && <span className="chip rank">Freelancer</span>}
                      {p.client && !isCompany && <span className="chip level">Cliente</span>}
                      {user?.email && <span className="muted tiny">{user.email}</span>}
                    </div>
                  </div>
                  {p.company && user?.ulid && (
                    <div className="stack profile-actions">
                      <Link to={`/empresas/${user.ulid}`} className="btn secondary">
                        <Eye size={16} aria-hidden="true" /> Ver a página da empresa
                      </Link>
                    </div>
                  )}
                  {!p.company && p.freelancer && user?.ulid && (
                    <div className="stack profile-actions">
                      <Link to={`/freelancers/${user.ulid}`} className="btn secondary">
                        <Eye size={16} aria-hidden="true" /> Ver meu perfil público
                      </Link>
                    </div>
                  )}
                </div>
              </section>
              {/* Escambo Score (diferencial #3) — reputação multifator explicável */}
              {p.freelancer && (
                <section className="card wide" id="score">
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
              {p.freelancer && <DesistenciasCard />}

              {(!isCompany || p.freelancer) && (
                <BusinessForm className="card" id="dados-freelancer" onSubmit={saveFreelancer}>
                  <h3>
                    <Briefcase size={16} /> Freelancer
                  </h3>
                  <Field label="Nome">
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
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
                        purpose="avatar"
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
                    <Input
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      autoComplete="address-level2"
                    />
                  </Field>
                  <Field label="Estado (UF)">
                    <Input
                      value={stateUf}
                      onChange={(e) => setStateUf(e.target.value)}
                      autoComplete="address-level1"
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
                          18h–24h no horário de {timezoneLabel(user?.timezone)}, o fuso da sua conta
                          (muda em "E-mails do Escambo").
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
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={locateMe}
                        disabled={locating}
                      >
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
                </BusinessForm>
              )}

              {showPayout(p.freelancer !== null) && <CpfCard />}

              {isCompany ? (
                <EmpresaCard company={p.company} />
              ) : (
                <BusinessForm className="card" id="dados-cliente" onSubmit={saveClient}>
                  <h3>
                    <User size={16} /> Cliente{' '}
                    {p.client && <span className="chip rank">ativo</span>}
                  </h3>
                  <Field label="Nome">
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
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
                        purpose="avatar"
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
                    <Input
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      autoComplete="address-level2"
                    />
                  </Field>
                  <Button type="submit" disabled={putClient.isPending}>
                    Salvar cliente
                  </Button>
                </BusinessForm>
              )}

              <ModeracaoCard />
              {p.freelancer && (
                <div id="portfolio" className="settings-anchor">
                  <PortfolioCard />
                </div>
              )}
              <EmailPreferencesCard />
              <PushCard />
              <EmailCard />
              <TelefoneCard />
              <div id="senha" className="settings-anchor">
                <SenhaCard />
              </div>
              <DoisFatoresCard />
              <div id="privacidade" className="settings-anchor">
                <PrivacidadeCard />
              </div>
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}
