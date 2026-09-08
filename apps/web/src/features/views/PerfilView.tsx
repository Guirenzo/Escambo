import { Briefcase, ShieldCheck, Star, User } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ScoreBadge } from '../../components/ScoreBadge';
import { Stars } from '../../components/Stars';
import { Button, Field, Input, PageHeader, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { dtm } from '../../lib/format';
import {
  useFreelancerReviews,
  useProfilesMe,
  usePutClientProfile,
  usePutFreelancerProfile,
  useRespondReview,
} from '../../lib/hooks';
import { useToast } from '../../lib/toast';

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
  const { user } = useAuth();
  const profiles = useProfilesMe();
  const putFreelancer = usePutFreelancerProfile();
  const putClient = usePutClientProfile();
  const toast = useToast();

  const [name, setName] = useState('');
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [city, setCity] = useState('');

  // Preenche o formulário quando o perfil chega.
  useEffect(() => {
    const p = profiles.data;
    if (!p) return;
    const base = p.freelancer ?? p.client;
    if (base) {
      setName(base.fullName);
      setCity(base.city ?? '');
    }
    if (p.freelancer) {
      setHeadline(p.freelancer.headline ?? '');
      setBio(p.freelancer.bio ?? '');
    }
  }, [profiles.data]);

  async function saveFreelancer(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await putFreelancer.mutateAsync({ fullName: name, headline, bio, city });
      toast.success('Perfil de freelancer salvo!');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro');
    }
  }

  async function saveClient(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await putClient.mutateAsync({ fullName: name, city });
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
              <Field label="Cidade">
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
              </Field>
              <Button type="submit" disabled={putClient.isPending}>
                Salvar cliente
              </Button>
            </form>
          </div>
        )}
      </QueryState>
    </div>
  );
}
