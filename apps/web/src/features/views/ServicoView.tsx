import { ArrowLeft, ArrowLeftRight, Heart, Rocket } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PackageTier, Service } from '@escambo/types';
import { BusinessButton, BusinessIconButton } from '../../components/BusinessActions';
import { Avatar } from '../../components/Avatar';
import { Stars } from '../../components/Stars';
import { Button, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useFavorites, usePublicSettings, useService, useToggleFavorite } from '../../lib/hooks';
import { usePageTitle } from '../../lib/title';
import { ContratarModal } from '../services/ContratarModal';
import { modalityTag, servicePrice, ServiceTags } from '../services/ServiceCard';
import { PackageCompare, PackagePicker } from '../services/PackagePicker';
import { packagesOf } from '../services/packages';

/**
 * Detalhe do serviço (/servicos/:id): a descrição inteira, quem presta, preço, prazo, modalidade e
 * as tags, que levam à busca por elas (RF-024). Abrir a página soma uma visualização para o dono
 * (RF-029), que a API conta só quando quem abre não é ele; o número fica em "Meus serviços". Com
 * pacotes (RF-086), o cartão dos pacotes fica ao lado (embaixo do título no celular), e a tabela
 * "Comparar pacotes" vem depois da descrição.
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
  // A proposta aberta: false fechada; com pacotes, o nível escolhido.
  const [contratar, setContratar] = useState<false | true | PackageTier>(false);
  const packages = packagesOf(s);
  const canHire = !mine && s.isActive;
  const favButton = (
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
  );
  const barter =
    user?.role === 'freelancer' && barterEnabled ? (
      <BusinessButton variant="secondary" onClick={() => navigate(`/trocas?propor=${s.id}`)}>
        <ArrowLeftRight size={14} /> Propor troca
      </BusinessButton>
    ) : null;
  const unavailable = mine ? (
    <p className="muted tiny" data-testid="own-service">
      Este serviço é seu. Quantas vezes ele foi visto aparece em “Meus serviços”.
    </p>
  ) : !s.isActive ? (
    <p className="muted tiny" data-testid="paused-note">
      Pausado pelo prestador: não recebe propostas novas por enquanto.
    </p>
  ) : null;
  const owner = s.ownerName && (
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
  );
  const flags = (
    <>
      {s.boosted && (
        <span className="chip level">
          <Rocket size={12} /> Destaque
        </span>
      )}
      {!s.isActive && <span className="pill status-pending">Pausado</span>}
      <span className="tag">{modalityTag(s)}</span>
    </>
  );
  const modal = contratar !== false && (
    <ContratarModal
      service={s}
      initialTier={contratar === true ? undefined : contratar}
      onClose={() => setContratar(false)}
    />
  );

  if (packages.length > 0) {
    return (
      <article className="svc-detail-pkgs" aria-labelledby="svc-detail-title">
        <div className="card svc-detail svc-detail-head">
          <div className="svc-top">
            <h1 id="svc-detail-title">{s.title}</h1>
            <span className="svc-actions">
              {flags}
              {canHire && favButton}
            </span>
          </div>
          {owner}
        </div>
        <div className="svc-detail-side">
          <PackagePicker
            packages={packages}
            onContinue={canHire ? (tier) => setContratar(tier) : undefined}
            extra={barter}
            notice={unavailable}
          />
        </div>
        <div className="card svc-detail svc-detail-body">
          <h2>Sobre o serviço</h2>
          <p className="svc-description">{s.description}</p>
          <ServiceTags tags={s.tags} />
        </div>
        <PackageCompare
          packages={packages}
          onChoose={canHire ? (tier) => setContratar(tier) : undefined}
        />
        {modal}
      </article>
    );
  }

  return (
    <article className="card svc-detail" aria-labelledby="svc-detail-title">
      <div className="svc-top">
        <h1 id="svc-detail-title">{s.title}</h1>
        <span className="svc-actions">{flags}</span>
      </div>

      {owner}

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

      {unavailable ?? (
        <div className="svc-actions">
          <BusinessButton onClick={() => setContratar(true)}>Contratar</BusinessButton>
          {barter}
          {favButton}
        </div>
      )}

      {modal}
    </article>
  );
}
