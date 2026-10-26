import { ShieldCheck, UserMinus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdminDropout } from '@escambo/types';
import { Button, Field, Modal, QueryState } from '../../components/ui';
import { dtm } from '../../lib/format';
import { useAdminDropoutDecision, useAdminDropouts, useAdminUserDropouts } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { dropoutCounts, validDropoutDecision } from '../profile/dropouts';

function DropoutsList({ items, appeals = false }: { items: AdminDropout[]; appeals?: boolean }) {
  const decide = useAdminDropoutDecision();
  const toast = useToast();
  const [selected, setSelected] = useState<{
    item: AdminDropout;
    decision: 'excuse' | 'uphold';
  } | null>(null);
  const [note, setNote] = useState('');
  function open(item: AdminDropout, decision: 'excuse' | 'uphold'): void {
    setNote('');
    setSelected({ item, decision });
  }
  async function confirm(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!selected || !validDropoutDecision(note)) return;
    try {
      await decide.mutateAsync({
        id: selected.item.id,
        decision: selected.decision,
        note: note.trim(),
      });
      toast.success(
        selected.decision === 'excuse' ? 'A desistência não conta mais.' : 'Desistência mantida.',
      );
      setSelected(null);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível registrar a decisão');
    }
  }
  return (
    <>
      <ul className="removal-list">
        {items.map((d) => (
          <li className="removal" key={d.id} data-testid={`admin-dropout-${d.id}`}>
            <div className="removal-body">
              <strong className="removal-title">
                Desistência · {d.freelancer.name ?? 'conta sem nome'} · contratação #{d.contractId}{' '}
                · «{d.contractTitle}» em {dtm(d.droppedAt)}
              </strong>
              <p className="muted tiny">
                {d.clientAgreed
                  ? 'O cliente confirmou que foi combinada.'
                  : 'Sem confirmação do cliente.'}{' '}
                Desistências que contam agora: {d.ownerCount}.
              </p>
              {d.status === 'excused' ? (
                <p>A equipe decidiu não contar: {d.decisionNote}</p>
              ) : d.status === 'agreed' ? (
                <p>Combinada: não conta.</p>
              ) : d.countsUntil && dropoutCounts(d, Date.now()) ? (
                <p>Conta até {dtm(d.countsUntil)}.</p>
              ) : (
                <p>Não aparece mais no perfil público.</p>
              )}
              {d.appealText && (
                <p className="removal-quote mine">
                  <span>Contestação{d.appealedAt ? ` · ${dtm(d.appealedAt)}` : ''}</span>
                  {d.appealText}
                </p>
              )}
              {d.decision === 'upheld' && <p>Decisão anterior: {d.decisionNote}</p>}
            </div>
            {!d.decision && (appeals || dropoutCounts(d, Date.now())) && (
              <div className="acts">
                <Button variant="mini" className="q-primary" onClick={() => open(d, 'excuse')}>
                  Não contar
                </Button>
                {appeals && d.appealedAt && (
                  <Button variant="danger" className="mini" onClick={() => open(d, 'uphold')}>
                    Manter
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {selected && (
        <Modal
          title={selected.decision === 'excuse' ? 'Não contar desistência' : 'Manter desistência'}
          onClose={() => setSelected(null)}
        >
          <form className="stack" onSubmit={(e) => void confirm(e)}>
            <strong>«{selected.item.contractTitle}»</strong>
            <p>
              A decisão é registrada pela equipe. O freelancer recebe esta nota; ela não vai para a
              linha do tempo que o cliente vê.
            </p>
            <Field label="Por que? O freelancer recebe esta nota.">
              <textarea
                className="textarea"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                minLength={10}
                maxLength={500}
                required
                rows={4}
              />
            </Field>
            <span className="muted tiny">De 10 a 500 caracteres.</span>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setSelected(null)}>
                Voltar
              </Button>
              <Button type="submit" disabled={decide.isPending || !validDropoutDecision(note)}>
                {decide.isPending
                  ? 'Salvando…'
                  : selected.decision === 'excuse'
                    ? 'Não contar'
                    : 'Manter'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function DropoutAppeals() {
  const query = useAdminDropouts();
  return (
    <section className="stack dropout-appeals" data-testid="dropout-appeals">
      <div className="sub-head">
        <span className="adm-ico amber" aria-hidden="true">
          <UserMinus size={18} />
        </span>
        <div>
          <h4>Desistências contestadas</h4>
          <p className="muted tiny">
            As mais antigas aparecem primeiro. Uma pessoa da equipe decide cada contestação.
          </p>
        </div>
      </div>
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        isEmpty={(items) => items.length === 0}
        emptyIcon={ShieldCheck}
        empty="Nenhuma desistência contestada esperando decisão."
        onRetry={() => void query.refetch()}
      >
        {(items) => <DropoutsList items={items} appeals />}
      </QueryState>
    </section>
  );
}

export function UserDropoutsReview({ ulid }: { ulid: string }) {
  const query = useAdminUserDropouts(ulid);
  return (
    <section className="stack" data-testid="user-dropouts-review">
      <h4>Desistências desta conta</h4>
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        isEmpty={(items) => items.length === 0}
        empty="Nenhuma desistência registrada."
        onRetry={() => void query.refetch()}
      >
        {(items) => <DropoutsList items={items} />}
      </QueryState>
    </section>
  );
}
