import { useState } from 'react';

/**
 * Avatar com foto (URL) e fallback para a inicial do nome. Decorativo: o nome sempre aparece
 * como texto ao lado, então a imagem não carrega semântica (alt vazio, aria-hidden).
 */
export function Avatar({
  url,
  name,
  size = 'md',
}: {
  url?: string | null;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}) {
  const [broken, setBroken] = useState(false);
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const showImage = !!url && !broken;
  return (
    <span
      className={`avatar ${size}`}
      aria-hidden="true"
      data-avatar={showImage ? 'image' : 'initial'}
    >
      {showImage ? (
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        initial
      )}
    </span>
  );
}
