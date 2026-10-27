import { ArrowLeft, Building2, CalendarDays, Globe, MapPin } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { Button, QueryState } from '../../components/ui';
import { formatCnpj } from '../../lib/documents';
import { dt } from '../../lib/format';
import { usePublicCompany } from '../../lib/hooks';
import { usePageTitle } from '../../lib/title';

/** Só http(s) vira link (a API já recusa o resto; isto segura um dado antigo ou editado à mão). */
const safeSite = (url: string | null): string | null =>
  url && /^https?:\/\//i.test(url) ? url : null;

/** O endereço sem o protocolo e a barra final, para ler: paobom.com.br. */
const siteLabel = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

/**
 * Página pública da empresa (RF-018): logo, nome fantasia, razão social, CNPJ com máscara (dado
 * público), site, descrição curta e cidade. É para onde leva o nome da empresa que aparece na
 * Sala, nas propostas e nas avaliações.
 */
export function EmpresaView() {
  const { ulid } = useParams();
  const navigate = useNavigate();
  const company = usePublicCompany(ulid);
  usePageTitle(company.data?.tradeName ?? 'Empresa');

  return (
    <div className="page">
      <div>
        <Button variant="ghost" className="mini" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> Voltar
        </Button>
      </div>
      <QueryState
        isLoading={company.isLoading}
        error={company.error}
        data={company.data}
        onRetry={() => void company.refetch()}
      >
        {(c) => {
          const site = safeSite(c.website);
          return (
            <section className="card profile-card" aria-labelledby="company-name">
              <div className="profile-cover" aria-hidden="true" />
              <div className="profile-hero">
                <Avatar url={c.logoUrl} name={c.tradeName} size="lg" />
                <div className="profile-names">
                  <h1 id="company-name">{c.tradeName}</h1>
                  <p className="profile-headline">{c.legalName}</p>
                  <div className="profile-meta">
                    <span className="chip level company-seal">
                      <Building2 size={12} aria-hidden="true" /> Empresa
                    </span>
                    {(c.city || c.state) && (
                      <span className="muted tiny">
                        <MapPin size={12} aria-hidden="true" />{' '}
                        {[c.city, c.state].filter(Boolean).join(', ')}
                      </span>
                    )}
                    <span className="muted tiny">
                      <CalendarDays size={12} aria-hidden="true" /> no Escambo desde{' '}
                      {dt(c.memberSince)}
                    </span>
                  </div>
                </div>
              </div>
              {c.bio && <p className="profile-bio">{c.bio}</p>}
              <dl className="lookup-list company-facts">
                <div>
                  <dt className="muted tiny">CNPJ</dt>
                  <dd data-testid="company-cnpj">{formatCnpj(c.cnpj)}</dd>
                </div>
                {site && (
                  <div>
                    <dt className="muted tiny">Site</dt>
                    <dd>
                      <a href={site} target="_blank" rel="noopener noreferrer nofollow ugc">
                        <Globe size={14} aria-hidden="true" /> {siteLabel(site)}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          );
        }}
      </QueryState>
    </div>
  );
}
