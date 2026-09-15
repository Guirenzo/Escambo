import { Gavel, ImageOff, MessageSquareOff, RotateCcw, ShieldX, StarOff } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AdminAppeal, AppealDecision } from '@escambo/types';
import { Button, Field, Modal, QueryState } from '../../components/ui';
import { APPEAL_STATUS_LABEL, dtm, REPORT_REASON_LABEL } from '../../lib/format';
import { useAdminAppealDecision, useAdminAppeals, useAppealImage } from '../../lib/hooks';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
import { useToast } from '../../lib/toast';

const TONE: Record<AdminAppeal['status'], string> = {
  appealed: 'pending',
  upheld: 'cancelled',
  overturned: 'completed',
};

/** Avaliação e mensagem (ADR 44): não há imagem, a decisão é pelo texto removido. */
const isText = (a: { targetType: string }): boolean =>
  a.targetType === 'review' || a.targetType === 'message';

function copyFor(
  decision: AppealDecision,
  appeal: AdminAppeal,
): { title: string; confirm: string; hint: string } {
  const image = !isText(appeal);
  if (decision === 'overturn') {
    return {
      title: 'Reverter remoção',
      confirm: image ? 'Reverter e devolver a imagem' : 'Reverter e devolver o conteúdo',
      hint: image
        ? 'A imagem volta para onde estava, se o lugar continua vazio, sai da lista de bloqueio e a remoção deixa de contar para a reincidência. O dono recebe a sua nota.'
        : appeal.targetType === 'review'
          ? 'A avaliação volta ao perfil do freelancer e à nota média, e a remoção deixa de contar para a reincidência. O autor recebe a sua nota.'
          : 'A mensagem volta ao chat das duas partes, e a remoção deixa de contar para a reincidência. O autor recebe a sua nota.',
    };
  }
  return {
    title: 'Manter remoção',
    confirm: 'Manter remoção',
    hint: image
      ? 'A imagem continua fora do ar, o arquivo guardado é apagado e a remoção continua contando para a reincidência. O dono recebe a sua nota.'
      : 'O conteúdo continua fora do ar e a remoção continua contando para a reincidência. O autor recebe a sua nota.',
  };
}

function TextThumb({ type }: { type: AdminAppeal['targetType'] }) {
  return (
    <span className="report-thumb icon" aria-hidden="true">
      {type === 'review' ? <StarOff size={18} /> : <MessageSquareOff size={18} />}
    </span>
  );
}

const REMOVED_TEXT = 'Texto apagado com a conta do titular (LGPD).';

/** URL local de um blob, criada e revogada junto com quem usa. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return undefined;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

/**
 * Imagem da contestação: a guardada em quarentena, pedida com o token de admin, ou, depois de
 * revertida, a miniatura pública que voltou ao ar.
 */
function QuarantineImage({ appeal, large = false }: { appeal: AdminAppeal; large?: boolean }) {
  const image = useAppealImage(appeal.id, appeal.hasImage);
  const guarded = useObjectUrl(appeal.hasImage ? image.data : undefined);
  const [broken, setBroken] = useState(false);
  const restored =
    !large && appeal.imageUrl && !appeal.hasImage && appeal.status === 'overturned' && !broken
      ? mediaVariant(appeal.imageUrl, MEDIA_THUMB.small)
      : null;
  const src = guarded ?? restored;
  if (src) {
    return (
      <img
        className={large ? 'appeal-image' : 'report-thumb'}
        src={src}
        alt={large ? `Imagem removida: ${appeal.label}` : ''}
        onError={guarded ? undefined : () => setBroken(true)}
      />
    );
  }
  if (!large) {
    return (
      <span className="report-thumb icon" aria-hidden="true">
        <ImageOff size={18} />
      </span>
    );
  }
  return (
    <div className="appeal-image icon">
      <ImageOff size={28} aria-hidden="true" />
      <span className="tiny">
        {!appeal.hasImage || image.isError
          ? 'O arquivo guardado já foi apagado.'
          : 'Carregando a imagem…'}
      </span>
    </div>
  );
}

/**
 * Contestações de remoção de imagem (ADR 41): o admin vê a imagem guardada, o texto do dono e as
 * remoções dele na janela, e mantém ou reverte com uma nota que vai para o dono.
 */
export function AppealsSection() {
  const [scope, setScope] = useState<'pending' | 'decided'>('pending');
  const appeals = useAdminAppeals(scope);
  const decide = useAdminAppealDecision();
  const toast = useToast();
  const [deciding, setDeciding] = useState<{
    appeal: AdminAppeal;
    decision: AppealDecision;
  } | null>(null);
  const [note, setNote] = useState('');

  function open(appeal: AdminAppeal, decision: AppealDecision): void {
    setNote('');
    setDeciding({ appeal, decision });
  }

  async function confirm(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!deciding) return;
    try {
      const r = await decide.mutateAsync({
        id: deciding.appeal.id,
        decision: deciding.decision,
        note: note.trim() || null,
      });
      toast.success(
        r.status === 'upheld'
          ? r.fileDeleted
            ? 'Remoção mantida. O arquivo guardado foi apagado.'
            : 'Remoção mantida.'
          : r.imageRestored
            ? 'Remoção revertida. A imagem voltou para o perfil.'
            : r.contentRestored
              ? 'Remoção revertida. O conteúdo voltou para onde estava.'
              : 'Remoção revertida. O conteúdo não foi recolocado: já havia outro no lugar ou o arquivo não existe mais.',
      );
      setDeciding(null);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível registrar a decisão');
    }
  }

  return (
    <section className="card wide" aria-labelledby="appeals-title" data-testid="appeals-card">
      <div className="card-head">
        <h3 id="appeals-title">
          <Gavel size={16} /> Contestações
        </h3>
        <div className="tabs tabs-mini" role="tablist" aria-label="Filtro de contestações">
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
            aria-selected={scope === 'decided'}
            className={scope === 'decided' ? 'active' : ''}
            onClick={() => setScope('decided')}
          >
            Decididas
          </button>
        </div>
      </div>
      <p className="muted tiny">
        O autor de um conteúdo removido contesta pelo perfil, uma vez e dentro do prazo. Até a
        decisão, a imagem fica guardada fora do ar; de avaliação e mensagem, o texto removido
        aparece aqui.
      </p>
      <QueryState
        isLoading={appeals.isLoading}
        error={appeals.error}
        data={appeals.data}
        empty={
          scope === 'pending'
            ? 'Nenhuma contestação esperando decisão.'
            : 'Nenhuma contestação decidida ainda.'
        }
        onRetry={() => void appeals.refetch()}
      >
        {(list) => (
          <ul className="removal-list">
            {list.map((a) => (
              <li key={a.id} className="removal appeal" data-testid={`appeal-${a.id}`}>
                {isText(a) ? <TextThumb type={a.targetType} /> : <QuarantineImage appeal={a} />}
                <div className="removal-body">
                  <div className="removal-head">
                    <strong>{a.label}</strong>
                    <span className={`pill status-${TONE[a.status]}`}>
                      {APPEAL_STATUS_LABEL[a.status] ?? a.status}
                    </span>
                  </div>
                  <span className="muted tiny">
                    de {a.owner.name ?? 'conta sem nome'} ·{' '}
                    <Link to={`/freelancers/${a.owner.ulid}`}>ver perfil</Link> ·{' '}
                    {a.ownerStrikes === 1 ? '1 remoção' : `${a.ownerStrikes} remoções`} na janela
                  </span>
                  <span className="muted tiny">
                    Removida em {dtm(a.removedAt)} · {REPORT_REASON_LABEL[a.reason] ?? a.reason}
                  </span>
                  {a.excerpt && (
                    <p className="removal-quote removed">
                      <span>Conteúdo removido</span>
                      {a.excerpt}
                    </p>
                  )}
                  {a.note && (
                    <p className="removal-quote">
                      <span>Nota da remoção</span>
                      {a.note}
                    </p>
                  )}
                  <p className="removal-quote mine">
                    <span>Contestação · {dtm(a.appealedAt)}</span>
                    {a.appealText || REMOVED_TEXT}
                  </p>
                  {a.decidedAt && (
                    <p className="removal-quote">
                      <span>Decisão · {dtm(a.decidedAt)}</span>
                      {a.decisionNote ?? 'Sem nota.'}
                    </p>
                  )}
                </div>
                {a.status === 'appealed' && (
                  <div className="acts appeal-acts">
                    <Button variant="mini" onClick={() => open(a, 'overturn')}>
                      <RotateCcw size={14} /> Reverter
                    </Button>
                    <Button variant="danger" className="mini" onClick={() => open(a, 'uphold')}>
                      <ShieldX size={14} /> Manter
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>

      {deciding && (
        <Modal
          title={copyFor(deciding.decision, deciding.appeal).title}
          onClose={() => setDeciding(null)}
        >
          <form className="stack" onSubmit={confirm}>
            {isText(deciding.appeal) ? (
              <p className="removal-quote removed large">
                <span>Conteúdo removido</span>
                {deciding.appeal.excerpt}
              </p>
            ) : (
              <QuarantineImage appeal={deciding.appeal} large />
            )}
            <div className="appeal-subject">
              <strong>{deciding.appeal.label}</strong>
              <span className="muted tiny">
                de {deciding.appeal.owner.name ?? 'conta sem nome'} · removida em{' '}
                {dtm(deciding.appeal.removedAt)} ·{' '}
                {REPORT_REASON_LABEL[deciding.appeal.reason] ?? deciding.appeal.reason}
              </span>
            </div>
            <p className="removal-quote mine">
              <span>Contestação</span>
              {deciding.appeal.appealText || REMOVED_TEXT}
            </p>
            <p className="muted tiny">{copyFor(deciding.decision, deciding.appeal).hint}</p>
            <Field label="Nota para o dono">
              <textarea
                className="textarea"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="O que pesou na decisão"
              />
            </Field>
            <Button
              type="submit"
              variant={deciding.decision === 'uphold' ? 'danger' : 'primary'}
              disabled={decide.isPending}
            >
              {decide.isPending ? 'Salvando…' : copyFor(deciding.decision, deciding.appeal).confirm}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
