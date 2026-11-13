import { useState } from 'react';
import { useGamification } from '../../lib/hooks';
import { HOLO } from '../landing/album';

/**
 * A figurinha de quem está logado, no álbum do Início: brilhante, com a foto (ou a inicial sobre o
 * fundo chapado), o nível no lugar do número, o nome e o papel na faixa, e o XP no selo. É decorativa: o
 * nome está no título da faixa de boas-vindas e o nível, no cartão de progresso.
 */
export function MySticker({
  name,
  avatarUrl,
  roleLabel,
}: {
  name: string;
  avatarUrl: string | null;
  roleLabel: string;
}) {
  const { data: g } = useGamification();
  const [failed, setFailed] = useState<string | null>(null);
  const photo = avatarUrl && failed !== avatarUrl ? avatarUrl : null;
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span className="al-sticker al-g-amber al-foil me-sticker" {...HOLO}>
      {g && <span className="al-sticker-n">{String(g.level).padStart(2, '0')}</span>}
      <span className="al-sticker-photo">
        {photo ? (
          <img src={photo} alt="" referrerPolicy="no-referrer" onError={() => setFailed(photo)} />
        ) : (
          <span className="me-sticker-initial">{initial}</span>
        )}
      </span>
      <span className="al-sticker-band">
        <span className="al-sticker-title">{name}</span>
        <span className="al-sticker-who">{g ? `${roleLabel} · ${g.levelName}` : roleLabel}</span>
      </span>
      {g && <span className="al-sticker-value">{g.totalXp.toLocaleString('pt-BR')} XP</span>}
    </span>
  );
}
