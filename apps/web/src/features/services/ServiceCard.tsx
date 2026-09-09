import { Heart, Rocket } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { Stars } from '../../components/Stars';
import { Button } from '../../components/ui';
import { brl } from '../../lib/format';

/** Card de serviço da busca e do perfil público: quem presta, preço, distância, favorito e ações. */
export function ServiceCard({
  service: s,
  mine,
  onContratar,
  onBoost,
  showOwner = true,
  favorited,
  onToggleFavorite,
}: {
  service: Service;
  mine: boolean;
  onContratar: (s: Service) => void;
  onBoost: (s: Service) => void;
  showOwner?: boolean;
  favorited?: boolean;
  onToggleFavorite?: (s: Service) => void;
}) {
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
          {s.isRemote && <span className="tag">remoto</span>}
          {onToggleFavorite && !mine && (
            <button
              type="button"
              className={`fav-btn ${favorited ? 'on' : ''}`}
              aria-pressed={!!favorited}
              aria-label={favLabel}
              title={favLabel}
              onClick={() => onToggleFavorite(s)}
            >
              <Heart size={15} />
            </button>
          )}
        </span>
      </div>
      {showOwner && s.ownerName && (
        <div className="svc-owner">
          <span className="svc-owner-ini" aria-hidden="true">
            {s.ownerName[0]}
          </span>
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
      <p className="muted clamp">{s.description}</p>
      <div className="svc-foot">
        <span className="price">{s.price != null ? brl(s.price) : 'a combinar'}</span>
        <span className="muted tiny">
          {s.distanceKm != null
            ? `${s.distanceKm} km de você`
            : s.deliveryDays != null
              ? `${s.deliveryDays} dias`
              : ''}
        </span>
      </div>
      <div className="svc-actions">
        {mine ? (
          <Button variant="mini" onClick={() => onBoost(s)} disabled={s.boosted}>
            <Rocket size={14} /> {s.boosted ? 'Impulsionado' : 'Impulsionar'}
          </Button>
        ) : (
          <Button variant="mini" onClick={() => onContratar(s)}>
            Contratar
          </Button>
        )}
      </div>
    </div>
  );
}
