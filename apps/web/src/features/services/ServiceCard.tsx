import { BusinessButton, BusinessIconButton } from '../../components/BusinessActions';
import { ArrowLeftRight, Heart, Pause, Pencil, Play, Rocket } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { Avatar } from '../../components/Avatar';
import { Stars } from '../../components/Stars';
import { brl, formatAvailability } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { usePublicSettings } from '../../lib/hooks';
import { zoneNote } from '../../lib/timezones';

/** Preço como o anúncio mostra: por hora leva "/h"; sem preço (ou a combinar) é "a combinar". */
export function servicePrice(s: Pick<Service, 'priceType' | 'price'>): string {
  if (s.priceType === 'negotiable' || s.price == null) return 'a combinar';
  return s.priceType === 'hourly' ? `${brl(s.price)}/h` : brl(s.price);
}

/**
 * Card de serviço da busca, do perfil público e de "Meus serviços": quem presta, preço, prazo,
 * distância, modalidade, favorito e ações. Em "Meus serviços" o dono também edita, pausa e reativa.
 */
export function ServiceCard({
  service: s,
  mine,
  onContratar,
  onBoost,
  showOwner = true,
  favorited,
  onToggleFavorite,
  onProposeBarter,
  onEdit,
  onToggleActive,
  toggling = false,
}: {
  service: Service;
  mine: boolean;
  onContratar: (s: Service) => void;
  onBoost: (s: Service) => void;
  showOwner?: boolean;
  favorited?: boolean;
  onToggleFavorite?: (s: Service) => void;
  /** Só para freelancers: propor troca do próprio serviço por este. */
  onProposeBarter?: (s: Service) => void;
  /** Só em "Meus serviços": abre a edição do serviço. */
  onEdit?: (s: Service) => void;
  /** Só em "Meus serviços": pausa o ativo e reativa o pausado (RF-030). */
  onToggleActive?: (s: Service) => void;
  /** A pausa ou a reativação deste serviço está em andamento. */
  toggling?: boolean;
}) {
  const barterEnabled = usePublicSettings().data?.barterEnabled ?? true;
  const viewerZone = useAuth().user?.timezone;
  const favLabel = favorited ? 'Remover dos favoritos' : 'Favoritar';
  return (
    <div className="card service">
      <div className="svc-top">
        <strong>{s.title}</strong>
        <span className="svc-actions">
          {s.boosted && (
            <span className="chip level">
              <Rocket size={12} /> Destaque
            </span>
          )}
          {!s.isActive && <span className="pill status-pending">Pausado</span>}
          <span className="tag">{s.isRemote ? 'remoto' : 'presencial'}</span>
          {onToggleFavorite && !mine && (
            <BusinessIconButton
              type="button"
              className={`fav-btn ${favorited ? 'on' : ''}`}
              aria-pressed={!!favorited}
              aria-label={favLabel}
              title={favLabel}
              onClick={() => onToggleFavorite(s)}
            >
              <Heart size={15} />
            </BusinessIconButton>
          )}
        </span>
      </div>
      {showOwner && s.ownerName && (
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
          {s.ownerAvailableNow && (
            <span className="chip now" data-testid="owner-now">
              atende agora
            </span>
          )}
          {!!s.ownerAvailableDays?.length && (
            <span className="chip days" data-testid="owner-days">
              atende {formatAvailability(s.ownerAvailableDays, s.ownerAvailablePeriods)}
              {zoneNote(s.ownerTimezone, viewerZone)}
            </span>
          )}
        </div>
      )}
      <p className="muted clamp">{s.description}</p>
      {!s.isActive && (
        <p className="muted tiny" data-testid="paused-note">
          Fora da busca e sem propostas novas. Os contratos em andamento continuam.
        </p>
      )}
      <div className="svc-foot">
        <span className="price">{servicePrice(s)}</span>
        <span className="muted tiny">
          {s.distanceKm != null
            ? `${s.distanceKm} km de você`
            : s.deliveryDays != null
              ? `${s.deliveryDays} ${s.deliveryDays === 1 ? 'dia' : 'dias'}`
              : ''}
        </span>
      </div>
      <div className="svc-actions">
        {mine ? (
          <>
            {/* Serviço pausado não é impulsionado (RN-017). */}
            {s.isActive && (
              <BusinessButton variant="mini" onClick={() => onBoost(s)} disabled={s.boosted}>
                <Rocket size={14} /> {s.boosted ? 'Impulsionado' : 'Impulsionar'}
              </BusinessButton>
            )}
            {onEdit && (
              <BusinessButton variant="mini" onClick={() => onEdit(s)}>
                <Pencil size={14} /> Editar
              </BusinessButton>
            )}
            {onToggleActive && (
              <BusinessButton variant="mini" onClick={() => onToggleActive(s)} disabled={toggling}>
                {s.isActive ? <Pause size={14} /> : <Play size={14} />}{' '}
                {toggling ? 'Salvando…' : s.isActive ? 'Pausar' : 'Reativar'}
              </BusinessButton>
            )}
          </>
        ) : (
          <>
            <BusinessButton variant="mini" onClick={() => onContratar(s)}>
              Contratar
            </BusinessButton>
            {onProposeBarter && barterEnabled && (
              <BusinessButton variant="mini" onClick={() => onProposeBarter(s)}>
                <ArrowLeftRight size={14} /> Propor troca
              </BusinessButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}
