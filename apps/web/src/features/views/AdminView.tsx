import {
  ArrowDownToLine,
  Banknote,
  Briefcase,
  CheckCircle2,
  ChevronRight,
  Coins,
  Flag,
  Gavel,
  LifeBuoy,
  Lock,
  Mail,
  MailOpen,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  UserX,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdminDeletionRequest,
  AdminEmail,
  AdminMetrics,
  AdminWithdrawal,
  Dispute,
  DisputeResolution,
  ModerationHealth,
} from '@escambo/types';
import {
  Button,
  Field,
  Input,
  Modal,
  onTablistKeyDown,
  PageHeader,
  QueryState,
  Stat,
  TableWrap,
} from '../../components/ui';
import { Avatar } from '../../components/Avatar';
import { dueDayText } from '../../lib/business-days';
import {
  brl,
  DELETION_STATUS_LABEL,
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
  dtm,
  hm,
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
  useMfaStatus,
  useModerationHealth,
  useResolveDispute,
  qk,
} from '../../lib/hooks';
import { usePageTitle } from '../../lib/title';
import { useScrollToHashWhenSettled } from '../../lib/useScrollToHash';
import { FinanceSection } from '../admin/FinanceSection';
import { SettingsSection } from '../admin/SettingsSection';
import { StorageSection } from '../admin/StorageSection';
import { AppealsSection } from '../admin/AppealsSection';
import { ModerationHealthSection } from '../admin/ModerationHealthSection';
import { ReportsSection } from '../admin/ReportsSection';
import { SupportSection } from '../admin/SupportSection';
import { AccountSupportSection } from '../admin/AccountSupportSection';
import { isMfaRequired, MfaRequiredCard } from '../admin/MfaRequiredCard';
import { CountBadge, SectionHead } from '../admin/SectionHead';
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
    hint: 'Parte do valor volta ao cliente e o restante vai ao freelancer (de 5% a 95%; tudo de um lado é liberar ou devolver).',
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
              min={5}
              max={95}
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
  digest: 'Resumo diário',
  moderation_report: 'Relatório da moderação',
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

const ADMIN_SUBTITLE = 'Métricas da plataforma, mediação de disputas, saques e moderação.';

/**
 * Painel do administrador. Com ADMIN_MFA_REQUIRED no servidor, uma conta admin sem a verificação
 * em duas etapas recebe 403 `mfa_required` em toda rota /admin: em vez de um erro em cada fila, o
 * painel dá lugar a um cartão que leva ao Perfil. A situação da 2FA decide antes; se ela estiver
 * velha (desativada pelo atendimento com a tela aberta), o 403 dos indicadores decide e a relê.
 */
export function AdminView() {
  usePageTitle('Administração');
  const qc = useQueryClient();
  const mfa = useMfaStatus();
  const [blocked, setBlocked] = useState(false);
  const onMfaRequired = useCallback(() => {
    setBlocked(true);
    void qc.invalidateQueries({ queryKey: qk.mfaStatus });
  }, [qc]);
  const gated = mfa.data ? mfa.data.required && !mfa.data.enabled : blocked;

  if (gated) {
    return (
      <div className="page">
        <PageHeader title="Administração" subtitle={ADMIN_SUBTITLE} />
        <MfaRequiredCard />
      </div>
    );
  }
  return <AdminPanel onMfaRequired={onMfaRequired} />;
}

/** As seções do painel, na ordem da página: [âncora, rótulo] da navegação do topo. */
const ADMIN_SECTIONS: [string, string][] = [
  ['indicadores', 'Indicadores'],
  ['finance-title', 'Financeiro'],
  ['storage-title', 'Armazenamento'],
  ['settings-title', 'Parâmetros'],
  ['health-title', 'Moderação'],
  ['reports-title', 'Denúncias'],
  ['appeals-title', 'Contestações'],
  ['suporte', 'Suporte'],
  ['atendimento-conta', 'Atendimento de conta'],
  ['mediacao', 'Mediação'],
  ['saques', 'Saques'],
  ['exclusoes', 'Exclusões (LGPD)'],
  ['emails', 'E-mails'],
];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Quantos e-mails a caixa de saída mostra de cada vez (a lista cresce com o uso da plataforma). */
const EMAIL_PAGE = 12;

interface Attention {
  href: string;
  Icon: LucideIcon;
  tone: 'amber' | 'blue' | 'violet' | 'red';
  title: string;
  hint: string;
}

/**
 * "Pede atenção agora": as filas com alguém esperando a equipe, cada uma um atalho para a seção. Os
 * números vêm dos indicadores (renovados a cada 30 s) e da saúde da moderação; fila vazia não
 * aparece, e sem nada pendente a faixa diz que está tudo em dia.
 */
function AttentionBand({
  m,
  health,
}: {
  m: AdminMetrics | undefined;
  health: ModerationHealth | undefined;
}) {
  if (!m) return null;
  const items: Attention[] = [];
  if (m.openDisputes > 0)
    items.push({
      href: '#mediacao',
      Icon: Gavel,
      tone: 'red',
      title: `Mediar ${plural(m.openDisputes, 'disputa', 'disputas')}`,
      hint: 'o escrow espera a decisão',
    });
  if (m.pendingWithdrawals > 0)
    items.push({
      href: '#saques',
      Icon: Banknote,
      tone: m.overdueWithdrawals > 0 ? 'red' : 'amber',
      title: `Pagar ${plural(m.pendingWithdrawals, 'saque', 'saques')}`,
      hint: `${brl(m.pendingWithdrawalsAmount)}${
        m.overdueWithdrawals > 0
          ? ` · ${plural(m.overdueWithdrawals, 'passou', 'passaram')} do prazo`
          : ' no prazo'
      }`,
    });
  if (health && health.queue.pending > 0)
    items.push({
      href: '#reports-title',
      Icon: Flag,
      tone: health.queue.overSlaPending > 0 ? 'red' : 'amber',
      title: `Decidir ${plural(health.queue.pending, 'denúncia', 'denúncias')}`,
      hint:
        health.queue.overSlaPending > 0
          ? `${plural(health.queue.overSlaPending, 'passou', 'passaram')} da meta de ${health.slaHours} h`
          : `meta de ${health.slaHours} h`,
    });
  if (health && health.queue.appealsPending > 0)
    items.push({
      href: '#appeals-title',
      Icon: Scale,
      tone: 'violet',
      title: `Julgar ${plural(health.queue.appealsPending, 'contestação', 'contestações')}`,
      hint: 'o autor pediu revisão',
    });
  if (m.supportAwaitingReply > 0)
    items.push({
      href: '#suporte',
      Icon: LifeBuoy,
      tone: m.supportSlaOverdue > 0 ? 'red' : 'blue',
      title: `Responder ${plural(m.supportAwaitingReply, 'chamado', 'chamados')}`,
      hint:
        m.supportSlaOverdue > 0
          ? `${plural(m.supportSlaOverdue, 'está', 'estão')} com o SLA vencido`
          : 'aguardando a equipe',
    });
  if (m.pendingDeletions > 0)
    items.push({
      href: '#exclusoes',
      Icon: UserX,
      tone: 'violet',
      title: `Analisar ${plural(m.pendingDeletions, 'exclusão', 'exclusões')}`,
      hint: 'pedidos de conta (LGPD)',
    });

  return (
    <section className="adm-attention" aria-labelledby="attention-title" data-testid="attention">
      <div className="adm-attention-head">
        <h2 id="attention-title">Pede atenção agora</h2>
        <p>
          {items.length > 0
            ? 'As filas com alguém esperando a equipe. Cada atalho leva à seção.'
            : 'Nenhuma fila esperando a equipe: tudo em dia.'}
        </p>
      </div>
      {items.length > 0 ? (
        <ul className="adm-attention-list">
          {items.map((it) => (
            <li key={it.href}>
              <a href={it.href} className="adm-action">
                <span className={`adm-action-ico ${it.tone}`} aria-hidden="true">
                  <it.Icon size={18} />
                </span>
                <span className="adm-action-text">
                  <strong>{it.title}</strong>
                  <span>{it.hint}</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" className="adm-action-go" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="adm-attention-ok">
          <CheckCircle2 size={18} aria-hidden="true" /> Disputas, saques, denúncias, contestações,
          chamados e exclusões sem pendência.
        </p>
      )}
    </section>
  );
}

/** Métricas, fila de mediação, fila de saques, pedidos LGPD, atendimento e e-mails. */
function AdminPanel({ onMfaRequired }: { onMfaRequired: () => void }) {
  useScrollToHashWhenSettled();
  const metrics = useAdminMetrics();
  const health = useModerationHealth(30);
  const mfaBlocked = isMfaRequired(metrics.error);
  useEffect(() => {
    if (mfaBlocked) onMfaRequired();
  }, [mfaBlocked, onMfaRequired]);
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
  const [emailCount, setEmailCount] = useState(EMAIL_PAGE);
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
    <div className="page page-wide admin-page">
      <PageHeader title="Administração" subtitle={ADMIN_SUBTITLE} />

      <AttentionBand m={m} health={health.data} />

      {/* Atalhos para as seções desta página longa: âncoras comuns (o Tab e o "voltar" seguem).
          Lista com nome, e não <nav>: um marco de navegação no meio do conteúdo embaralharia a ordem
          "menu antes do conteúdo" de quem anda pelos marcos (como nas migalhas). */}
      <div className="section-nav">
        <ul aria-label="Seções da administração">
          {ADMIN_SECTIONS.map(([hash, label]) => (
            <li key={hash}>
              <a href={`#${hash}`}>{label}</a>
            </li>
          ))}
        </ul>
      </div>

      <div className="kpis adm-kpis" id="indicadores">
        <Stat
          Icon={Users}
          label="Usuários"
          value={m ? m.users : '—'}
          hint={m ? `${m.freelancers} freelancers` : ''}
        />
        <Stat
          Icon={Briefcase}
          label="Contratações"
          value={m ? m.contracts : '—'}
          hint={
            m ? (
              <>
                <CheckCircle2 size={12} /> {m.completedContracts} concluídas
              </>
            ) : (
              ''
            )
          }
        />
        <Stat
          Icon={Gavel}
          label="Disputas abertas"
          value={m ? m.openDisputes : '—'}
          tone={m && m.openDisputes > 0 ? 'amber' : undefined}
          hint="aguardando mediação"
        />
        <Stat
          Icon={Coins}
          label="Receita da plataforma"
          value={m ? brl(m.platformFees) : '—'}
          tone="blue"
          hint="taxas retidas desde o início, líquidas de estornos"
        />
        <Stat
          Icon={ArrowDownToLine}
          label="Depósitos confirmados"
          value={m ? brl(m.depositsTotal) : '—'}
          hint="entradas via PIX (gateway)"
        />
        <Stat
          Icon={Lock}
          label="Em escrow"
          value={m ? brl(m.inEscrow) : '—'}
          tone="amber"
          hint="reservado em propostas e contratações"
        />
        <Stat
          Icon={Banknote}
          label="Saldo dos usuários"
          value={m ? brl(m.usersBalance) : '—'}
          hint="disponível para contratar ou sacar"
        />
        <Stat
          Icon={Banknote}
          label="Saques pendentes"
          value={m ? m.pendingWithdrawals : '—'}
          tone="blue"
          hint={
            <>
              {m ? `${brl(m.pendingWithdrawalsAmount)} a pagar` : ''}
              {m && m.overdueWithdrawals > 0 ? ` · ${m.overdueWithdrawals} atrasado(s)` : ''}
            </>
          }
        />
        {/* Suporte (RF-076): ocupa a linha inteira, com os três números lado a lado. */}
        <div className="kpi kpi-wide amber" data-testid="kpi-support">
          <div className="kpi-top">
            <span className="kpi-ico" aria-hidden="true">
              <LifeBuoy size={20} />
            </span>
            <span className="kpi-label">Chamados de suporte</span>
            <a className="tiny kpi-link" href="#suporte">
              Ir para o atendimento
            </a>
          </div>
          <dl className="kpi-split">
            <div>
              <dt className="muted tiny">em aberto</dt>
              <dd>
                <strong className="kpi-value">{m ? m.supportOpen : '—'}</strong>
              </dd>
            </div>
            <div>
              <dt className="muted tiny">aguardando resposta da equipe</dt>
              <dd>
                <strong className="kpi-value">{m ? m.supportAwaitingReply : '—'}</strong>
              </dd>
            </div>
            <div className={m && m.supportSlaOverdue > 0 ? 'kpi-late' : undefined}>
              <dt className="muted tiny">sem primeira resposta e com o SLA vencido</dt>
              <dd>
                <strong className="kpi-value">{m ? m.supportSlaOverdue : '—'}</strong>
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <p className="muted tiny kpis-note" data-testid="metrics-updated">
        {metrics.dataUpdatedAt > 0
          ? `Atualizado às ${hm(new Date(metrics.dataUpdatedAt).toISOString())}. `
          : ''}
        Os números se renovam sozinhos a cada 30 segundos enquanto esta aba está aberta.
      </p>

      <FinanceSection />
      <StorageSection />
      <SettingsSection />
      <ModerationHealthSection />
      <ReportsSection />
      <AppealsSection />
      <SupportSection />
      <AccountSupportSection />

      <section className="card" id="mediacao">
        <SectionHead
          icon={ShieldAlert}
          tone="red"
          title="Fila de mediação"
          subtitle="Disputas abertas pelas partes: decida se o escrow vai ao freelancer, volta ao cliente ou se divide."
          badge={
            disputes.data && (
              <CountBadge hot={disputes.data.length > 0}>
                {disputes.data.length} aberta(s)
              </CountBadge>
            )
          }
        />
        <QueryState
          isLoading={disputes.isLoading}
          error={disputes.error}
          data={disputes.data}
          isEmpty={(list) => list.length === 0}
          emptyIcon={ShieldCheck}
          emptyTitle="Fila em dia"
          empty="Nenhuma disputa aberta. Tudo em paz."
          onRetry={() => void disputes.refetch()}
        >
          {(list) => (
            <TableWrap label="Tabela de disputas">
              <table className="table queue">
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
                      <td className="cell-title q-main">
                        <strong>#{d.id}</strong>
                        <span className="muted tiny">aberta em {dtm(d.createdAt)}</span>
                      </td>
                      <td data-label="Contrato">
                        <Link to={`/contratos/${d.contractId}`}>#{d.contractId}</Link>
                      </td>
                      <td data-label="Motivo" className="q-wide">
                        <strong>{DISPUTE_REASON_LABEL[d.reason] ?? d.reason}</strong>
                        <div className="muted tiny q-text">{d.description}</div>
                      </td>
                      <td data-label="Status">
                        <span className="pill status-disputed">
                          {DISPUTE_STATUS_LABEL[d.status] ?? d.status}
                        </span>
                      </td>
                      <td className="q-acts">
                        <div className="acts">
                          <Button
                            variant="mini"
                            className="q-primary"
                            onClick={() => setResolving(d)}
                          >
                            <Gavel size={14} /> Resolver
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </QueryState>
      </section>

      <section className="card" id="saques">
        <SectionHead
          icon={Banknote}
          tone="amber"
          title="Fila de saques"
          subtitle="Pagamentos pedidos pelos usuários, pelo prazo: processe, conclua com a referência ou estorne."
        >
          <div
            className="tabs tabs-mini"
            role="tablist"
            onKeyDown={onTablistKeyDown}
            aria-label="Filtro de saques"
          >
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
        </SectionHead>
        <QueryState
          isLoading={withdrawals.isLoading}
          error={withdrawals.error}
          data={withdrawals.data}
          isEmpty={(list) => list.length === 0}
          emptyIcon={Banknote}
          emptyTitle={scope === 'open' ? 'Fila em dia' : 'Sem saques'}
          empty={
            scope === 'open'
              ? 'Nenhum saque aguardando. Nada a pagar.'
              : 'Nenhum saque pedido ainda.'
          }
          onRetry={() => void withdrawals.refetch()}
        >
          {(list) => (
            <TableWrap label="Tabela de saques">
              <table className="table queue">
                <thead>
                  <tr>
                    <th>Saque</th>
                    <th>Prazo</th>
                    <th>Titular</th>
                    <th>Valor</th>
                    <th>Destino</th>
                    <th>Status</th>
                    <th className="right">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((w) => (
                    <tr
                      key={w.id}
                      data-testid={`withdrawal-${w.id}`}
                      className={w.overdue ? 'q-late' : undefined}
                    >
                      <td className="cell-title q-main">
                        <strong>#{w.id}</strong>
                        <span className="muted tiny">pedido em {dtm(w.createdAt)}</span>
                      </td>
                      <td data-label="Prazo">
                        {/* RN-035: a fila já vem pelo prazo; o atrasado ganha a marca. */}
                        {w.dueAt ? (
                          <span className="muted tiny">até {dueDayText(w.dueAt)}</span>
                        ) : (
                          <span className="muted tiny">—</span>
                        )}
                        {w.overdue && (
                          <div>
                            <span className="pill status-cancelled">Atrasado</span>
                          </div>
                        )}
                      </td>
                      <td data-label="Titular">
                        <div className="q-person">
                          <Avatar name={w.userName ?? w.userEmail} size="sm" />
                          <div className="cell-title">
                            <strong>{w.userName ?? '—'}</strong>
                            <span className="muted tiny">{w.userEmail}</span>
                          </div>
                        </div>
                      </td>
                      <td data-label="Valor">
                        <strong className="price q-amount">{brl(w.amount)}</strong>
                      </td>
                      <td data-label="Destino">
                        <span className="mono">{w.destination}</span>
                        <div className="muted tiny">
                          {w.method === 'pix' ? 'chave PIX' : 'conta bancária'}
                        </div>
                      </td>
                      <td data-label="Status">
                        <span className={`pill status-${WITHDRAWAL_STATUS_TONE[w.status] ?? ''}`}>
                          {WITHDRAWAL_STATUS_LABEL[w.status] ?? w.status}
                        </span>
                      </td>
                      <td className="q-acts">
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
                                className="q-primary"
                                onClick={() => setProcessing({ withdrawal: w, action: 'complete' })}
                              >
                                <CheckCircle2 size={14} /> Concluir
                              </Button>
                              <Button
                                variant="mini"
                                className="q-danger"
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
            </TableWrap>
          )}
        </QueryState>
      </section>

      <section className="card" id="exclusoes">
        <SectionHead
          icon={Trash2}
          tone="violet"
          title="Exclusões de conta (LGPD)"
          subtitle="Pedidos do titular: concluir anonimiza e encerra o acesso; recusar exige justificativa."
          badge={
            m &&
            m.pendingDeletions > 0 && <CountBadge hot>{m.pendingDeletions} pendente(s)</CountBadge>
          }
        >
          <div
            className="tabs tabs-mini"
            role="tablist"
            onKeyDown={onTablistKeyDown}
            aria-label="Filtro de exclusões"
          >
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
        </SectionHead>
        <QueryState
          isLoading={deletions.isLoading}
          error={deletions.error}
          data={deletions.data}
          isEmpty={(list) => list.length === 0}
          emptyIcon={UserCheck}
          emptyTitle={deletionScope === 'pending' ? 'Fila em dia' : 'Sem pedidos'}
          empty={
            deletionScope === 'pending'
              ? 'Nenhum pedido de exclusão aguardando.'
              : 'Nenhum pedido de exclusão ainda.'
          }
          onRetry={() => void deletions.refetch()}
        >
          {(list) => (
            <TableWrap label="Tabela de pedidos de exclusão">
              <table className="table queue">
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
                        <td className="cell-title q-main">
                          <strong>#{r.id}</strong>
                          <span className="muted tiny">pedido em {dtm(r.createdAt)}</span>
                        </td>
                        <td data-label="Titular">
                          <div className="q-person">
                            <Avatar name={r.userName ?? r.userEmail} size="sm" />
                            <div className="cell-title">
                              <strong>{r.userName ?? '—'}</strong>
                              <span className="muted tiny">{r.userEmail}</span>
                            </div>
                          </div>
                        </td>
                        <td data-label="Motivo" className="q-wide">
                          <div className="muted tiny q-text">{r.reason ?? '—'}</div>
                        </td>
                        <td data-label="Pendências">
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
                        <td data-label="Status">
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
                        <td className="q-acts">
                          {open && (
                            <div className="acts">
                              <Button
                                variant="mini"
                                className="q-danger"
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
            </TableWrap>
          )}
        </QueryState>
      </section>

      <section className="card" id="emails">
        <SectionHead
          icon={Mail}
          tone="blue"
          title="Caixa de saída de e-mails"
          subtitle={
            emails.data?.[0]?.provider === 'smtp'
              ? 'enviados via SMTP'
              : 'provedor simulado: os e-mails ficam aqui (links de confirmação e de senha)'
          }
          badge={
            emails.data && emails.data.length > 0 && <CountBadge>{emails.data.length}</CountBadge>
          }
        />
        <QueryState
          isLoading={emails.isLoading}
          error={emails.error}
          data={emails.data}
          isEmpty={(list) => list.length === 0}
          emptyIcon={MailOpen}
          emptyTitle="Caixa vazia"
          empty="Nenhum e-mail gerado ainda."
          onRetry={() => void emails.refetch()}
        >
          {(list) => (
            <>
              <TableWrap label="Tabela de e-mails enviados">
                <table className="table t-list emails-table">
                  <thead>
                    <tr>
                      <th>Assunto</th>
                      <th>Para</th>
                      <th>Quando</th>
                      <th>Tipo</th>
                      <th>Status</th>
                      <th className="right">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.slice(0, emailCount).map((e) => (
                      <tr key={e.id} data-testid={`email-${e.id}`}>
                        <td className="q-main">
                          <strong>{e.subject}</strong>
                        </td>
                        <td data-label="Para">
                          <span className="mono email-to">{e.to}</span>
                        </td>
                        <td data-label="Quando" className="muted tiny q-when">
                          {dtm(e.createdAt)}
                        </td>
                        <td data-label="Tipo" className="muted tiny">
                          {EMAIL_TEMPLATE_LABEL[e.template] ?? e.template}
                        </td>
                        <td data-label="Status">
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
                        <td className="q-acts">
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
              </TableWrap>
              {list.length > emailCount && (
                <div className="list-more">
                  <span className="muted tiny">
                    {emailCount} de {list.length}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => setEmailCount((n) => n + EMAIL_PAGE * 2)}
                  >
                    Mostrar mais {Math.min(EMAIL_PAGE * 2, list.length - emailCount)}
                  </Button>
                </div>
              )}
            </>
          )}
        </QueryState>
      </section>

      <p className="muted tiny adm-foot">
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
