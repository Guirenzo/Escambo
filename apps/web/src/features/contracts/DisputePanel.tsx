import { Gavel } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Contract, DisputeReason } from '@escambo/types';
import { Button, Field, Modal, QueryState, Select } from '../../components/ui';
import {
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
  RESOLUTION_LABEL,
  dtm,
} from '../../lib/format';
import { useMyDisputes, useOpenDispute } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

const REASONS = Object.keys(DISPUTE_REASON_LABEL) as DisputeReason[];

/** Abre uma disputa: motivo + descrição. O contrato passa a "Disputa" e a mediação decide o escrow. */
export function DisputeModal({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  const toast = useToast();
  const open = useOpenDispute();
  const [reason, setReason] = useState<DisputeReason>('quality');
  const [description, setDescription] = useState('');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await open.mutateAsync({ contractId: contract.id, reason, description: description.trim() });
      toast.success('Disputa aberta. A mediação do Escambo vai analisar.');
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao abrir disputa');
    }
  }

  return (
    <Modal title={`Abrir disputa: ${contract.title}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="muted tiny">
          A contratação fica congelada e um mediador da plataforma decide o destino do valor em
          escrow (liberar ao freelancer, devolver ao cliente ou dividir). Use só quando a conversa
          na sala não resolveu.
        </p>
        <Field label="Motivo">
          <Select value={reason} onChange={(e) => setReason(e.target.value as DisputeReason)}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {DISPUTE_REASON_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <textarea
          className="textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Descreva o que aconteceu (mínimo 10 caracteres)"
          aria-label="Descrição da disputa"
          minLength={10}
          maxLength={2000}
          rows={4}
          required
        />
        <Button
          type="submit"
          variant="danger"
          disabled={open.isPending || description.trim().length < 10}
        >
          <Gavel size={16} /> {open.isPending ? 'Abrindo…' : 'Abrir disputa'}
        </Button>
      </form>
    </Modal>
  );
}

/** Estado da disputa da contratação (quem abriu, motivo, decisão da mediação). */
export function DisputeSection({ contractId }: { contractId: number }) {
  const disputes = useMyDisputes();
  return (
    <section className="card" aria-labelledby="dispute-title">
      <div className="card-head">
        <h3 id="dispute-title">
          <Gavel size={16} /> Disputa
        </h3>
      </div>
      <QueryState
        isLoading={disputes.isLoading}
        error={disputes.error}
        data={disputes.data}
        onRetry={() => void disputes.refetch()}
      >
        {(list) => {
          const d = [...list].reverse().find((x) => x.contractId === contractId);
          if (!d) return <p className="muted">Disputa registrada. Aguardando a mediação.</p>;
          return (
            <div className="review">
              <div className="review-head">
                <strong>{DISPUTE_REASON_LABEL[d.reason] ?? d.reason}</strong>
                <span
                  className={`pill ${d.status === 'resolved' ? 'status-completed' : 'status-disputed'}`}
                >
                  {DISPUTE_STATUS_LABEL[d.status] ?? d.status}
                </span>
              </div>
              <p className="dispute-desc">{d.description}</p>
              <span className="muted tiny">aberta em {dtm(d.createdAt)}</span>
              {d.resolution && (
                <div className="review-response">
                  <strong>Decisão da mediação</strong>
                  <p>
                    {RESOLUTION_LABEL[d.resolution] ?? d.resolution}
                    {d.refundPercentage != null && d.resolution === 'partial_split'
                      ? ` · ${d.refundPercentage}% devolvido ao cliente`
                      : ''}
                  </p>
                </div>
              )}
            </div>
          );
        }}
      </QueryState>
    </section>
  );
}
