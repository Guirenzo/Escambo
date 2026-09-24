import { Download, FileArchive, FileText, FileX, Paperclip, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AttachmentPurgeReason, ChatAttachment as Attachment } from '@escambo/types';
import { api } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { useAttachmentBlob } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/** Tipos que a API aceita (ela confere pelo conteúdo; aqui é só o filtro do seletor). */
export const ATTACHMENT_ACCEPT =
  'image/jpeg,image/png,image/gif,image/webp,application/pdf,application/zip,.jpg,.jpeg,.png,.gif,.webp,.pdf,.zip';
/** Limite padrão da API (UPLOAD_MAX_MB); acima disso nem tenta enviar. */
export const MAX_ATTACHMENT_MB = 10;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

const PURGED_LABEL: Record<AttachmentPurgeReason, string> = {
  retention: 'removido pela política de retenção',
  lgpd: 'removido a pedido do titular',
  missing: 'arquivo indisponível',
};

/** Anexo cujo arquivo já saiu do disco (ADR 31): o nome fica, com o motivo. */
export function PurgedAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <span className="attachment-purged" data-testid="attachment-purged">
      <FileX size={16} aria-hidden="true" />
      <span className="attachment-text">
        <span className="attachment-name">{attachment.name}</span>
        <span className="muted tiny">{PURGED_LABEL[attachment.purgedReason ?? 'missing']}</span>
      </span>
    </span>
  );
}

/** URL de objeto para um blob, revogada quando o blob muda ou o componente sai. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

/** Imagem no chat: miniatura que abre em tamanho real (com download). */
export function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const purged = attachment.purgedAt != null;
  const q = useAttachmentBlob(attachment.url, attachment.name, !purged);
  const src = useObjectUrl(q.data?.blob);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (purged) return <PurgedAttachment attachment={attachment} />;
  if (q.isError) return <span className="attachment-error">Imagem indisponível</span>;
  if (!src)
    return <span className="attachment-skeleton" role="img" aria-label="Carregando imagem" />;
  return (
    <>
      <button
        type="button"
        className="attachment-image"
        onClick={() => setOpen(true)}
        aria-label={`Abrir imagem ${attachment.name}`}
      >
        <img src={src} alt={attachment.name} loading="lazy" />
      </button>
      {open && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={attachment.name}
          onClick={() => setOpen(false)}
        >
          <img src={src} alt={attachment.name} onClick={(e) => e.stopPropagation()} />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span>
              {attachment.name} · {formatBytes(attachment.size)}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => q.data && saveBlob(q.data.blob, attachment.name)}
              aria-label="Baixar imagem"
            >
              <Download size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setOpen(false)}
              aria-label="Fechar"
              autoFocus
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Arquivo (PDF, ZIP) no chat: cartão com nome e tamanho; clicar baixa com o token. */
export function FileAttachment({ attachment }: { attachment: Attachment }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const Icon = attachment.mime === 'application/pdf' ? FileText : FileArchive;

  async function download(): Promise<void> {
    setBusy(true);
    try {
      const { blob, fileName } = await api.attachmentBlob(attachment.url, attachment.name);
      saveBlob(blob, fileName);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível baixar o arquivo');
    } finally {
      setBusy(false);
    }
  }

  if (attachment.purgedAt) return <PurgedAttachment attachment={attachment} />;
  return (
    <button
      type="button"
      className="attachment-file"
      onClick={() => void download()}
      disabled={busy}
      aria-label={`Baixar ${attachment.name}`}
    >
      <Icon size={20} aria-hidden="true" />
      <span className="attachment-text">
        <span className="attachment-name">{attachment.name}</span>
        <span className="muted tiny">
          {formatBytes(attachment.size)}
          {busy ? ' · baixando…' : ''}
        </span>
      </span>
      <Download size={14} aria-hidden="true" />
    </button>
  );
}

/** O arquivo escolhido, antes de enviar: prévia (se imagem), nome, tamanho e remover. */
export function PendingAttachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const src = useObjectUrl(file.type.startsWith('image/') ? file : undefined);
  return (
    <div className="attachment-pending" data-testid="attachment-pending">
      {src ? <img src={src} alt="" /> : <Paperclip size={16} aria-hidden="true" />}
      <span className="attachment-name">{file.name}</span>
      <span className="muted tiny">{formatBytes(file.size)}</span>
      <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remover anexo">
        <X size={14} />
      </button>
    </div>
  );
}
