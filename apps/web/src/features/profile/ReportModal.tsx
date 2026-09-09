import { Flag } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ReportReason, ReportTargetType } from '@escambo/types';
import { Button, Field, Modal, Select } from '../../components/ui';
import { REPORT_REASON_LABEL } from '../../lib/format';
import { useCreateReport } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

const REASONS = Object.keys(REPORT_REASON_LABEL) as ReportReason[];

/** Denúncia de usuário/serviço/avaliação: vai para a fila de moderação da plataforma. */
export function ReportModal({
  targetType,
  targetId,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: number;
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateReport();
  const [reason, setReason] = useState<ReportReason>('spam');
  const [description, setDescription] = useState('');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await create.mutateAsync({
        targetType,
        targetId,
        reason,
        description: description.trim() || null,
      });
      toast.success('Denúncia registrada. Obrigado por ajudar a manter o Escambo seguro.');
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao denunciar');
    }
  }

  return (
    <Modal title="Denunciar" onClose={onClose}>
      <form onSubmit={submit} className="stack">
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
