import { ImagePlus } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { MEDIA_MAX_MB, prepareImage } from '../lib/image';
import { useToast } from '../lib/toast';
import { Button } from './ui';

/**
 * Envia uma imagem do aparelho (ADR 36): prepara no navegador (orientação, tamanho, sem EXIF),
 * manda para a API e devolve a URL pública para o formulário usar no lugar de um link.
 */
export function ImageUploadButton({
  maxSide,
  label,
  onUploaded,
  testId,
}: {
  maxSide: number;
  label: string;
  onUploaded: (url: string) => void;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Escolha uma imagem JPG, PNG, GIF ou WebP');
      return;
    }
    setBusy(true);
    try {
      const blob = await prepareImage(file, maxSide);
      if (blob.size > MEDIA_MAX_MB * 1024 * 1024) {
        toast.error(`Imagem maior que ${MEDIA_MAX_MB} MB`);
        return;
      }
      const { url } = await api.uploadMedia(blob, file.name);
      onUploaded(url);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível enviar a imagem');
    } finally {
      setBusy(false);
    }
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
    </>
  );
}
