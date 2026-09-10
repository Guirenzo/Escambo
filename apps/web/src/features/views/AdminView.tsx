import {
  ArrowDownToLine,
  Banknote,
  Briefcase,
  CheckCircle2,
  Coins,
  Gavel,
  Lock,
  Mail,
  ShieldAlert,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdminDeletionRequest,
  AdminEmail,
  AdminWithdrawal,
  Dispute,
  DisputeResolution,
} from '@escambo/types';
import { Button, Field, Input, Modal, PageHeader, QueryState } from '../../components/ui';
import {
  brl,
  DELETION_STATUS_LABEL,
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
  dtm,
  WITHDRAWAL_STATUS_LABEL,
  WITHDRAWAL_STATUS_TONE,
} from '../../lib/format';
import {
  useAdminDeletionAction,
  useAdminDeletionRequests,
  useAdminEmails,
  useAdminDisputes,
  useAdminMetrics,
  useAdminWithdrawalAction,
  useAdminWithdrawals,
  useResolveDispute,
} from '../../lib/hooks';
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

/** Conclui (pagamento feito) ou falha (estorna) um saque da fila. */
function WithdrawalModal({
  withdrawal,
  action,
  onClose,
}: {
  withdrawal: AdminWithdrawal;
  action: 'complete' | 'fail';
  onClose: () => void;
}) {
  const toast = useToast();
  const act = useAdminWithdrawalAction();
  const [text, setText] = useState('');
  const completing = action === 'complete';

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await act.mutateAsync({
        id: withdrawal.id,
        action,
        body: completing ? { gatewayRef: text.trim() || null } : { reason: text.trim() || null },
      });
      toast.success(
        completing
          ? 'Saque concluído. O titular foi avisado.'
          : 'Saque marcado como falho; o valor voltou para a carteira do titular.',
      );
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao processar');
    }
  }

  return (
    <Modal
      title={`${completing ? 'Concluir' : 'Falhar'} saque #${withdrawal.id}`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="stack">
        <div className="summary">
          <strong>{brl(withdrawal.amount)}</strong>
          <span className="muted tiny">
            {withdrawal.userName ?? withdrawal.userEmail} ·{' '}
            {withdrawal.method === 'pix' ? 'PIX' : 'Conta'} {withdrawal.destination}
          </span>
        </div>
        <Field
          label={completing ? 'Referência do pagamento (opcional)' : 'Motivo (o titular recebe)'}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={completing ? 'ID da transferência no banco' : 'Ex.: chave PIX inexistente'}
            maxLength={completing ? 100 : 255}
          />
        </Field>
        <Button type="submit" variant={completing ? 'primary' : 'danger'} disabled={act.isPending}>
          {completing ? <CheckCircle2 size={16} /> : <XCircle size={16} />}{' '}
          {act.isPending
            ? 'Processando…'
            : completing
              ? 'Confirmar pagamento'
              : 'Marcar como falho e estornar'}
        </Button>
      </form>
    </Modal>
  );
}

/** Exclusão de conta (LGPD): concluir anonimiza e bloqueia; recusar exige justificativa. */
function DeletionModal({
  request: r,
  action,
  onClose,
}: {
  request: AdminDeletionRequest;
  action: 'complete' | 'reject';
  onClose: () => void;
}) {
  const toast = useToast();
  const act = useAdminDeletionAction();
  const [note, setNote] = useState('');
  const completing = action === 'complete';
  const blocked = r.activeContracts > 0 || r.balance > 0 || r.balancePending > 0;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await act.mutateAsync({ id: r.id, action, note: completing ? undefined : note.trim() });
      toast.success(
        completing
          ? 'Conta anonimizada e acesso encerrado.'
          : 'Pedido recusado; o titular foi avisado com a justificativa.',
      );
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao processar');
    }
  }

  return (
    <Modal
      title={`${completing ? 'Concluir exclusão' : 'Recusar exclusão'} · ${r.userName ?? r.userEmail}`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="stack">
        <div className="review">
          <strong>{r.userEmail}</strong>
          <p className="dispute-desc">{r.reason ?? 'Sem motivo informado.'}</p>
          <span className="muted tiny">
            pedido em {dtm(r.createdAt)} · {r.activeContracts} contratação(ões) aberta(s) ·{' '}
            {brl(r.balance + r.balancePending)} na carteira
          </span>
        </div>
        {completing ? (
          <p className={blocked ? 'notice' : 'muted tiny'}>
            {blocked
              ? 'O titular ainda tem contratações abertas ou saldo: a exclusão não pode ser concluída. Recuse com justificativa ou aguarde.'
              : 'A conta será anonimizada (e-mail, telefone, senha, perfil, serviços, favoritos e notificações) e o acesso encerrado na hora. Contratações, mensagens, avaliações e extratos ficam sem identificação. Não dá para desfazer.'}
          </p>
        ) : (
          <Field label="Justificativa (o titular recebe)">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex.: há uma disputa aberta em nome desta conta"
              minLength={3}
              maxLength={500}
              required
            />
          </Field>
        )}
        <Button
          type="submit"
          variant={completing ? 'danger' : 'primary'}
          disabled={act.isPending || (completing && blocked)}
        >
          {completing ? <Trash2 size={16} /> : <XCircle size={16} />}{' '}
          {act.isPending
            ? 'Processando…'
            : completing
              ? 'Anonimizar e encerrar a conta'
              : 'Recusar com justificativa'}
        </Button>
      </form>
    </Modal>
  );
}

const EMAIL_TEMPLATE_LABEL: Record<string, string> = {
  verify_email: 'Confirmação de e-mail',
  password_reset: 'Redefinição de senha',
  notification: 'Aviso',
};

/** Conteúdo (texto) de um e-mail da caixa de saída — links clicáveis para a demo. */
function EmailModal({ email, onClose }: { email: AdminEmail; onClose: () => void }) {
  const parts = email.text.split(/(https?:\/\/\S+)/g);
  return (
    <Modal title={email.subject} onClose={onClose}>
      <div className="stack">
        <span className="muted tiny">
          para {email.to} · {EMAIL_TEMPLATE_LABEL[email.template] ?? email.template} ·{' '}
          {email.provider} · {dtm(email.createdAt)}
        </span>
        <pre className="email-text" data-testid="email-text">
          {parts.map((p, i) =>
            /^https?:\/\//.test(p) ? (
              <a key={i} href={p}>
                {p}
              </a>
            ) : (
              <span key={i}>{p}</span>
            ),
          )}
        </pre>
      </div>
    </Modal>
  );
}

/** Painel do administrador: métricas, fila de mediação, fila de saques, pedidos LGPD e e-mails. */
export function AdminView() {
  const metrics = useAdminMetrics();
  const disputes = useAdminDisputes();
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const withdrawals = useAdminWithdrawals(scope);
  const act = useAdminWithdrawalAction();
  const toast = useToast();
  const [resolving, setResolving] = useState<Dispute | null>(null);
  const [processing, setProcessing] = useState<{
    withdrawal: AdminWithdrawal;
    action: 'complete' | 'fail';
  } | null>(null);
  const [deletionScope, setDeletionScope] = useState<'pending' | 'all'>('pending');
  const deletions = useAdminDeletionRequests(deletionScope);
  const [deleting, setDeleting] = useState<{
    request: AdminDeletionRequest;
    action: 'complete' | 'reject';
  } | null>(null);
  const emails = useAdminEmails();
  const [openEmail, setOpenEmail] = useState<AdminEmail | null>(null);
  const m = metrics.data;

  async function startProcessing(w: AdminWithdrawal): Promise<void> {
    try {
      await act.mutateAsync({ id: w.id, action: 'process' });
      toast.info(`Saque #${w.id} em processamento.`);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao processar');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Administração"
        subtitle="Métricas da plataforma, mediação de disputas, saques e moderação."
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
        <div className="kpi">
          <div className="kpi-top">
            <span className="kpi-ico">
              <ArrowDownToLine size={18} />
            </span>
            <span className="kpi-label">Depósitos confirmados</span>
          </div>
          <strong className="kpi-value">{m ? brl(m.depositsTotal) : '—'}</strong>
          <span className="muted tiny">entradas via PIX (gateway)</span>
        </div>
        <div className="kpi amber">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Lock size={18} />
            </span>
            <span className="kpi-label">Em escrow</span>
          </div>
          <strong className="kpi-value">{m ? brl(m.inEscrow) : '—'}</strong>
          <span className="muted tiny">reservado em propostas e contratações</span>
        </div>
        <div className="kpi">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Banknote size={18} />
            </span>
            <span className="kpi-label">Saldo dos usuários</span>
          </div>
          <strong className="kpi-value">{m ? brl(m.usersBalance) : '—'}</strong>
          <span className="muted tiny">disponível para contratar ou sacar</span>
        </div>
        <div className="kpi blue">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Banknote size={18} />
            </span>
            <span className="kpi-label">Saques pendentes</span>
          </div>
          <strong className="kpi-value">{m ? m.pendingWithdrawals : '—'}</strong>
          <span className="muted tiny">
            {m ? `${brl(m.pendingWithdrawalsAmount)} a pagar` : ''}
          </span>
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

      <section className="card">
        <div className="card-head">
          <h3>
            <Banknote size={16} /> Fila de saques
          </h3>
          <div className="tabs tabs-mini" role="tablist" aria-label="Filtro de saques">
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'open'}
              className={scope === 'open' ? 'active' : ''}
              onClick={() => setScope('open')}
            >
              Abertos
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'all'}
              className={scope === 'all' ? 'active' : ''}
              onClick={() => setScope('all')}
            >
              Todos
            </button>
          </div>
        </div>
        <QueryState
          isLoading={withdrawals.isLoading}
          error={withdrawals.error}
          data={withdrawals.data}
          empty="Nenhum saque aguardando. Nada a pagar."
          onRetry={() => void withdrawals.refetch()}
        >
          {(list) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Saque</th>
                    <th>Titular</th>
                    <th>Valor</th>
                    <th>Destino</th>
                    <th>Status</th>
                    <th className="right">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((w) => (
                    <tr key={w.id} data-testid={`withdrawal-${w.id}`}>
                      <td className="cell-title">
                        <strong>#{w.id}</strong>
                        <span className="muted tiny">pedido em {dtm(w.createdAt)}</span>
                      </td>
                      <td className="cell-title">
                        <strong>{w.userName ?? '—'}</strong>
                        <span className="muted tiny">{w.userEmail}</span>
                      </td>
                      <td>
                        <strong className="price">{brl(w.amount)}</strong>
                      </td>
                      <td>
                        <span className="mono">{w.destination}</span>
                        <div className="muted tiny">
                          {w.method === 'pix' ? 'chave PIX' : 'conta bancária'}
                        </div>
                      </td>
                      <td>
                        <span className={`pill status-${WITHDRAWAL_STATUS_TONE[w.status] ?? ''}`}>
                          {WITHDRAWAL_STATUS_LABEL[w.status] ?? w.status}
                        </span>
                      </td>
                      <td>
                        <div className="acts">
                          {w.status === 'requested' && (
                            <Button
                              variant="mini"
                              onClick={() => void startProcessing(w)}
                              disabled={act.isPending}
                            >
                              Processar
                            </Button>
                          )}
                          {(w.status === 'requested' || w.status === 'processing') && (
                            <>
                              <Button
                                variant="mini"
                                onClick={() => setProcessing({ withdrawal: w, action: 'complete' })}
                              >
                                <CheckCircle2 size={14} /> Concluir
                              </Button>
                              <Button
                                variant="mini"
                                onClick={() => setProcessing({ withdrawal: w, action: 'fail' })}
                              >
                                <XCircle size={14} /> Falhar
                              </Button>
                            </>
                          )}
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

      <section className="card">
        <div className="card-head">
          <h3>
            <Trash2 size={16} /> Exclusões de conta (LGPD)
            {m && m.pendingDeletions > 0 && (
              <span className="chip level tiny">{m.pendingDeletions} pendente(s)</span>
            )}
          </h3>
          <div className="tabs tabs-mini" role="tablist" aria-label="Filtro de exclusões">
            <button
              type="button"
              role="tab"
              aria-selected={deletionScope === 'pending'}
              className={deletionScope === 'pending' ? 'active' : ''}
              onClick={() => setDeletionScope('pending')}
            >
              Pendentes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={deletionScope === 'all'}
              className={deletionScope === 'all' ? 'active' : ''}
              onClick={() => setDeletionScope('all')}
            >
              Todas
            </button>
          </div>
        </div>
        <QueryState
          isLoading={deletions.isLoading}
          error={deletions.error}
          data={deletions.data}
          empty="Nenhum pedido de exclusão aguardando."
          onRetry={() => void deletions.refetch()}
        >
          {(list) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Titular</th>
                    <th>Motivo</th>
                    <th>Pendências</th>
                    <th>Status</th>
                    <th className="right">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const blocked = r.activeContracts > 0 || r.balance > 0 || r.balancePending > 0;
                    const open = r.status === 'pending' || r.status === 'processing';
                    return (
                      <tr key={r.id} data-testid={`deletion-${r.id}`}>
                        <td className="cell-title">
                          <strong>#{r.id}</strong>
                          <span className="muted tiny">pedido em {dtm(r.createdAt)}</span>
                        </td>
                        <td className="cell-title">
                          <strong>{r.userName ?? '—'}</strong>
                          <span className="muted tiny">{r.userEmail}</span>
                        </td>
                        <td>
                          <div className="muted tiny clamp">{r.reason ?? '—'}</div>
                        </td>
                        <td>
                          {blocked ? (
                            <span className="muted tiny">
                              {r.activeContracts > 0
                                ? `${r.activeContracts} contratação(ões) · `
                                : ''}
                              {brl(r.balance + r.balancePending)} na carteira
                            </span>
                          ) : (
                            <span className="muted tiny">nenhuma</span>
                          )}
                        </td>
                        <td>
                          <span
                            className={`pill status-${
                              r.status === 'completed'
                                ? 'completed'
                                : r.status === 'rejected'
                                  ? 'cancelled'
                                  : 'pending'
                            }`}
                          >
                            {DELETION_STATUS_LABEL[r.status] ?? r.status}
                          </span>
                        </td>
                        <td>
                          {open && (
                            <div className="acts">
                              <Button
                                variant="mini"
                                onClick={() => setDeleting({ request: r, action: 'complete' })}
                              >
                                <Trash2 size={14} /> Concluir exclusão
                              </Button>
                              <Button
                                variant="mini"
                                onClick={() => setDeleting({ request: r, action: 'reject' })}
                              >
                                <XCircle size={14} /> Recusar
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>
            <Mail size={16} /> Caixa de saída de e-mails
          </h3>
          <span className="muted tiny">
            {emails.data?.[0]?.provider === 'smtp'
              ? 'enviados via SMTP'
              : 'provedor simulado: os e-mails ficam aqui (links de confirmação e de senha)'}
          </span>
        </div>
        <QueryState
          isLoading={emails.isLoading}
          error={emails.error}
          data={emails.data}
          empty="Nenhum e-mail gerado ainda."
          onRetry={() => void emails.refetch()}
        >
          {(list) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Para</th>
                    <th>Assunto</th>
                    <th>Tipo</th>
                    <th>Status</th>
                    <th className="right">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id} data-testid={`email-${e.id}`}>
                      <td className="muted tiny">{dtm(e.createdAt)}</td>
                      <td>
                        <span className="mono">{e.to}</span>
                      </td>
                      <td>
                        <strong>{e.subject}</strong>
                      </td>
                      <td className="muted tiny">
                        {EMAIL_TEMPLATE_LABEL[e.template] ?? e.template}
                      </td>
                      <td>
                        <span
                          className={`pill status-${
                            e.status === 'sent'
                              ? 'completed'
                              : e.status === 'failed'
                                ? 'cancelled'
                                : 'pending'
                          }`}
                        >
                          {e.status === 'sent'
                            ? 'Enviado'
                            : e.status === 'failed'
                              ? 'Falhou'
                              : 'Na fila'}
                        </span>
                      </td>
                      <td>
                        <div className="acts">
                          <Button variant="mini" onClick={() => setOpenEmail(e)}>
                            Ver
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
      {processing && (
        <WithdrawalModal
          withdrawal={processing.withdrawal}
          action={processing.action}
          onClose={() => setProcessing(null)}
        />
      )}
      {deleting && (
        <DeletionModal
          request={deleting.request}
          action={deleting.action}
          onClose={() => setDeleting(null)}
        />
      )}
      {openEmail && <EmailModal email={openEmail} onClose={() => setOpenEmail(null)} />}
    </div>
  );
}
