import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MyDropout } from '@escambo/types';
import { Button, Field, Modal, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { momentText } from '../../lib/deadline';
import { useAppealDropout, useMyDropouts } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { canAppealDropout, dropoutCounts, validDropoutAppeal } from './dropouts';

export function DesistenciasCard() {
  const { user } = useAuth();
  const query = useMyDropouts();
  const appeal = useAppealDropout();
  const toast = useToast();
  const [selected, setSelected] = useState<MyDropout | null>(null);
  const [text, setText] = useState('');
  const [now, setNow] = useState(Date.now);
  const nextExpiry = Math.min(
    ...(query.data?.items ?? [])
      .filter((d) => d.status === 'counting')
      .map((d) => Date.parse(d.countsUntil ?? ''))
      .filter((at) => at > Date.now()),
  );
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return undefined;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        void query.refetch();
      },
      // A API guarda segundos; recarrega depois de atravessar o instante inteiro da janela.
      Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now() + 1001)),
    );
    return () => clearTimeout(timer);
  }, [nextExpiry, query.refetch, now]);
  const current = Math.max(now, Date.now());
  const when = (at: string): string => momentText(at, user?.timezone);
  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!selected || !canAppealDropout(selected, Date.now()) || !validDropoutAppeal(text)) return;
    try {
      await appeal.mutateAsync({ id: selected.id, text: text.trim() });
      toast.success('Contestação enviada.');
      setSelected(null);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível contestar');
    }
  }
  return (
    <section className="card wide" id="desistencias" data-testid="desistencias-card">
      <h3>Desistências</h3>
      <p className="muted tiny">
        Uma desistência depois do aceite conta no seu perfil público por 60 dias, só como número.
        Com 3 em 60 dias, o perfil mostra um alerta e a equipe do Escambo revisa a conta.
      </p>
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={() => void query.refetch()}
      >
        {(data) => (
          <div className="stack">
            <p>
              No perfil agora: {data.count} nos últimos 60 dias (em {data.acceptedInWindow}{' '}
              contratações aceitas no período).
            </p>
            {data.alert && data.alertUntil && (
              <p className="notice">
                Alerta no perfil até {when(data.alertUntil)}, se não houver outra.
              </p>
            )}
            {!data.items.length ? (
              <p className="muted">Nenhuma desistência registrada.</p>
            ) : (
              <ul className="removal-list">
                {data.items.map((d) => (
                  <li key={d.id} className="removal" data-testid={`dropout-${d.id}`}>
                    <div className="removal-body">
                      <strong>
                        {when(d.droppedAt)} · «{d.contractTitle}»
                      </strong>
                      <Link className="tiny" to={`/contratos/${d.contractId}`}>
                        Ver contratação
                      </Link>
                      <p>
                        {d.status === 'agreed'
                          ? 'Combinada pelo cliente: não conta.'
                          : d.status === 'excused'
                            ? `A equipe decidiu não contar: ${d.decisionNote ?? 'decisão registrada.'}`
                            : !dropoutCounts(d, current)
                              ? 'Não aparece mais no perfil público.'
                              : d.decision === 'upheld'
                                ? `Mantida pela equipe: ${d.decisionNote ?? 'decisão registrada.'} Conta até ${when(d.countsUntil!)}.`
                                : `Conta até ${when(d.countsUntil!)}.`}
                      </p>
                      {d.appealedAt && !d.decision && (
                        <p className="notice tiny">
                          Contestada em {when(d.appealedAt)}: esperando a equipe. Enquanto conta na
                          janela de 60 dias, ela continua no perfil.
                        </p>
                      )}
                    </div>
                    {canAppealDropout(d, current) && (
                      <Button
                        variant="mini"
                        onClick={() => {
                          setText('');
                          setSelected(d);
                        }}
                      >
                        Contestar
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </QueryState>
      {selected && (
        <Modal title="Contestar desistência" onClose={() => setSelected(null)}>
          <form className="stack" onSubmit={(e) => void send(e)}>
            <strong>«{selected.contractTitle}»</strong>
            <p>
              Explique por que esta desistência não deveria contar (por exemplo, o cliente pediu
              para encerrar ou não mandou o material). Uma pessoa da equipe do Escambo decide e você
              é avisado. Enquanto isso, ela continua contando. Cada desistência pode ser contestada
              uma vez.
            </p>
            <Field label="Por que esta desistência não deveria contar">
              <textarea
                className="textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                minLength={20}
                maxLength={1000}
                required
                rows={5}
              />
            </Field>
            <span className="muted tiny">
              De 20 a 1000 caracteres. Só a equipe lê sua contestação.
            </span>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setSelected(null)}>
                Voltar
              </Button>
              <Button
                type="submit"
                disabled={
                  appeal.isPending ||
                  !validDropoutAppeal(text) ||
                  !canAppealDropout(selected, current)
                }
              >
                {appeal.isPending ? 'Enviando…' : 'Enviar contestação'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
