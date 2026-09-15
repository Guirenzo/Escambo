import { Flag } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { ReportReason, ReportTargetType } from '@escambo/types';
import { Button, Field, Modal, Select } from '../../components/ui';
import { REPORT_REASON_LABEL } from '../../lib/format';
import { useCreateReport } from '../../lib/hooks';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
import { useToast } from '../../lib/toast';

const REASONS = Object.keys(REPORT_REASON_LABEL) as ReportReason[];

/** O que pode ser denunciado a partir de um ponto da tela (o perfil, a foto, um trabalho). */
export interface ReportSubject {
  targetType: ReportTargetType;
  targetId: number;
  label: string;
  hint?: string;
  /** Imagem mostrada na denúncia de foto ou trabalho, para quem denuncia confirmar o que é. */
  imageUrl?: string | null;
}

const isImage = (t: ReportTargetType): boolean => t === 'avatar' || t === 'portfolio_item';

/**
 * Denúncia para a fila de moderação (ADR 39). Com mais de um alvo possível (o perfil e a foto do
 * perfil), quem denuncia escolhe; denúncia de imagem mostra a imagem que vai para a moderação.
 */
export function ReportModal({
  subjects,
  onClose,
}: {
  subjects: ReportSubject[];
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateReport();
  const group = useId();
  const [index, setIndex] = useState(0);
  const [reason, setReason] = useState<ReportReason>(
    subjects[0] && isImage(subjects[0].targetType) ? 'offensive' : 'spam',
  );
  const [description, setDescription] = useState('');
  const subject = subjects[index] ?? subjects[0]!;
  const image = isImage(subject.targetType);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await create.mutateAsync({
        targetType: subject.targetType,
        targetId: subject.targetId,
        reason,
        description: description.trim() || null,
      });
      toast.success(
        image
          ? 'Denúncia registrada. A moderação vai analisar a imagem.'
          : 'Denúncia registrada. Obrigado por ajudar a manter o Escambo seguro.',
      );
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao denunciar');
    }
  }

  return (
    <Modal
      title={subjects.length === 1 && image ? 'Denunciar imagem' : 'Denunciar'}
      onClose={onClose}
    >
      <form onSubmit={submit} className="stack">
        {subjects.length > 1 && (
          <fieldset className="pref-list">
            <legend className="muted tiny">O que você quer denunciar?</legend>
            {subjects.map((s, i) => (
              <label key={`${s.targetType}-${s.targetId}`} className={i === index ? 'on' : ''}>
                <input
                  type="radio"
                  name={group}
                  checked={i === index}
                  onChange={() => {
                    setIndex(i);
                    if (isImage(s.targetType) && reason === 'spam') setReason('offensive');
                  }}
                />
                <span>
                  <strong>{s.label}</strong>
                  {s.hint && <span className="muted tiny">{s.hint}</span>}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {image && subject.imageUrl && (
          <figure className="report-subject">
            <img src={mediaVariant(subject.imageUrl, MEDIA_THUMB.small)} alt="" />
            <figcaption>
              <strong>{subject.label}</strong>
              <span className="muted tiny">
                A moderação analisa esta imagem como ela está agora, mesmo que seja trocada depois.
              </span>
            </figcaption>
          </figure>
        )}
        <Field label="Motivo">
          <Select value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {REPORT_REASON_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <textarea
          className="textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Detalhes (opcional)"
          aria-label="Detalhes da denúncia"
          maxLength={2000}
          rows={3}
        />
        <Button type="submit" variant="danger" disabled={create.isPending}>
          <Flag size={16} /> {create.isPending ? 'Enviando…' : 'Enviar denúncia'}
        </Button>
      </form>
    </Modal>
  );
}
