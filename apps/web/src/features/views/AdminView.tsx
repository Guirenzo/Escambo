import { Briefcase, CheckCircle2, Coins, Gavel, ShieldAlert, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Dispute, DisputeResolution } from '@escambo/types';
import { Button, Field, Modal, PageHeader, QueryState } from '../../components/ui';
import { brl, DISPUTE_REASON_LABEL, DISPUTE_STATUS_LABEL, dtm } from '../../lib/format';
import { useAdminDisputes, useAdminMetrics, useResolveDispute } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

const RESOLUTIONS: { value: DisputeResolution; label: string; hint: string }[] = [
  {
    value: 'release_freelancer',
    label: 'Liberar ao freelancer',
    hint: 'A entrega foi feita como combinado: o escrow vai inteiro para o freelancer.',
  },
  {
    value: 'refund_client',
    label: 'Devolver ao cliente',
    hint: 'A entrega não aconteceu ou não serve: o cliente recebe o valor de volta.',
  },
  {
    value: 'partial_split',
    label: 'Dividir',
    hint: 'Parte do valor volta ao cliente e o restante vai ao freelancer.',
  },
];

/** Decisão da mediação sobre uma disputa (escrow liberado, devolvido ou dividido). */
function ResolveModal({ dispute, onClose }: { dispute: Dispute; onClose: () => void }) {
  const toast = useToast();
  const resolve = useResolveDispute();
  const [resolution, setResolution] = useState<DisputeResolution>('release_freelancer');
  const [refund, setRefund] = useState(50);
  const [note, setNote] = useState('');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await resolve.mutateAsync({
        id: dispute.id,
        body: {
          resolution,
          refundPercentage: resolution === 'partial_split' ? refund : null,
          note: note.trim() || null,
        },
      });
      toast.success('Disputa resolvida. As duas partes foram notificadas.');
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao resolver');
    }
  }

  return (
    <Modal title={`Resolver disputa #${dispute.id}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="review">
          <strong>{DISPUTE_REASON_LABEL[dispute.reason] ?? dispute.reason}</strong>
          <p className="dispute-desc">{dispute.description}</p>
          <span className="muted tiny">
            contrato #{dispute.contractId} · aberta em {dtm(dispute.createdAt)}
          </span>
        </div>
        <div className="radio-row" role="radiogroup" aria-label="Decisão">
          {RESOLUTIONS.map((r) => (
            <label key={r.value} className={`radio-card ${resolution === r.value ? 'on' : ''}`}>
              <input
                type="radio"
                name="resolution"
                value={r.value}
                checked={resolution === r.value}
                onChange={() => setResolution(r.value)}
              />
              <span className="svc-actions">{r.label}</span>
              <small>{r.hint}</small>
            </label>
          ))}
        </div>
        {resolution === 'partial_split' && (
          <Field label={`Percentual devolvido ao cliente: ${refund}%`}>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={refund}
              onChange={(e) => setRefund(Number(e.target.value))}
              aria-label="Percentual devolvido ao cliente"
            />
          </Field>
        )}
        <textarea
          className="textarea"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Justificativa da decisão (opcional, fica no histórico)"
          aria-label="Justificativa"
          maxLength={1000}
          rows={2}
        />
        <Button type="submit" disabled={resolve.isPending}>
          <Gavel size={16} /> {resolve.isPending ? 'Aplicando…' : 'Aplicar decisão'}
        </Button>
      </form>
    </Modal>
  );
}

/** Painel do administrador: métricas da plataforma e fila de mediação. */
export function AdminView() {
  const metrics = useAdminMetrics();
  const disputes = useAdminDisputes();
  const [resolving, setResolving] = useState<Dispute | null>(null);
  const m = metrics.data;

  return (
    <div className="page">
      <PageHeader
        title="Administração"
        subtitle="Métricas da plataforma, mediação de disputas e moderação."
      />

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Users size={18} />
            </span>
            <span className="kpi-label">Usuários</span>
          </div>
          <strong className="kpi-value">{m ? m.users : '—'}</strong>
          <span className="muted tiny">{m ? `${m.freelancers} freelancers` : ''}</span>
        </div>
        <div className="kpi">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Briefcase size={18} />
            </span>
            <span className="kpi-label">Contratações</span>
          </div>
          <strong className="kpi-value">{m ? m.contracts : '—'}</strong>
          <span className="muted tiny">
            {m ? (
              <>
                <CheckCircle2 size={12} /> {m.completedContracts} concluídas
              </>
            ) : (
              ''
            )}
          </span>
        </div>
        <div className="kpi amber">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Gavel size={18} />
            </span>
            <span className="kpi-label">Disputas abertas</span>
          </div>
          <strong className="kpi-value">{m ? m.openDisputes : '—'}</strong>
          <span className="muted tiny">aguardando mediação</span>
        </div>
        <div className="kpi blue">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Coins size={18} />
            </span>
            <span className="kpi-label">Receita da plataforma</span>
          </div>
          <strong className="kpi-value">{m ? brl(m.platformFees) : '—'}</strong>
          <span className="muted tiny">taxas de 15% sobre concluídas</span>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>
            <ShieldAlert size={16} /> Fila de mediação
          </h3>
          {disputes.data && <span className="muted tiny">{disputes.data.length} aberta(s)</span>}
        </div>
        <QueryState
          isLoading={disputes.isLoading}
          error={disputes.error}
          data={disputes.data}
          empty="Nenhuma disputa aberta. Tudo em paz."
          onRetry={() => void disputes.refetch()}
        >
          {(list) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Disputa</th>
                    <th>Contrato</th>
                    <th>Motivo</th>
                    <th>Status</th>
                    <th className="right">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id} data-testid={`dispute-${d.id}`}>
                      <td className="cell-title">
                        <strong>#{d.id}</strong>
                        <span className="muted tiny">aberta em {dtm(d.createdAt)}</span>
                      </td>
                      <td>
                        <Link to={`/contratos/${d.contractId}`}>#{d.contractId}</Link>
                      </td>
                      <td>
                        <strong>{DISPUTE_REASON_LABEL[d.reason] ?? d.reason}</strong>
                        <div className="muted tiny clamp">{d.description}</div>
                      </td>
                      <td>
                        <span className="pill status-disputed">
                          {DISPUTE_STATUS_LABEL[d.status] ?? d.status}
                        </span>
                      </td>
                      <td>
                        <div className="acts">
                          <Button variant="mini" onClick={() => setResolving(d)}>
                            <Gavel size={14} /> Resolver
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </section>

      <p className="muted tiny">
        Moderação de usuários (suspender, banir, reativar) fica no perfil público de cada
        freelancer, visível só para administradores.
      </p>

      {resolving && <ResolveModal dispute={resolving} onClose={() => setResolving(null)} />}
    </div>
  );
}
