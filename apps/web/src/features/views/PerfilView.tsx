import { useEffect, useState, type FormEvent } from 'react';
import { ScoreBadge } from '../../components/ScoreBadge';
import { Button, Field, Input, PageHeader, QueryState } from '../../components/ui';
import { useProfilesMe, usePutClientProfile, usePutFreelancerProfile } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

export function PerfilView() {
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
    <div className="view">
      <PageHeader title="Perfil" />
      <QueryState isLoading={profiles.isLoading} error={profiles.error} data={profiles.data} onRetry={() => void profiles.refetch()}>
        {(p) => (
          <div className="grid">
            {/* Escambo Score (diferencial #3) — reputação multifator explicável */}
            {p.freelancer && (
              <section className="card wide">
                <h3>
                  🛡️ Escambo Score
                  <span className="chip rank">⭐ {p.freelancer.avgRating.toFixed(1)}</span>
                  <span className="muted tiny">
                    {p.freelancer.totalReviews} avaliações · {p.freelancer.totalContracts} contratos
                  </span>
                </h3>
                <ScoreBadge score={p.freelancer.escamboScore} detailed />
                <p className="muted tiny">
                  Qualidade (nota), experiência (contratos), prova social (avaliações) e responsividade (tempo de
                  resposta), ponderadas em um índice de confiança de 0 a 100.
                </p>
              </section>
            )}

            <form className="card" onSubmit={saveFreelancer}>
              <h3>👩‍💻 Freelancer</h3>
              <Field label="Nome">
                <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
              </Field>
              <Field label="Headline">
                <Input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Dev Full Stack | 5 anos" />
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
              <h3>🙋 Cliente {p.client && <span className="chip rank">ativo</span>}</h3>
              <Field label="Nome">
                <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
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
