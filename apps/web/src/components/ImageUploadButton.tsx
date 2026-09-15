import { ImagePlus } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MediaPurpose } from '@escambo/types';
import { api } from '../lib/api';
import { canCrop, IMAGE_MAX_SIDE, MEDIA_MAX_MB, prepareImage } from '../lib/image';
import { useToast } from '../lib/toast';
import { AvatarCropper } from './AvatarCropper';
import { Button } from './ui';

/**
 * Envia uma imagem do aparelho (ADR 36 e 38). Foto de perfil passa pelo recorte quadrado; imagem
 * do portfólio é reduzida e reencodada antes de subir. A API reprocessa tudo de qualquer jeito
 * (orientação, metadados, dimensões) e devolve a URL pública para o formulário usar.
 */
export function ImageUploadButton({
  purpose,
  label,
  onUploaded,
  testId,
}: {
  purpose: MediaPurpose;
  label: string;
  onUploaded: (url: string) => void;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [cropping, setCropping] = useState<File | null>(null);
  const toast = useToast();

  async function send(image: Blob, name: string): Promise<void> {
    if (image.size > MEDIA_MAX_MB * 1024 * 1024) {
      toast.error(`Imagem maior que ${MEDIA_MAX_MB} MB`);
      return;
    }
    setBusy(true);
    try {
      const { url } = await api.uploadMedia(image, name, purpose);
      onUploaded(url);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível enviar a imagem');
    } finally {
      setBusy(false);
    }
  }

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Escolha uma imagem JPG, PNG, GIF ou WebP');
      return;
    }
    if (purpose === 'avatar' && canCrop()) {
      setCropping(file);
      return;
    }
    setBusy(true);
    const prepared = await prepareImage(file, IMAGE_MAX_SIDE[purpose]);
    setBusy(false);
    await send(prepared, file.name);
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        hidden
        data-testid={testId}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="secondary"
        className="mini upload-btn"
        onClick={() => input.current?.click()}
        disabled={busy}
      >
        <ImagePlus size={14} aria-hidden="true" /> {busy ? 'Enviando…' : label}
      </Button>
      {/* Fora do formulário: dentro de um <label>, clicar no recorte jogaria o foco no campo. */}
      {cropping &&
        createPortal(
          <AvatarCropper
            file={cropping}
            onCancel={() => setCropping(null)}
            onConfirm={(image) => {
              const name = cropping.name;
              setCropping(null);
              void send(image, name);
            }}
          />,
          document.body,
        )}
    </>
  );
}
