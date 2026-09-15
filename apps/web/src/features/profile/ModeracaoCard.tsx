import { Gavel, ImageOff, MessageSquareOff, ShieldAlert, ShieldCheck, StarOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ContentRemoval, StrikeSummary } from '@escambo/types';
import { Button, Field, Modal } from '../../components/ui';
import { dtm, REMOVAL_STATUS_LABEL, REPORT_REASON_LABEL } from '../../lib/format';
import { useAppealRemoval, useMyModeration } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/** Mesmos limites da API (appeals.controller). */
const APPEAL_MIN = 20;
const APPEAL_MAX = 1000;

const TONE: Record<ContentRemoval['status'], string> = {
  removed: 'cancelled',
  appealed: 'pending',
  upheld: 'cancelled',
  overturned: 'completed',
};

const reasonOf = (r: ContentRemoval): string => REPORT_REASON_LABEL[r.reason] ?? r.reason;

/** Ícone do que foi removido: imagem, avaliação ou mensagem (ADR 44). */
function RemovalIcon({ type }: { type: ContentRemoval['targetType'] }) {
  if (type === 'review') return <StarOff size={18} />;
  if (type === 'message') return <MessageSquareOff size={18} />;
  return <ImageOff size={18} />;
}

/** Reincidência: um segmento por remoção até o limite que leva a conta para revisão. */
function StrikePanel({ strikes }: { strikes: StrikeSummary }) {
  const {
    strikes: count,
    imageStrikes,
    reviewThreshold,
    windowDays,
    uploadsBlockedUntil,
  } = strikes;
  const tone = uploadsBlockedUntil ? 'blocked' : count === 0 ? 'clear' : '';
  return (
    <div className={`strike-panel ${tone}`} data-testid="strike-panel">
      {count === 0 ? (
        <ShieldCheck size={18} aria-hidden="true" />
      ) : (
        <div
          className={`strike-meter${count >= reviewThreshold ? ' full' : ''}`}
          role="img"
          aria-label={`${count} de ${reviewThreshold} remoções`}
        >
          {Array.from({ length: Math.max(reviewThreshold, count) }, (_, i) => (
            <span key={i} className={i < count ? 'on' : ''} />
          ))}
        </div>
      )}
      <p>
        {uploadsBlockedUntil ? (
          <>
            <strong>Envio de imagens bloqueado até {dtm(uploadsBlockedUntil)}.</strong> Com{' '}
            {imageStrikes} imagens removidas nos últimos {windowDays} dias, novos envios de imagem
            ficam parados por um tempo que cresce a cada nova imagem removida.
          </>
        ) : count === 0 ? (
          'Nenhuma remoção conta contra você agora: remoções revertidas ou antigas não contam.'
        ) : (
          `${count === 1 ? 'Uma remoção conta' : `${count} remoções contam`} nos últimos ${windowDays} dias. A partir da segunda imagem removida, o envio de imagens fica bloqueado por um tempo; com ${reviewThreshold} remoções de qualquer conteúdo, a conta passa por revisão.`
        )}
      </p>
    </div>
  );
}

/** Situação da remoção, na linha de baixo do item. */
function RemovalFoot({ removal, onAppeal }: { removal: ContentRemoval; onAppeal: () => void }) {
  if (removal.canAppeal) {
    return (
      <div className="removal-foot">
        <span className="muted tiny">Você pode contestar até {dtm(removal.appealDeadline)}.</span>
        <Button variant="mini" onClick={onAppeal}>
          <Gavel size={14} /> Contestar
        </Button>
      </div>
    );
  }
  const text =
    removal.status === 'appealed'
      ? `Contestação enviada em ${dtm(removal.appealedAt!)}. A resposta chega por notificação e e-mail.`
      : removal.status === 'overturned'
        ? `Revertida em ${dtm(removal.decidedAt!)}: não conta como remoção.`
        : removal.status === 'upheld'
          ? `Mantida em ${dtm(removal.decidedAt!)}.`
          : `O prazo para contestar terminou em ${dtm(removal.appealDeadline)}.`;
  return <span className="muted tiny">{text}</span>;
}

/**
 * Imagens removidas pela moderação (ADR 41): motivo, nota, prazo e contestação, com a decisão, e a
 * reincidência que bloqueia o envio. Quem nunca teve imagem removida não vê o cartão.
 */
export function ModeracaoCard() {
  const moderation = useMyModeration();
  const appeal = useAppealRemoval();
  const toast = useToast();
  const [appealing, setAppealing] = useState<ContentRemoval | null>(null);
  const [text, setText] = useState('');

  const data = moderation.data;
  if (!data || data.removals.length === 0) return null;
  const length = text.trim().length;

  function open(removal: ContentRemoval): void {
    setText('');
    setAppealing(removal);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!appealing || length < APPEAL_MIN) return;
    try {
      await appeal.mutateAsync({ id: appealing.id, text: text.trim() });
      toast.success('Contestação enviada. A resposta chega por notificação e e-mail.');
      setAppealing(null);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível enviar a contestação');
    }
  }

  return (
    <section className="card wide" aria-labelledby="moderation-title" data-testid="moderation-card">
      <div className="card-head">
        <h3 id="moderation-title">
          <ShieldAlert size={16} /> Moderação
        </h3>
        <span className="muted tiny">
          {data.removals.length === 1 ? '1 remoção' : `${data.removals.length} remoções`}
        </span>
      </div>
      <StrikePanel strikes={data.strikes} />

      <ul className="removal-list">
        {data.removals.map((r) => (
          <li key={r.id} className="removal" data-testid={`removal-${r.id}`}>
            <span
              className={`removal-ico${r.status === 'overturned' ? ' restored' : ''}`}
              aria-hidden="true"
            >
              {r.status === 'overturned' ? (
                <ShieldCheck size={18} />
              ) : (
                <RemovalIcon type={r.targetType} />
              )}
            </span>
            <div className="removal-body">
              <div className="removal-head">
                <strong>{r.label}</strong>
                <span className={`pill status-${TONE[r.status]}`}>
                  {REMOVAL_STATUS_LABEL[r.status] ?? r.status}
                </span>
              </div>
              <span className="muted tiny">
                Removida em {dtm(r.removedAt)} · {reasonOf(r)}
              </span>
              {r.excerpt && (
                <p className="removal-quote removed">
                  <span>Conteúdo removido</span>
                  {r.excerpt}
                </p>
              )}
              {r.note && (
                <p className="removal-quote">
                  <span>Nota da moderação</span>
                  {r.note}
                </p>
              )}
              {r.appealText && (
                <p className="removal-quote mine">
                  <span>Sua contestação</span>
                  {r.appealText}
                </p>
              )}
              {r.decisionNote && (
                <p className="removal-quote">
                  <span>Decisão</span>
                  {r.decisionNote}
                </p>
              )}
              <RemovalFoot removal={r} onAppeal={() => open(r)} />
            </div>
          </li>
        ))}
      </ul>

      {appealing && (
        <Modal title="Contestar remoção" onClose={() => setAppealing(null)}>
          <form className="stack" onSubmit={submit}>
            <div className="report-subject">
              <span className="report-thumb icon" aria-hidden="true">
                <RemovalIcon type={appealing.targetType} />
              </span>
              <div className="cell-title">
                <strong>{appealing.label}</strong>
                <span className="muted tiny">
                  {reasonOf(appealing)} · contestação até {dtm(appealing.appealDeadline)}
                </span>
              </div>
            </div>
            {appealing.excerpt && (
              <p className="removal-quote removed">
                <span>Conteúdo removido</span>
                {appealing.excerpt}
              </p>
            )}
            <p className="muted tiny">
              Conte por que {appealing.excerpt ? 'o conteúdo' : 'a imagem'} não viola as regras: o
              contexto, de quem é e o que mostra. A contestação é analisada uma vez. Se for aceita,
              o conteúdo volta para onde estava e a remoção deixa de contar.
            </p>
            <Field label="Por que a remoção deve ser revertida">
              <textarea
                className="textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={APPEAL_MAX}
                rows={5}
                placeholder="Ex.: a foto é minha, tirada no meu ateliê, e mostra só o trabalho entregue."
              />
            </Field>
            <span className="muted tiny appeal-count" aria-live="polite">
              {length < APPEAL_MIN
                ? `Escreva mais ${APPEAL_MIN - length} caractere${APPEAL_MIN - length > 1 ? 's' : ''}`
                : `${length}/${APPEAL_MAX}`}
            </span>
            <Button type="submit" disabled={appeal.isPending || length < APPEAL_MIN}>
              {appeal.isPending ? 'Enviando…' : 'Enviar contestação'}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
