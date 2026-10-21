import { BusinessButton, BusinessIconButton } from '../../components/BusinessActions';
import {
  ArrowLeftRight,
  Eye,
  Heart,
  MapPin,
  Pause,
  Pencil,
  Play,
  Rocket,
  Star,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { Avatar } from '../../components/Avatar';
import { brl, formatAvailability } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { usePublicSettings } from '../../lib/hooks';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
import { zoneNote } from '../../lib/timezones';
import { categoryArt, categoryPhoto } from './categoryArt';
import { MODALITY_LABEL, modalityOf } from './ServiceForm';
import { tagSearchPath } from './tags';

/** Preço como o anúncio mostra: por hora leva "/h"; sem preço (ou a combinar) é "a combinar". */
export function servicePrice(s: Pick<Service, 'priceType' | 'price'>): string {
  if (s.priceType === 'negotiable' || s.price == null) return 'a combinar';
  return s.priceType === 'hourly' ? `${brl(s.price)}/h` : brl(s.price);
}

/** Modalidade no selo do card e do detalhe: "remoto", "presencial" ou "remoto e presencial". */
export const modalityTag = (s: Pick<Service, 'modality' | 'isRemote'>): string =>
  MODALITY_LABEL[modalityOf(s)].toLowerCase();

/** "1 visualização", "12 visualizações" (RF-029). */
export const viewsLabel = (n: number): string =>
  `${n.toLocaleString('pt-BR')} ${n === 1 ? 'visualização' : 'visualizações'}`;

/** As tags do serviço; cada uma é um link para a busca por ela (RF-024). */
export function ServiceTags({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null;
  return (
    <ul className="svc-tags" aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag}>
          <Link to={tagSearchPath(tag)} className="svc-tag" aria-label={`Buscar pela tag ${tag}`}>
            {tag}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Capa do card: a primeira imagem do portfólio de quem presta; sem ela (ou se não carregar), a foto
 * da categoria com o nome da categoria num selo (para não passar por foto de quem presta); sem foto
 * de categoria, o tom e o ícone dela. É decorativa: o título e o resto do card dizem do que se trata.
 */
function Cover({
  url,
  categorySlug,
  categoryName,
  seed,
}: {
  url?: string | null;
  categorySlug?: string;
  categoryName?: string;
  /** O id do serviço: alterna as fotos da categoria entre os cards. */
  seed: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const { Icon, tone } = categoryArt(categorySlug);
  const src = url && failed !== url ? mediaVariant(url, MEDIA_THUMB.card) : null;
  const photo = src ? null : categoryPhoto(categorySlug, seed);
  return (
    <div
      className={`svc-cover cover-${tone}${photo ? ' with-photo' : ''}`}
      aria-hidden="true"
      data-cover={src ? 'portfolio' : photo ? 'category' : 'icon'}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={640}
          height={400}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(url ?? null)}
        />
      ) : photo ? (
        <>
          <img
            className="svc-cover-photo"
            src={photo.src}
            srcSet={photo.srcSet}
            sizes="(max-width: 720px) 92vw, 18rem"
            alt=""
            width={400}
            height={500}
            loading="lazy"
          />
          {categoryName && (
            <span className="svc-cover-cat">
              <Icon size={12} /> {categoryName}
            </span>
          )}
        </>
      ) : (
        <span className="svc-cover-art">
          <Icon size={34} strokeWidth={1.75} />
        </span>
      )}
    </div>
  );
}

/** Nota compacta (estrela + média + quantas), lida como uma frase: "4.5 de 5, 12 avaliações". */
function Rating({ value, count }: { value: number; count: number }) {
  const label = `${value.toFixed(1)} de 5, ${count} avaliações`;
  return (
    <span className="svc-rating" role="img" aria-label={label} title={label}>
      <Star size={14} aria-hidden="true" className={count > 0 ? 'on' : undefined} />
      {count > 0 ? (
        <>
          <strong>{value.toFixed(1)}</strong>
          <span className="muted">({count})</span>
        </>
      ) : (
        <span className="muted">Novo</span>
      )}
    </span>
  );
}

/**
 * Card de serviço estilo marketplace (busca, perfil público, "Meus serviços" e o "Perto de você" do
 * Início): capa, quem presta com o avatar sobre a borda da capa, título, cidade ou distância, nota,
 * "a partir de" e o selo "Aceita troca". O título é o link do card inteiro (um só alvo de foco); o
 * favorito, o nome de quem presta, as tags e os botões ficam por cima, cada um com o seu alvo. Em
 * "Meus serviços" o dono também vê as visualizações (RF-029), edita, pausa e reativa. No modo
 * `compact` (carrossel) ficam só a capa e o essencial, sem descrição, tags nem botões.
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
  categorySlug,
  categoryName,
  compact = false,
}: {
  service: Service;
  mine: boolean;
  onContratar?: (s: Service) => void;
  onBoost?: (s: Service) => void;
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
  /** A categoria raiz (o slug), para o desenho da capa sem imagem. */
  categorySlug?: string;
  /** O nome da categoria raiz, no selo da capa com a foto da categoria. */
  categoryName?: string;
  /** Carrossel: capa e essencial, sem descrição, tags e ações. */
  compact?: boolean;
}) {
  const barterEnabled = usePublicSettings().data?.barterEnabled ?? true;
  const viewerZone = useAuth().user?.timezone;
  const favLabel = favorited ? 'Remover dos favoritos' : 'Favoritar';
  const owner = showOwner && s.ownerName ? s.ownerName : null;
  // Todo serviço no ar pode receber proposta de troca de outro freelancer (RN-013).
  const acceptsBarter = barterEnabled && !mine && s.isActive;
  const price = servicePrice(s);
  const where =
    s.distanceKm != null ? `${s.distanceKm} km de você` : owner && s.ownerCity ? s.ownerCity : null;
  const delivery =
    s.distanceKm == null && s.deliveryDays != null
      ? `${s.deliveryDays} ${s.deliveryDays === 1 ? 'dia' : 'dias'}`
      : null;
  return (
    <article
      className={[
        'card service svc-card',
        compact ? 'compact' : '',
        owner ? 'with-owner' : '',
        s.isActive ? '' : 'paused',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Cover
        url={s.ownerCoverUrl}
        categorySlug={categorySlug}
        categoryName={categoryName}
        seed={s.id}
      />
      {(s.boosted || !s.isActive) && (
        <div className="svc-flags">
          {s.boosted && (
            <span className="svc-flag">
              <Rocket size={12} aria-hidden="true" /> Destaque
            </span>
          )}
          {!s.isActive && <span className="pill status-pending">Pausado</span>}
        </div>
      )}
      {onToggleFavorite && !mine && (
        <BusinessIconButton
          type="button"
          className={`fav-btn ${favorited ? 'on' : ''}`}
          aria-pressed={!!favorited}
          aria-label={favLabel}
          title={favLabel}
          onClick={() => onToggleFavorite(s)}
        >
          <Heart size={16} />
        </BusinessIconButton>
      )}

      <div className="svc-body">
        {owner && (
          <span className="svc-avatar">
            <Avatar url={s.ownerAvatarUrl} name={owner} size="sm" />
          </span>
        )}
        <h3 className="svc-heading">
          <Link to={`/servicos/${s.id}`} className="svc-title">
            {s.title}
          </Link>
        </h3>
        {(owner || where) && (
          <p className="svc-owner">
            {owner &&
              (s.ownerUlid ? (
                <Link to={`/freelancers/${s.ownerUlid}`} className="svc-owner-name">
                  {owner}
                </Link>
              ) : (
                <span className="svc-owner-name">{owner}</span>
              ))}
            {where && (
              <span className="svc-where">
                <MapPin size={13} aria-hidden="true" />
                <span>{where}</span>
              </span>
            )}
          </p>
        )}
        <div className="svc-facts">
          {owner && <Rating value={s.ownerRating ?? 0} count={s.ownerReviews ?? 0} />}
          {delivery && <span>{delivery}</span>}
          <span className="tag">{modalityTag(s)}</span>
        </div>
        {owner && (s.ownerAvailableNow || !!s.ownerAvailableDays?.length) && (
          <div className="svc-agenda">
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
        {!compact && (
          <>
            {/* Resumo em duas linhas: o texto inteiro está na página do serviço (WCAG 1.4.12). */}
            <p className="muted clamp svc-desc" data-resumo>
              {s.description}
            </p>
            <ServiceTags tags={s.tags} />
          </>
        )}
        {mine && s.viewsCount !== undefined && (
          <p className="muted tiny svc-views" data-testid="views-count">
            <Eye size={12} aria-hidden="true" /> {viewsLabel(s.viewsCount)}
          </p>
        )}
        {!s.isActive && (
          <p className="muted tiny" data-testid="paused-note">
            Fora da busca e sem propostas novas. Os contratos em andamento continuam.
          </p>
        )}
        <div className="svc-foot">
          <p className="svc-price">
            {price !== 'a combinar' && <span className="svc-from">a partir de</span>}
            <span className="price">{price}</span>
          </p>
          {acceptsBarter && (
            <span className="svc-barter">
              <ArrowLeftRight size={13} aria-hidden="true" /> Aceita troca
            </span>
          )}
        </div>
      </div>

      {!compact && (
        <div className="svc-actions">
          {mine ? (
            <>
              {/* Serviço pausado não é impulsionado (RN-017). */}
              {s.isActive && onBoost && (
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
                <BusinessButton
                  variant="mini"
                  onClick={() => onToggleActive(s)}
                  disabled={toggling}
                >
                  {s.isActive ? <Pause size={14} /> : <Play size={14} />}{' '}
                  {toggling ? 'Salvando…' : s.isActive ? 'Pausar' : 'Reativar'}
                </BusinessButton>
              )}
            </>
          ) : (
            <>
              {onContratar && (
                <BusinessButton size="sm" onClick={() => onContratar(s)}>
                  Contratar
                </BusinessButton>
              )}
              {onProposeBarter && barterEnabled && (
                <BusinessButton variant="secondary" size="sm" onClick={() => onProposeBarter(s)}>
                  <ArrowLeftRight size={14} /> Propor troca
                </BusinessButton>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}
