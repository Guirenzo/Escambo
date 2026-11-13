import { useState } from 'react';
import type { Service } from '@escambo/types';
import { useCategories } from '../../lib/hooks';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
import { HOLO } from '../landing/album';
import { CATEGORY_GROUNDS, categoryArt, categoryPhoto, rootsById } from './categoryArt';

/**
 * A figurinha grande do serviço, na página dele. A imagem segue a regra da capa do card: a primeira
 * do portfólio de quem presta; sem ela (ou se não carregar), a foto da categoria; sem foto, o
 * desenho do ofício sobre a cor da categoria. A faixa diz a categoria e de onde a imagem veio, para
 * a foto da categoria não passar por foto de quem presta. Serviço em destaque é a brilhante: borda
 * laminada, com o reflexo que segue o ponteiro. É decorativa: o título, a categoria e o destaque
 * estão escritos ao lado.
 */
export function ServiceSticker({ service: s }: { service: Service }) {
  const tree = useCategories().data;
  const root = rootsById(tree ?? []).get(s.categoryId);
  const index = root ? (tree ?? []).findIndex((c) => c.id === root.id) : -1;
  const ground = CATEGORY_GROUNDS[Math.max(index, 0) % CATEGORY_GROUNDS.length];
  const { Icon } = categoryArt(root?.slug);
  const [failed, setFailed] = useState<string | null>(null);
  const cover =
    s.ownerCoverUrl && failed !== s.ownerCoverUrl
      ? mediaVariant(s.ownerCoverUrl, MEDIA_THUMB.card)
      : null;
  const photo = cover ? null : categoryPhoto(root?.slug, s.id);
  const origin = cover ? 'do portfólio' : photo ? 'foto ilustrativa' : 'desenho do ofício';
  return (
    <span
      className={`al-sticker svc-sticker al-g-${ground}${s.boosted ? ' al-foil' : ''}`}
      aria-hidden="true"
      data-cover={cover ? 'portfolio' : photo ? 'category' : 'icon'}
      {...(s.boosted ? HOLO : {})}
    >
      <span className="al-sticker-photo">
        {cover ? (
          <img
            src={cover}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setFailed(s.ownerCoverUrl ?? null)}
          />
        ) : photo ? (
          <img src={photo.src} srcSet={photo.srcSet} sizes="16rem" alt="" />
        ) : (
          <span className="svc-sticker-art">
            <Icon strokeWidth={1.5} />
          </span>
        )}
      </span>
      <span className="al-sticker-band">
        <span className="al-sticker-title">
          <Icon size={16} strokeWidth={2} /> {root?.name ?? 'Serviço'}
        </span>
        <span className="al-sticker-who">{origin}</span>
      </span>
    </span>
  );
}
