import type {
  CreateSupportTicketRequest,
  SupportCategory,
  SupportPriority,
  SupportStatus,
  SupportTicketDetail,
} from '@escambo/types';
import { LifeBuoy, LockKeyhole, MessageSquare, Plus, Send } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Field, Input, Modal, QueryState, Select } from '../../components/ui';
import { dtm } from '../../lib/format';
import { useSupportActions, useSupportTicket, useSupportTickets } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { SUPPORT_CATEGORY, SUPPORT_PRIORITY, SUPPORT_STATUS, supportError } from './support';

function OpenTicket({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { create } = useSupportActions();
  const [category, setCategory] = useState<SupportCategory>('account');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [contractId, setContractId] = useState('');
  const [error, setError] = useState('');
  const sending = useRef(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (sending.current) return;
    const body: CreateSupportTicketRequest = {
      category,
      subject: subject.trim(),
      description: description.trim(),
      contractId: contractId ? Number(contractId) : null,
    };
    if (body.subject.length < 3 || body.description.length < 10) {
      setError('Informe um assunto com pelo menos 3 caracteres e uma descrição com pelo menos 10.');
      return;
    }
    setError('');
    sending.current = true;
    try {
      const result = await create.mutateAsync(body);
      onCreated(result.id);
      onClose();
    } catch (er) {
      setError(supportError(er));
    } finally {
      sending.current = false;
    }
  }

  return (
    <Modal title="Abrir chamado" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="muted tiny">
          Até 3 chamados não encerrados por conta, incluindo os resolvidos. Sem anexos: descreva o
          problema sem compartilhar senhas ou dados de pagamento.
        </p>
        <Field label="Categoria">
          <Select value={category} onChange={(e) => setCategory(e.target.value as SupportCategory)}>
            {Object.entries(SUPPORT_CATEGORY).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assunto">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            minLength={3}
            maxLength={150}
          />
        </Field>
        <Field
          label={
            category === 'dispute'
              ? 'Número da contratação (obrigatório)'
              : 'Número da contratação (opcional)'
          }
        >
          <Input
            type="number"
            min={1}
            step={1}
            value={contractId}
            onChange={(e) => setContractId(e.target.value)}
            required={category === 'dispute'}
          />
        </Field>
        <p className="notice tiny">
          O suporte não abre disputa financeira nem altera saldo, escrow ou prazos. Disputas
          financeiras são abertas na Sala da contratação, conforme as regras disponíveis para sua
          conta.
        </p>
        <Field label="Descrição">
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            minLength={10}
            maxLength={5000}
            rows={5}
          />
        </Field>
        <span className="muted tiny">{description.length}/5000 caracteres</span>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Abrindo…' : 'Enviar chamado'}
        </Button>
      </form>
    </Modal>
  );
}

function Conversation({ id, admin }: { id: number; admin: boolean }) {
  const detail = useSupportTicket(id, admin);
  const actions = useSupportActions(admin);
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const ticket = detail.data?.pages[0];
  const pending = actions.reply.isPending || actions.close.isPending || actions.update.isPending;
  const messages = [
    ...new Map(
      (detail.data?.pages.flatMap((p) => p.messages) ?? [])
        .filter((m) => admin || !m.internal)
        .map((m) => [m.id, m]),
    ).values(),
  ].sort((a, b) => a.id - b.id);

  async function reply(resolve: boolean): Promise<void> {
    if (
      !message.trim() ||
      pending ||
      sending.current ||
      ticket?.ownerDeleted ||
      (internal && resolve)
    )
      return;
    setError('');
    sending.current = true;
    try {
      await actions.reply.mutateAsync({
        id,
        body: admin ? { message: message.trim(), internal, resolve } : { message: message.trim() },
      });
      setMessage('');
      toast.success(
        internal
          ? 'Nota interna registrada.'
          : resolve
            ? 'Resposta enviada e chamado resolvido.'
            : 'Mensagem enviada.',
      );
    } catch (er) {
      setError(supportError(er));
      void detail.refetch();
    } finally {
      sending.current = false;
    }
  }
  async function update(
    body: Parameters<typeof actions.update.mutateAsync>[0]['body'],
  ): Promise<void> {
    if (pending || sending.current || ticket?.ownerDeleted) return;
    setError('');
    sending.current = true;
    try {
      await actions.update.mutateAsync({ id, body });
      toast.success('Chamado atualizado.');
    } catch (er) {
      setError(supportError(er));
    } finally {
      sending.current = false;
    }
  }
  async function close(): Promise<void> {
    if (pending || sending.current || ticket?.ownerDeleted) return;
    setError('');
    sending.current = true;
    try {
      await actions.close.mutateAsync(id);
      toast.success('Chamado encerrado.');
    } catch (er) {
      setError(supportError(er));
      void detail.refetch();
    } finally {
      sending.current = false;
    }
  }

  function conversation(t: SupportTicketDetail) {
    return (
      <div className="stack">
        <div className="support-ticket-head">
          <div>
            <span className="muted tiny">
              Protocolo #{t.id} · {t.ulid}
            </span>
            <h3>{t.subject}</h3>
          </div>
          <span
            className={`pill status-${t.status === 'closed' || t.status === 'resolved' ? 'completed' : 'pending'}`}
          >
            {admin && t.status === 'waiting_user' ? 'Aguardando titular' : SUPPORT_STATUS[t.status]}
          </span>
        </div>
        <p className="muted tiny">
          {SUPPORT_CATEGORY[t.category]} · aberto em {dtm(t.createdAt)}
          {t.contractId && (
            <>
              {' '}
              · <Link to={`/contratos/${t.contractId}`}>Contratação #{t.contractId}</Link>
            </>
          )}
        </p>
        {admin && (
          <div className="support-controls">
            <Field label="Prioridade">
              <Select
                aria-label="Prioridade"
                value={t.priority}
                disabled={pending || t.ownerDeleted || t.status === 'closed'}
                onChange={(e) => void update({ priority: e.target.value as SupportPriority })}
              >
                {Object.entries(SUPPORT_PRIORITY).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Situação do atendimento">
              <Select
                aria-label="Situação do atendimento"
                value={t.status}
                disabled={
                  pending || t.ownerDeleted || t.status === 'resolved' || t.status === 'closed'
                }
                onChange={(e) =>
                  void update({ status: e.target.value as 'in_progress' | 'waiting_user' })
                }
              >
                {t.status === 'open' && (
                  <option value="open" disabled>
                    Aberto
                  </option>
                )}
                {(t.status === 'resolved' || t.status === 'closed') && (
                  <option value={t.status}>{SUPPORT_STATUS[t.status]}</option>
                )}
                <option value="in_progress">Em atendimento</option>
                <option value="waiting_user">Aguardando titular</option>
              </Select>
            </Field>
            <p className="muted tiny">
              {t.firstResponseAt
                ? `Primeira resposta pública: ${dtm(t.firstResponseAt)}`
                : `Prazo da primeira resposta: ${dtm(t.slaDueAt)}`}
            </p>
          </div>
        )}
        {detail.hasNextPage && (
          <Button
            variant="secondary"
            disabled={detail.isFetchingNextPage}
            onClick={() => void detail.fetchNextPage()}
          >
            {detail.isFetchingNextPage ? 'Carregando anteriores…' : 'Carregar mensagens anteriores'}
          </Button>
        )}
        {detail.isFetchNextPageError && (
          <p role="alert" className="error">
            Não foi possível carregar as mensagens anteriores. Tente novamente.
          </p>
        )}
        <ol
          className="support-messages"
          aria-label={admin ? 'Conversa e notas internas' : 'Conversa do chamado'}
        >
          {messages.map((m) => (
            <li
              key={m.id}
              className={`support-message ${m.internal ? 'support-internal' : m.from === 'support' ? 'support-answer' : ''}`}
            >
              <div className="review-head">
                <strong>
                  {m.internal ? (
                    <>
                      <LockKeyhole size={14} aria-hidden="true" /> Nota interna · somente equipe
                    </>
                  ) : m.from === 'support' ? (
                    'Atendimento'
                  ) : (
                    'Titular'
                  )}
                </strong>
                <span className="muted tiny">{dtm(m.createdAt)}</span>
              </div>
              <p>{m.message}</p>
            </li>
          ))}
        </ol>
        {t.ownerDeleted ? (
          <p className="notice">
            Conta do titular removida: histórico preservado para consulta. O atendimento não aceita
            novas mensagens ou alterações.
          </p>
        ) : t.status === 'closed' ? (
          <p className="notice">
            Chamado encerrado{t.closedAt ? ` em ${dtm(t.closedAt)}` : ''}. Para outro atendimento,
            abra um novo chamado.
          </p>
        ) : (
          <>
            {t.status === 'resolved' && (
              <p className="notice">
                Resolvido{t.resolvedAt ? ` em ${dtm(t.resolvedAt)}` : ''}. O titular pode responder
                para retomar o atendimento em até 5 dias após a resolução; depois o chamado é
                encerrado automaticamente.
              </p>
            )}
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void reply(false);
              }}
            >
              {admin && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={internal}
                    disabled={pending}
                    onChange={(e) => setInternal(e.target.checked)}
                  />{' '}
                  Nota interna (o titular não recebe nem visualiza)
                </label>
              )}
              <Field label={internal ? 'Texto da nota interna' : 'Sua mensagem'}>
                <textarea
                  className="textarea"
                  rows={4}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                  maxLength={5000}
                  disabled={pending}
                />
              </Field>
              <span className="muted tiny">{message.length}/5000 caracteres · sem anexos</span>
              <div className="acts">
                <Button type="submit" disabled={pending || !message.trim()}>
                  <Send size={15} />{' '}
                  {actions.reply.isPending
                    ? 'Enviando…'
                    : internal
                      ? 'Registrar nota interna'
                      : 'Enviar mensagem'}
                </Button>
                {admin && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={pending || internal || !message.trim()}
                    onClick={() => void reply(true)}
                  >
                    Responder e resolver
                  </Button>
                )}
              </div>
            </form>
            {!admin && (
              <div className="support-close">
                <p className="muted tiny">
                  Já está tudo certo? Encerrar finaliza este chamado e libera uma vaga para outro.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => void close()}
                >
                  {actions.close.isPending ? 'Encerrando…' : 'Encerrar chamado'}
                </Button>
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    );
  }
  return (
    <section className="card support-conversation" aria-label="Detalhes do chamado">
      <QueryState
        isLoading={detail.isLoading}
        error={detail.error && !detail.data ? detail.error : null}
        data={ticket}
        onRetry={() => void detail.refetch()}
      >
        {conversation}
      </QueryState>
      {detail.error && detail.data && !detail.isFetchNextPageError && (
        <p role="alert" className="error">
          A conversa não foi atualizada.{' '}
          <button type="button" className="link" onClick={() => void detail.refetch()}>
            Tentar novamente
          </button>
        </p>
      )}
    </section>
  );
}

/** Atendimento permanece disponível durante a suspensão; usa formulários comuns. */
export function SupportDesk({ admin = false }: { admin?: boolean }) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const selected = Number(search.get('ticket'));
  const id = Number.isSafeInteger(selected) && selected > 0 ? selected : null;
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<SupportStatus | ''>('');
  const [opening, setOpening] = useState(false);
  const list = useSupportTickets({ page, limit: 20, ...(status ? { status } : {}) }, admin);
  const select = (ticketId: number): void => {
    void navigate(`${admin ? '/admin' : '/suporte'}?ticket=${ticketId}${admin ? '#suporte' : ''}`);
  };
  return (
    <div className="stack">
      {!admin && (
        <div className="support-intro">
          <span className="support-intro-ico" aria-hidden="true">
            <LifeBuoy size={22} />
          </span>
          <div className="support-intro-text">
            <h2>Como podemos ajudar?</h2>
            <p>
              Converse com a equipe em um chamado privado, inclusive se sua conta estiver suspensa.
              Até 3 chamados não encerrados por vez.
            </p>
          </div>
          <Button onClick={() => setOpening(true)}>
            <Plus size={16} /> Abrir chamado
          </Button>
        </div>
      )}
      <div className="support-layout">
        <section
          className="card support-list"
          aria-label={admin ? 'Fila de suporte' : 'Meus chamados'}
        >
          <div className="card-head">
            <h3>
              <LifeBuoy size={16} /> {admin ? 'Fila de suporte' : 'Meus chamados'}
            </h3>
          </div>
          <Field label="Filtrar por situação">
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as SupportStatus | '');
                setPage(1);
              }}
            >
              <option value="">Todas</option>
              {Object.entries(SUPPORT_STATUS).map(([value, label]) => (
                <option key={value} value={value}>
                  {admin && value === 'waiting_user' ? 'Aguardando titular' : label}
                </option>
              ))}
            </Select>
          </Field>
          <QueryState
            isLoading={list.isLoading}
            error={list.error}
            data={list.data}
            isEmpty={(d) => d.items.length === 0}
            empty="Nenhum chamado nesta página."
            onRetry={() => void list.refetch()}
          >
            {(d) => (
              <ul className="support-ticket-list">
                {d.items.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={`support-ticket ${id === t.id ? 'selected' : ''}`}
                      aria-pressed={id === t.id}
                      onClick={() => select(t.id)}
                    >
                      <span className="muted tiny">
                        Protocolo #{t.id}
                        {admin ? ` · ${SUPPORT_PRIORITY[t.priority]}` : ''}
                      </span>
                      <strong>{t.subject}</strong>
                      <span className="muted tiny">
                        {admin && t.status === 'waiting_user'
                          ? 'Aguardando titular'
                          : SUPPORT_STATUS[t.status]}{' '}
                        · {dtm(t.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
          <div className="support-pagination">
            <Button
              variant="mini"
              disabled={page === 1 || list.isFetching}
              onClick={() => setPage((p) => p - 1)}
            >
              Anterior
            </Button>
            <span className="muted tiny">Página {page}</span>
            <Button
              variant="mini"
              disabled={list.isFetching || !list.data || list.data.items.length < 20}
              onClick={() => setPage((p) => p + 1)}
            >
              Próxima
            </Button>
          </div>
        </section>
        {id ? (
          <Conversation key={`${admin}:${id}`} id={id} admin={admin} />
        ) : (
          <section className="card empty">
            <MessageSquare size={26} />
            <p className="muted">Selecione um chamado para ver a conversa.</p>
          </section>
        )}
      </div>
      {opening && <OpenTicket onClose={() => setOpening(false)} onCreated={select} />}
    </div>
  );
}
