import {
  Briefcase,
  CheckCircle2,
  Flag,
  ImageOff,
  MessageSquare,
  MessageSquareOff,
  Star,
  StarOff,
  UserRound,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdminReportAction,
  AdminReportActionResult,
  AdminReportGroup,
  ReportTargetType,
} from '@escambo/types';
import { Button, Field, Modal, QueryState } from '../../components/ui';
import { dtm, REPORT_REASON_LABEL, REPORT_STATUS_LABEL } from '../../lib/format';
import { useAdminReportAction, useAdminReports } from '../../lib/hooks';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
import { useToast } from '../../lib/toast';

const TONE: Record<string, string> = {
  pending: 'pending',
  reviewing: 'in_progress',
  actioned: 'completed',
  dismissed: 'cancelled',
};

const ICON: Record<ReportTargetType, LucideIcon> = {
  user: UserRound,
  avatar: UserRound,
  portfolio_item: ImageOff,
  service: Briefcase,
  review: Star,
  message: MessageSquare,
};

const COPY: Record<
  AdminReportAction,
  { title: string; confirm: string; done: string; hint: string }
> = {
  'remove-image': {
    title: 'Remover imagem',
    confirm: 'Remover e bloquear',
    done: 'Imagem removida e bloqueada.',
    hint: 'A imagem sai de todo perfil e trabalho que a mostra e a mesma imagem não pode ser enviada de novo. O arquivo fica guardado fora do ar enquanto o dono pode contestar, o dono recebe um aviso com a sua nota e o prazo, e a remoção conta para a reincidência dele.',
  },
  'remove-content': {
    title: 'Remover conteúdo',
    confirm: 'Remover e avisar o autor',
    done: 'Conteúdo removido.',
    hint: 'O conteúdo sai do ar e fica guardado para a contestação. O autor recebe um aviso com a sua nota e o prazo, e a remoção conta para a reincidência dele.',
  },
  dismiss: {
    title: 'Dispensar denúncias',
    confirm: 'Dispensar',
    done: 'Denúncias dispensadas.',
    hint: 'Nada muda no conteúdo. As denúncias saem da fila com a sua nota no histórico.',
  },
  resolve: {
    title: 'Marcar como resolvida',
    confirm: 'Marcar resolvida',
    done: 'Denúncias marcadas como resolvidas.',
    hint: 'Use quando a ação já foi tomada em outro lugar, como suspender a conta no perfil.',
  },
};

/** O que a remoção causou além de tirar a imagem: bloqueio de envio e revisão da conta (ADR 41). */
function removalMessage(r: AdminReportActionResult): string {
  const base = r.blocked
    ? 'Imagem removida e bloqueada.'
    : 'Imagem removida. Era um link externo, então não há arquivo para bloquear.';
  if (r.accountReviewOpened) {
    return `${base} O dono chegou a ${r.ownerStrikes} remoções e a conta entrou na fila para revisão.`;
  }
  if (r.uploadsBlockedUntil) {
    return `${base} O dono fica sem enviar imagens até ${dtm(r.uploadsBlockedUntil)}.`;
  }
  return base;
}

/** Textos da decisão; remover conteúdo diz se é a avaliação ou a mensagem (ADR 44). */
function copyFor(
  action: AdminReportAction,
  group: AdminReportGroup,
): (typeof COPY)[AdminReportAction] {
  if (action !== 'remove-content') return COPY[action];
  const review = group.targetType === 'review';
  return {
    title: review ? 'Remover avaliação' : 'Remover mensagem',
    confirm: 'Remover e avisar o autor',
    done: review ? 'Avaliação removida.' : 'Mensagem removida.',
    hint: review
      ? 'A avaliação sai do perfil e da nota média do freelancer, e na contratação as partes veem que ela foi removida. O texto fica guardado para a contestação, o autor recebe um aviso com a sua nota e o prazo, e a remoção conta para a reincidência dele.'
      : 'A mensagem vira um aviso no chat das duas partes, e o anexo dela deixa de abrir. O texto fica guardado para a contestação, o autor recebe um aviso com a sua nota e o prazo, e a remoção conta para a reincidência dele.',
  };
}

/** Remoção de texto: avisa se o autor chegou ao limite e a conta foi para revisão (ADR 44). */
function contentMessage(r: AdminReportActionResult, group: AdminReportGroup): string {
  const base = copyFor('remove-content', group).done;
  return r.accountReviewOpened
    ? `${base} O autor chegou a ${r.ownerStrikes} remoções e a conta entrou na fila para revisão.`
    : base;
}

const isContent = (g: AdminReportGroup): boolean =>
  g.targetType === 'review' || g.targetType === 'message';

const isImage = (g: AdminReportGroup): boolean =>
  (g.targetType === 'avatar' || g.targetType === 'portfolio_item') && Boolean(g.imageUrl);

/**
 * Miniatura do alvo. Imagem já removida (arquivo apagado) ou link externo fora do ar cai no ícone
 * do tipo de alvo, em vez do ícone de imagem quebrada do navegador.
 */
function ReportThumb({ group }: { group: AdminReportGroup }) {
  const [broken, setBroken] = useState(false);
  const Icon = ICON[group.targetType] ?? Flag;
  // Removida com ação e fora do ar: o arquivo já foi apagado, então nem pede a imagem.
  const removed = group.status === 'actioned' && !group.imageLive;
  if (group.imageUrl && !broken && !removed) {
    return (
      <img
        className="report-thumb"
        src={mediaVariant(group.imageUrl, MEDIA_THUMB.small)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className="report-thumb icon" aria-hidden="true">
      <Icon size={18} />
    </span>
  );
}

/** Fila de moderação (ADR 39): denúncias agrupadas por alvo, com decisão para o grupo todo. */
export function ReportsSection() {
  const [scope, setScope] = useState<'pending' | 'resolved'>('pending');
  const reports = useAdminReports(scope);
  const act = useAdminReportAction();
  const toast = useToast();
  const [deciding, setDeciding] = useState<{
    group: AdminReportGroup;
    action: AdminReportAction;
  } | null>(null);
  const [note, setNote] = useState('');

  function open(group: AdminReportGroup, action: AdminReportAction): void {
    setNote('');
    setDeciding({ group, action });
  }

  async function confirm(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!deciding) return;
    try {
      const r = await act.mutateAsync({
        id: deciding.group.id,
        action: deciding.action,
        note: note.trim() || null,
      });
      toast.success(
        deciding.action === 'remove-image'
          ? removalMessage(r)
          : deciding.action === 'remove-content'
            ? contentMessage(r, deciding.group)
            : COPY[deciding.action].done,
      );
      setDeciding(null);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível registrar a decisão');
    }
  }

  return (
    <section className="card wide" aria-labelledby="reports-title" data-testid="reports-card">
      <div className="card-head">
        <h3 id="reports-title">
          <Flag size={16} /> Denúncias
        </h3>
        <div className="tabs tabs-mini" role="tablist" aria-label="Filtro de denúncias">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'pending'}
            className={scope === 'pending' ? 'active' : ''}
            onClick={() => setScope('pending')}
          >
            Pendentes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'resolved'}
            className={scope === 'resolved' ? 'active' : ''}
            onClick={() => setScope('resolved')}
          >
            Resolvidas
          </button>
        </div>
      </div>
      <QueryState
        isLoading={reports.isLoading}
        error={reports.error}
        data={reports.data}
        empty={
          scope === 'pending'
            ? 'Nenhuma denúncia pendente. A comunidade está tranquila.'
            : 'Nenhuma denúncia analisada ainda.'
        }
        onRetry={() => void reports.refetch()}
      >
        {(list) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Alvo</th>
                  <th>Motivos</th>
                  <th>{scope === 'pending' ? 'Situação' : 'Decisão'}</th>
                  {scope === 'pending' && <th className="right">Ações</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((g) => (
                  <tr key={`${g.id}-${g.status}`} data-testid={`report-group-${g.id}`}>
                    <td>
                      <div className="report-target">
                        <ReportThumb group={g} />
                        <div className="cell-title">
                          <strong>{g.label}</strong>
                          {g.owner && (
                            <span className="muted tiny">
                              de {g.owner.name ?? 'conta sem nome'}
                              {g.targetType !== 'review' && g.targetType !== 'message' && (
                                <>
                                  {' · '}
                                  <Link to={`/freelancers/${g.owner.ulid}`}>ver perfil</Link>
                                </>
                              )}
                            </span>
                          )}
                          {g.excerpt && <span className="muted tiny clamp">“{g.excerpt}”</span>}
                          {g.imageUrl && !g.imageLive && (
                            <span className="muted tiny">esta imagem já não está no ar</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="report-reasons">
                        {g.reasons.map((r) => (
                          <span key={r.reason} className="reason-tag">
                            {REPORT_REASON_LABEL[r.reason] ?? r.reason}
                            {r.count > 1 ? ` ×${r.count}` : ''}
                          </span>
                        ))}
                        {g.automatic && (
                          <span className="reason-tag auto">Sinalização automática</span>
                        )}
                      </div>
                      {g.descriptions[0] && (
                        <div className="muted tiny clamp">{g.descriptions[0]}</div>
                      )}
                      <div className="muted tiny">
                        {g.reports} denúncia{g.reports > 1 ? 's' : ''} · última em{' '}
                        {dtm(g.lastReportedAt)}
                      </div>
                    </td>
                    <td>
                      <div className="cell-title">
                        <span className={`pill status-${TONE[g.status] ?? ''}`}>
                          {REPORT_STATUS_LABEL[g.status] ?? g.status}
                        </span>
                        {g.resolutionNote && (
                          <span className="muted tiny clamp">{g.resolutionNote}</span>
                        )}
                        {g.reviewedAt && <span className="muted tiny">em {dtm(g.reviewedAt)}</span>}
                      </div>
                    </td>
                    {scope === 'pending' && (
                      <td>
                        <div className="acts">
                          {isImage(g) ? (
                            <Button
                              variant="danger"
                              className="mini"
                              onClick={() => open(g, 'remove-image')}
                            >
                              <ImageOff size={14} /> Remover imagem
                            </Button>
                          ) : isContent(g) ? (
                            <Button
                              variant="danger"
                              className="mini"
                              onClick={() => open(g, 'remove-content')}
                            >
                              {g.targetType === 'review' ? (
                                <StarOff size={14} />
                              ) : (
                                <MessageSquareOff size={14} />
                              )}{' '}
                              {g.targetType === 'review' ? 'Remover avaliação' : 'Remover mensagem'}
                            </Button>
                          ) : (
                            <Button variant="mini" onClick={() => open(g, 'resolve')}>
                              <CheckCircle2 size={14} /> Resolvida
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            className="mini"
                            onClick={() => open(g, 'dismiss')}
                          >
                            <XCircle size={14} /> Dispensar
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>

      {deciding && (
        <Modal
          title={copyFor(deciding.action, deciding.group).title}
          onClose={() => setDeciding(null)}
        >
          <form className="stack" onSubmit={confirm}>
            <div className="report-subject">
              <ReportThumb group={deciding.group} />
              <div className="cell-title">
                <strong>{deciding.group.label}</strong>
                <span className="muted tiny">
                  {deciding.group.reports} denúncia{deciding.group.reports > 1 ? 's' : ''}
                  {deciding.group.owner?.name ? ` · de ${deciding.group.owner.name}` : ''}
                </span>
                {deciding.group.excerpt && (
                  <span className="muted tiny clamp">“{deciding.group.excerpt}”</span>
                )}
              </div>
            </div>
            <p className="muted tiny">{copyFor(deciding.action, deciding.group).hint}</p>
            <Field label="Nota para o registro">
              <textarea
                className="textarea"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Por que esta decisão"
              />
            </Field>
            <Button
              type="submit"
              variant={deciding.action.startsWith('remove') ? 'danger' : 'primary'}
              disabled={act.isPending}
            >
              {act.isPending ? 'Salvando…' : copyFor(deciding.action, deciding.group).confirm}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
