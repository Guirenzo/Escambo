import { ArrowLeft, ArrowLeftRight, Heart, Rocket } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { BusinessButton, BusinessIconButton } from '../../components/BusinessActions';
import { Avatar } from '../../components/Avatar';
import { Stars } from '../../components/Stars';
import { Button, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useFavorites, usePublicSettings, useService, useToggleFavorite } from '../../lib/hooks';
import { usePageTitle } from '../../lib/title';
import { ContratarModal } from '../services/ContratarModal';
import { modalityTag, servicePrice, ServiceTags } from '../services/ServiceCard';

/**
 * Detalhe do serviço (/servicos/:id): a descrição inteira, quem presta, preço, prazo, modalidade e
 * as tags, que levam à busca por elas (RF-024). Abrir a página soma uma visualização para o dono
 * (RF-029), que a API conta só quando quem abre não é ele; o número fica em "Meus serviços".
 */
export function ServicoView({ serviceId }: { serviceId: number }) {
  const navigate = useNavigate();
  const service = useService(serviceId);
  usePageTitle(service.data?.title ?? 'Serviço');

  return (
    <div className="page">
      <div>
        <Button variant="ghost" className="mini" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> Voltar
        </Button>
      </div>
      <QueryState
        isLoading={service.isLoading}
        error={service.error}
        data={service.data}
        onRetry={() => void service.refetch()}
      >
        {(s) => <ServiceDetail service={s} />}
      </QueryState>
    </div>
  );
}

function ServiceDetail({ service: s }: { service: Service }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const mine = s.ownerId === user?.id;
  const barterEnabled = usePublicSettings().data?.barterEnabled ?? true;
  const favorites = useFavorites();
  const toggleFav = useToggleFavorite();
  const favorited = !!favorites.data?.some(
    (f) => f.targetType === 'service' && f.targetId === s.id,
  );
  const favLabel = favorited ? 'Remover dos favoritos' : 'Favoritar';
  const [contratar, setContratar] = useState(false);

  return (
    <article className="card svc-detail" aria-labelledby="svc-detail-title">
      <div className="svc-top">
        <h1 id="svc-detail-title">{s.title}</h1>
        <span className="svc-actions">
          {s.boosted && (
            <span className="chip level">
              <Rocket size={12} /> Destaque
            </span>
          )}
          {!s.isActive && <span className="pill status-pending">Pausado</span>}
          <span className="tag">{modalityTag(s)}</span>
        </span>
      </div>

      {s.ownerName && (
        <div className="svc-owner">
          <Avatar url={s.ownerAvatarUrl} name={s.ownerName} size="xs" />
          {s.ownerUlid ? (
            <Link to={`/freelancers/${s.ownerUlid}`} className="muted tiny">
              {s.ownerName}
            </Link>
          ) : (
            <span className="muted tiny">{s.ownerName}</span>
          )}
          <Stars value={s.ownerRating ?? 0} count={s.ownerReviews ?? 0} size={12} />
        </div>
      )}

      <div className="svc-foot">
        <span className="price">{servicePrice(s)}</span>
        {s.deliveryDays != null && (
          <span className="muted tiny">
            entrega em {s.deliveryDays} {s.deliveryDays === 1 ? 'dia' : 'dias'}
          </span>
        )}
      </div>

      <p className="svc-description">{s.description}</p>
      <ServiceTags tags={s.tags} />

      {mine ? (
        <p className="muted tiny" data-testid="own-service">
          Este serviço é seu. Quantas vezes ele foi visto aparece em “Meus serviços”.
        </p>
      ) : !s.isActive ? (
        <p className="muted tiny" data-testid="paused-note">
          Pausado pelo prestador: não recebe propostas novas por enquanto.
        </p>
      ) : (
        <div className="svc-actions">
          <BusinessButton onClick={() => setContratar(true)}>Contratar</BusinessButton>
          {user?.role === 'freelancer' && barterEnabled && (
            <BusinessButton variant="secondary" onClick={() => navigate(`/trocas?propor=${s.id}`)}>
              <ArrowLeftRight size={14} /> Propor troca
            </BusinessButton>
          )}
          <BusinessIconButton
            type="button"
            className={`fav-btn ${favorited ? 'on' : ''}`}
            aria-pressed={favorited}
            aria-label={favLabel}
            title={favLabel}
            onClick={() => toggleFav.mutate({ targetType: 'service', targetId: s.id, favorited })}
          >
            <Heart size={15} />
          </BusinessIconButton>
        </div>
      )}

      {contratar && <ContratarModal service={s} onClose={() => setContratar(false)} />}
    </article>
  );
}
