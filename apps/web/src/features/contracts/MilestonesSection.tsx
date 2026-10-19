import { BusinessButton } from '../../components/BusinessActions';
import { CalendarClock, CheckCircle2, Flag, PackageCheck, RotateCcw } from 'lucide-react';
import type { ContractWithHistory, Milestone } from '@escambo/types';
import { useAuth } from '../../lib/auth';
import { deadlineInfo, deadlineText, deadlineZoneNote, momentText } from '../../lib/deadline';
import { brl, dtm, MILESTONE_STATUS_LABEL } from '../../lib/format';
import { DEFAULT_TIMEZONE } from '../../lib/timezones';
import { useGrantMilestoneRevision, useMilestoneAction } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { GRANT_REVISION_CONFIRMATION, revisionCount, revisionsExhausted } from './contractRules';

const pillOf = (status: Milestone['status']): string =>
  status === 'released'
    ? 'status-completed'
    : status === 'delivered'
      ? 'status-delivered'
      : status === 'cancelled'
        ? 'status-cancelled'
        : status === 'funded'
          ? 'status-in_progress'
          : 'status-pending';

/**
 * Escrow por marcos (RN-069): lista dos marcos com progresso do que já foi liberado e as ações
 * de cada lado — o freelancer entrega marco a marco, o cliente aprova (libera só aquele valor)
 * ou pede revisão. O último marco aprovado conclui a contratação.
 */
export function MilestonesSection({
  contract,
  myId,
}: {
  contract: ContractWithHistory;
  myId: number;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const act = useMilestoneAction(contract.id);
  const grant = useGrantMilestoneRevision(contract.id);
  const busy = act.isPending || grant.isPending;
  const list = contract.milestones;
  if (list.length === 0) return null;

  const isCredits = contract.paymentMode === 'credits';
  /** R$ ou créditos, conforme a modalidade da contratação. */
  const fmt = (v: number): string => (isCredits ? `${Math.round(v)} cr` : brl(v));
  const isClient = contract.clientId === myId;
  const isFreelancer = contract.freelancerId === myId;
  const open = contract.status === 'accepted' || contract.status === 'in_progress';
  const released = list.filter((m) => m.status === 'released');
  const releasedTotal = released.reduce((acc, m) => acc + m.amount, 0);
  const pct = Math.round((releasedTotal / contract.price) * 100);

  async function run(
    m: Milestone,
    action: 'deliver' | 'approve' | 'request-revision',
  ): Promise<void> {
    if (busy || (action === 'request-revision' && revisionsExhausted(m.revisions))) return;
    let text: string | undefined;
    if (action === 'deliver') {
      text = (window.prompt(`Mensagem da entrega do marco «${m.title}»:`) ?? '').trim();
      if (!text) return;
    }
    if (action === 'request-revision') {
      text = (window.prompt('O que precisa ser ajustado neste marco?') ?? '').trim();
      if (!text) return;
    }
    try {
      await act.mutateAsync({ milestoneId: m.id, action, text });
      toast.success(
        action === 'approve'
          ? `Marco aprovado: ${
              isCredits ? `${Math.round(m.freelancerNet)} créditos` : brl(m.freelancerNet)
            } liberados para o freelancer.`
          : action === 'deliver'
            ? 'Marco entregue. O cliente foi avisado.'
            : 'Revisão solicitada neste marco.',
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro na ação');
    }
  }

  async function grantRevision(m: Milestone): Promise<void> {
    if (busy || !window.confirm(GRANT_REVISION_CONFIRMATION)) return;
    try {
      await grant.mutateAsync({ milestoneId: m.id });
      toast.success(
        'Mais uma revisão sem custo liberada neste marco. O prazo de aprovação automática continua o mesmo.',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível liberar a revisão');
    }
  }

  return (
    <section className="card" aria-labelledby="milestones-title" data-testid="milestones">
      <div className="card-head">
        <h3 id="milestones-title">
          <Flag size={16} /> Marcos
        </h3>
        <span className="muted tiny">
          {released.length} de {list.length} liberados · {fmt(releasedTotal)} de{' '}
          {fmt(contract.price)}
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Progresso dos marcos"
      >
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <ol className="milestones">
        {list.map((m, i) => (
          <li key={m.id} className={`milestone ${m.status}`} data-testid={`milestone-${m.id}`}>
            <div className="milestone-main">
              <span className="milestone-index">{i + 1}</span>
              <div className="milestone-body">
                <strong>{m.title}</strong>
                {m.description && <div className="muted tiny">{m.description}</div>}
                {m.revisions && (
                  <div className="muted tiny" data-testid={`milestone-revisions-${m.id}`}>
                    Revisões: {revisionCount(m.revisions)}
                  </div>
                )}
                {open && m.status === 'delivered' && revisionsExhausted(m.revisions) && (
                  <p className="muted tiny">
                    As {m.revisions!.limit} revisões sem custo deste marco foram usadas. Combine
                    pelo chat{isClient ? '; o freelancer pode liberar mais uma' : ''}.
                  </p>
                )}
                {m.dueAt && (
                  <div className="muted tiny" data-testid={`milestone-due-${m.id}`}>
                    <CalendarClock size={12} />{' '}
                    {deadlineText(m.dueAt, m.dueZone ?? DEFAULT_TIMEZONE)}
                    {deadlineZoneNote(m.dueAt, m.dueZone ?? DEFAULT_TIMEZONE, user?.timezone)}
                    {m.status === 'funded' &&
                      !m.deliveredAt &&
                      open &&
                      (() => {
                        const info = deadlineInfo(m.dueAt, m.dueZone ?? DEFAULT_TIMEZONE);
                        return info ? (
                          <>
                            {' · '}
                            <span className={`deadline-text-${info.tone}`}>{info.label}</span>
                          </>
                        ) : null;
                      })()}
                    {(m.status === 'delivered' || m.status === 'released') &&
                      m.deliveredAt &&
                      new Date(m.deliveredAt).getTime() > new Date(m.dueAt).getTime() &&
                      ' · entregue com atraso'}
                  </div>
                )}
                {m.deliveryNote && m.status !== 'funded' && (
                  <div className="muted tiny">
                    <PackageCheck size={12} /> {m.deliveryNote}
                    {m.deliveredAt ? ` · ${dtm(m.deliveredAt)}` : ''}
                  </div>
                )}
                {m.status === 'delivered' && m.approvalDueAt && (
                  <div className="muted tiny" data-testid={`milestone-approval-${m.id}`}>
                    aprovação automática a partir de {momentText(m.approvalDueAt, user?.timezone)}
                  </div>
                )}
                {m.status === 'funded' && m.deliveredAt && m.revisionRequestedAt && (
                  <div className="muted tiny" data-testid={`milestone-revision-since-${m.id}`}>
                    revisão pedida em {momentText(m.revisionRequestedAt, user?.timezone)}
                    {(() => {
                      const days = Math.floor(
                        (Date.now() - Date.parse(m.revisionRequestedAt)) / 86_400_000,
                      );
                      return days >= 7 ? ` (há ${days} dias)` : '';
                    })()}
                  </div>
                )}
                {m.revisionNote && m.status === 'funded' && (
                  <div className="muted tiny">
                    <RotateCcw size={12} /> Revisão pedida: {m.revisionNote}
                  </div>
                )}
                {m.releasedAt && (
                  <div className="muted tiny">
                    <CheckCircle2 size={12} />{' '}
                    {isCredits ? `${Math.round(m.freelancerNet)} créditos` : brl(m.freelancerNet)}{' '}
                    liberados em {dtm(m.releasedAt)}
                  </div>
                )}
              </div>
            </div>
            <div className="milestone-side">
              <strong className="price">{fmt(m.amount)}</strong>
              <span className={`pill ${pillOf(m.status)}`}>
                {MILESTONE_STATUS_LABEL[m.status] ?? m.status}
              </span>
              {open && (
                <div className="acts">
                  {isFreelancer && m.status === 'funded' && (
                    <BusinessButton
                      variant="mini"
                      disabled={busy}
                      onClick={() => void run(m, 'deliver')}
                    >
                      Entregar marco
                    </BusinessButton>
                  )}
                  {isClient && m.status === 'delivered' && (
                    <>
                      <BusinessButton
                        variant="mini"
                        disabled={busy}
                        onClick={() => void run(m, 'approve')}
                      >
                        Aprovar marco
                      </BusinessButton>
                      {!revisionsExhausted(m.revisions) && (
                        <BusinessButton
                          variant="mini"
                          disabled={busy}
                          onClick={() => void run(m, 'request-revision')}
                        >
                          Pedir revisão
                        </BusinessButton>
                      )}
                    </>
                  )}
                  {isFreelancer && m.status === 'delivered' && revisionsExhausted(m.revisions) && (
                    <BusinessButton
                      variant="mini"
                      disabled={busy}
                      onClick={() => void grantRevision(m)}
                    >
                      Liberar mais uma revisão
                    </BusinessButton>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
