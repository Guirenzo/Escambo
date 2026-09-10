import { CheckCircle2, Flag, PackageCheck, RotateCcw } from 'lucide-react';
import type { ContractWithHistory, Milestone } from '@escambo/types';
import { Button } from '../../components/ui';
import { brl, dtm, MILESTONE_STATUS_LABEL } from '../../lib/format';
import { useMilestoneAction } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

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
  const toast = useToast();
  const act = useMilestoneAction(contract.id);
  const list = contract.milestones;
  if (list.length === 0) return null;

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
          ? `Marco aprovado: ${brl(m.freelancerNet)} liberados para o freelancer.`
          : action === 'deliver'
            ? 'Marco entregue. O cliente foi avisado.'
            : 'Revisão solicitada neste marco.',
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro na ação');
    }
  }

  return (
    <section className="card" aria-labelledby="milestones-title" data-testid="milestones">
      <div className="card-head">
        <h3 id="milestones-title">
          <Flag size={16} /> Marcos
        </h3>
        <span className="muted tiny">
          {released.length} de {list.length} liberados · {brl(releasedTotal)} de{' '}
          {brl(contract.price)}
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
                {m.deliveryNote && m.status !== 'funded' && (
                  <div className="muted tiny">
                    <PackageCheck size={12} /> {m.deliveryNote}
                    {m.deliveredAt ? ` · ${dtm(m.deliveredAt)}` : ''}
                  </div>
                )}
                {m.revisionNote && m.status === 'funded' && (
                  <div className="muted tiny">
                    <RotateCcw size={12} /> Revisão pedida: {m.revisionNote}
                  </div>
                )}
                {m.releasedAt && (
                  <div className="muted tiny">
                    <CheckCircle2 size={12} /> {brl(m.freelancerNet)} liberados em{' '}
                    {dtm(m.releasedAt)}
                  </div>
                )}
              </div>
            </div>
            <div className="milestone-side">
              <strong className="price">{brl(m.amount)}</strong>
              <span className={`pill ${pillOf(m.status)}`}>
                {MILESTONE_STATUS_LABEL[m.status] ?? m.status}
              </span>
              {open && (
                <div className="acts">
                  {isFreelancer && m.status === 'funded' && (
                    <Button
                      variant="mini"
                      disabled={act.isPending}
                      onClick={() => void run(m, 'deliver')}
                    >
                      Entregar marco
                    </Button>
                  )}
                  {isClient && m.status === 'delivered' && (
                    <>
                      <Button
                        variant="mini"
                        disabled={act.isPending}
                        onClick={() => void run(m, 'approve')}
                      >
                        Aprovar marco
                      </Button>
                      <Button
                        variant="mini"
                        disabled={act.isPending}
                        onClick={() => void run(m, 'request-revision')}
                      >
                        Pedir revisão
                      </Button>
                    </>
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
