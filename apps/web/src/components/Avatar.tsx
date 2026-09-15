import { useState } from 'react';
import { MEDIA_THUMB, mediaVariant } from '../lib/image';

/**
 * Avatar com foto (URL) e fallback para a inicial do nome. Decorativo: o nome sempre aparece
 * como texto ao lado, então a imagem não carrega semântica (alt vazio, aria-hidden). Foto enviada
 * ao Escambo vem da miniatura de 128 px (ADR 38), que cobre o maior avatar em tela de alta
 * densidade; se a miniatura falhar, tenta o original antes de cair na inicial. A falha fica presa
 * à URL: trocar a foto volta a tentar.
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
  const [failed, setFailed] = useState<{ url: string; stage: 1 | 2 } | null>(null);
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const thumb = url ? mediaVariant(url, MEDIA_THUMB.small) : null;
  const stage = url && failed?.url === url ? failed.stage : 0;
  const src = !url ? null : stage === 0 ? thumb : stage === 1 ? url : null;

  function onError(): void {
    if (!url) return;
    setFailed({ url, stage: stage === 0 && thumb !== url ? 1 : 2 });
  }

  return (
    <span className={`avatar ${size}`} aria-hidden="true" data-avatar={src ? 'image' : 'initial'}>
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" onError={onError} /> : initial}
    </span>
  );
}
