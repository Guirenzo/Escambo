import { Paperclip, Send } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import type { Contract, Milestone } from '@escambo/types';
import { BusinessForm, BusinessModal } from '../../components/BusinessActions';
import { Button, Field } from '../../components/ui';
import { formatBytes } from '../../lib/format';
import { useDeliverContract, useMilestoneAction } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  PendingAttachment,
} from './ChatAttachment';

/** Arquivos por entrega e a soma deles (RF-035), os mesmos limites da API. */
export const DELIVERY_MAX_FILES = 10;
export const DELIVERY_MAX_TOTAL_MB = 24;
const DELIVERY_MAX_TOTAL_BYTES = DELIVERY_MAX_TOTAL_MB * 1024 * 1024;
const MAX_LINKS = 20;

/** Os links digitados, um por linha; o que não é http(s) volta para a pessoa corrigir. */
export function parseLinks(text: string): { links: string[]; invalid: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const valid = (l: string): boolean => {
    try {
      const url = new URL(l);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  };
  return { links: lines.filter(valid), invalid: lines.filter((l) => !valid(l)) };
}

/**
 * Registrar a entrega (RF-035): a mensagem, os links e os arquivos, na entrega única ou na de um
 * marco. Os arquivos seguem as regras dos anexos do chat (imagem, PDF ou ZIP; só as partes baixam)
 * e aparecem também no chat; o marco não guarda links, então eles vão na mensagem.
 */
export function DeliverModal({
  contract,
  milestone,
  onClose,
}: {
  contract: Pick<Contract, 'id' | 'title' | 'status'>;
  milestone?: Pick<Milestone, 'id' | 'title'>;
  onClose: () => void;
}) {
  const toast = useToast();
  const deliver = useDeliverContract();
  const milestoneAction = useMilestoneAction(contract.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  const [linksText, setLinksText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const busy = deliver.isPending || milestoneAction.isPending;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const title = milestone
    ? `Entregar marco: ${milestone.title}`
    : contract.status === 'revision_requested'
      ? 'Entregar revisão'
      : 'Registrar entrega';

  function pick(list: FileList | null): void {
    if (!list || list.length === 0) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`${file.name}: arquivo maior que ${MAX_ATTACHMENT_MB} MB`);
        continue;
      }
      if (next.length >= DELIVERY_MAX_FILES) {
        toast.error(`No máximo ${DELIVERY_MAX_FILES} arquivos por entrega`);
        break;
      }
      if (next.reduce((sum, f) => sum + f.size, 0) + file.size > DELIVERY_MAX_TOTAL_BYTES) {
        toast.error(
          `${file.name}: a entrega passaria de ${DELIVERY_MAX_TOTAL_MB} MB somados. Mande os maiores pelo chat ou por link.`,
        );
        continue;
      }
      next.push(file);
    }
    setFiles(next);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const text = message.trim();
    if (busy || !text) return;
    const { links, invalid } = parseLinks(linksText);
    if (invalid.length > 0) {
      toast.error(`Link sem http(s): ${invalid[0]}`);
      return;
    }
    if (links.length > MAX_LINKS) {
      toast.error(`No máximo ${MAX_LINKS} links por entrega`);
      return;
    }
    try {
      if (milestone) {
        await milestoneAction.mutateAsync({
          milestoneId: milestone.id,
          action: 'deliver',
          text,
          attachments: files,
        });
        toast.success('Marco entregue. O cliente foi avisado.');
      } else {
        await deliver.mutateAsync({ id: contract.id, message: text, attachments: files, links });
        toast.success('Entrega registrada. O cliente foi avisado.');
      }
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível registrar a entrega');
    }
  }

  return (
    <BusinessModal title={title} onClose={onClose}>
      <BusinessForm onSubmit={submit} className="stack" data-testid="deliver-form">
        <Field label="Mensagem da entrega">
          <textarea
            className="textarea"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="O que foi feito e onde está"
            rows={4}
            required
          />
        </Field>
        {!milestone && (
          <Field label="Links (opcional, um por linha)">
            <textarea
              className="textarea"
              value={linksText}
              onChange={(e) => setLinksText(e.target.value)}
              placeholder="https://"
              rows={2}
            />
          </Field>
        )}
        <div className="stack" data-testid="deliver-files">
          <input
            ref={fileRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            hidden
            data-testid="deliver-file-input"
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileRef.current?.click()}
            disabled={busy || files.length >= DELIVERY_MAX_FILES}
          >
            <Paperclip size={16} /> Anexar arquivos
          </Button>
          {files.map((file, i) => (
            <PendingAttachment
              key={`${file.name}-${i}`}
              file={file}
              onRemove={() => setFiles((prev) => prev.filter((_, k) => k !== i))}
            />
          ))}
          <p className="muted tiny">
            Imagem, PDF ou ZIP: até {DELIVERY_MAX_FILES} arquivos, {MAX_ATTACHMENT_MB} MB cada e{' '}
            {DELIVERY_MAX_TOTAL_MB} MB somados
            {files.length > 0 ? ` (agora ${formatBytes(total)})` : ''}. Os arquivos aparecem também
            no chat, e só vocês dois baixam.
            {milestone ? ' Link vai na mensagem.' : ''}
          </p>
        </div>
        <Button type="submit" disabled={busy || !message.trim()}>
          <Send size={16} /> {busy ? 'Enviando…' : 'Enviar entrega'}
        </Button>
      </BusinessForm>
    </BusinessModal>
  );
}
