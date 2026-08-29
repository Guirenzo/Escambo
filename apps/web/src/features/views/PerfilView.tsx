import { useEffect, useState, type FormEvent } from 'react';
import type { ClientProfile, FreelancerProfile } from '@escambo/types';
import { api } from '../../lib/api';

export function PerfilView() {
  const [freelancer, setFreelancer] = useState<FreelancerProfile | null>(null);
  const [client, setClient] = useState<ClientProfile | null>(null);
  const [name, setName] = useState('');
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [city, setCity] = useState('');
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .profilesMe()
      .then((p) => {
        setFreelancer(p.freelancer);
        setClient(p.client);
        const base = p.freelancer ?? p.client;
        if (base) {
          setName(base.fullName);
          setCity(base.city ?? '');
        }
        if (p.freelancer) {
          setHeadline(p.freelancer.headline ?? '');
          setBio(p.freelancer.bio ?? '');
        }
      })
      .catch(() => undefined);
  }, []);

  async function saveFreelancer(e: FormEvent) {
    e.preventDefault();
    setOk(null);
    setError(null);
    try {
      const p = await api.putFreelancerProfile({ fullName: name, headline, bio, city });
      setFreelancer(p);
      setOk('Perfil de freelancer salvo!');
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro');
    }
  }
  async function saveClient(e: FormEvent) {
    e.preventDefault();
    setOk(null);
    setError(null);
    try {
      const p = await api.putClientProfile({ fullName: name, city });
      setClient(p);
      setOk('Perfil de cliente salvo!');
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro');
    }
  }

  return (
    <div className="view">
      <h2>Perfil</h2>
      {ok && <p className="ok">{ok}</p>}
      {error && <p className="error">{error}</p>}
      <div className="grid">
        <form className="card" onSubmit={saveFreelancer}>
          <h3>
            👩‍💻 Freelancer{' '}
            {freelancer && <span className="chip rank">⭐ {freelancer.avgRating.toFixed(1)}</span>}
          </h3>
          <label>
            Nome
            <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </label>
          <label>
            Headline
            <input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Dev Full Stack | 5 anos" />
          </label>
          <label>
            Bio
            <input value={bio} onChange={(e) => setBio(e.target.value)} />
          </label>
          <label>
            Cidade
            <input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <button type="submit">Salvar freelancer</button>
        </form>

        <form className="card" onSubmit={saveClient}>
          <h3>🙋 Cliente {client && <span className="chip rank">ativo</span>}</h3>
          <label>
            Nome
            <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </label>
          <label>
            Cidade
            <input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <button type="submit">Salvar cliente</button>
        </form>
      </div>
    </div>
  );
}
