import {
  ArrowLeft,
  Hourglass,
  ListChecks,
  MessageSquare,
  Paperclip,
  Send,
  Star,
  TriangleAlert,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import type { ChatMessage, ChatMessageEvent, ContractWithHistory } from '@escambo/types';
import { StarInput, Stars } from '../../components/Stars';
import { Button, Input, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { brl, dt, dtm, hm, STATUS_LABEL } from '../../lib/format';
import {
  useChatHistory,
  useContractDetail,
  useCreateReview,
  useRespondReview,
  useSendAttachment,
  useSendMessage,
} from '../../lib/hooks';
import { getSocket } from '../../lib/socket';
import {
  ATTACHMENT_ACCEPT,
  FileAttachment,
  ImageAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  PendingAttachment,
} from '../contracts/ChatAttachment';
import { ContractActions } from '../contracts/ContractActions';
import { DeadlineSection } from '../contracts/DeadlineSection';
import { DisputeModal, DisputeSection } from '../contracts/DisputePanel';
import { MilestonesSection } from '../contracts/MilestonesSection';
import { describeSignals, offPlatformSignals } from '../../lib/offPlatform';
import { useToast } from '../../lib/toast';

/** Prazo da plataforma para aprovação tácita (platform_settings.tacit_approval_days). */
const TACIT_APPROVAL_DAYS = 5;

const MODE_LABEL: Record<string, string> = {
  cash: 'Dinheiro',
  credits: 'Créditos Escambo',
  barter: 'Troca',
};

/** Onde o dinheiro (ou os créditos) está neste momento do contrato. */
function paymentState(c: { paymentMode: string; status: string; hasMilestones: boolean }): string {
  if (c.paymentMode === 'barter') return 'Troca de serviços · sem escrow';
  const unit = c.paymentMode === 'credits' ? 'Créditos' : 'Valor';
  if (c.hasMilestones && (c.status === 'accepted' || c.status === 'in_progress')) {
    return c.paymentMode === 'credits'
      ? 'Créditos em escrow · liberados marco a marco'
      : 'Em escrow · liberado marco a marco';
  }
  switch (c.status) {
    case 'pending':
      return c.paymentMode === 'credits'
        ? 'Créditos retidos no aceite'
        : 'Reservado na carteira do cliente';
    case 'accepted':
    case 'in_progress':
    case 'delivered':
    case 'revision_requested':
      return `${unit} em escrow · liberado na aprovação`;
    case 'completed':
      return `${unit} liberado ao freelancer`;
    case 'rejected':
      return `${unit} devolvido ao cliente`;
    case 'cancelled':
      return `${unit} liquidado pela política de reembolso`;
    case 'disputed':
      return 'Congelado até a decisão da mediação';
    default:
      return c.status;
  }
}

/**
 * Avaliação da contratação (só depois de concluída): o cliente dá a nota (1–5) e um
 * comentário; o freelancer pode responder uma vez. A nota alimenta o Escambo Score.
 */
function ReviewSection({ contract, myId }: { contract: ContractWithHistory; myId: number }) {
  const toast = useToast();
  const create = useCreateReview();
  const respond = useRespondReview();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [reply, setReply] = useState('');

  if (contract.status !== 'completed') return null;
  const review = contract.review;
  const isClient = contract.clientId === myId;
  const isFreelancer = contract.freelancerId === myId;

  async function submitReview(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!rating) {
      toast.error('Escolha uma nota de 1 a 5');
      return;
    }
    try {
      await create.mutateAsync({
        contractId: contract.id,
        rating,
        comment: comment.trim() || null,
      });
      toast.success('Avaliação enviada. Obrigado!');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao avaliar');
    }
  }

  async function submitReply(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!review || !reply.trim()) return;
    try {
      await respond.mutateAsync({ id: review.id, response: reply.trim() });
      toast.success('Resposta publicada');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao responder');
    }
  }

  return (
    <section className="card" aria-labelledby="review-title">
      <div className="card-head">
        <h3 id="review-title">
          <Star size={16} /> Avaliação
        </h3>
        {review && !review.removedAt && <Stars value={review.rating} showValue={false} size={16} />}
      </div>

      {review?.removedAt ? (
        <p className="muted" data-testid="review-removed">
          Esta avaliação foi removida pela moderação e não aparece no perfil do freelancer.
        </p>
      ) : review ? (
        <div className="review">
          <p>{review.comment ?? <span className="muted">Sem comentário.</span>}</p>
          <span className="muted tiny">avaliado em {dtm(review.createdAt)}</span>
          {review.response ? (
            <div className="review-response">
              <strong>Resposta do freelancer</strong>
              <p>{review.response}</p>
            </div>
          ) : isFreelancer ? (
            <form className="stack" onSubmit={submitReply}>
              <textarea
                className="textarea"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Responda à avaliação (pública, uma única vez)"
                aria-label="Resposta à avaliação"
                maxLength={1000}
                rows={2}
                required
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={respond.isPending || !reply.trim()}
              >
                {respond.isPending ? 'Publicando…' : 'Responder'}
              </Button>
            </form>
          ) : null}
        </div>
      ) : isClient ? (
        <form className="stack" onSubmit={submitReview}>
          <p className="muted tiny">
            Como foi trabalhar com este freelancer? Sua nota alimenta o Escambo Score dele. Você tem
            7 dias após a conclusão para avaliar.
          </p>
          <StarInput value={rating} onChange={setRating} />
          <textarea
            className="textarea"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Conte como foi (opcional)"
            aria-label="Comentário da avaliação"
            maxLength={1000}
            rows={3}
          />
          <Button type="submit" disabled={create.isPending || rating === 0}>
            {create.isPending ? 'Enviando…' : 'Enviar avaliação'}
          </Button>
        </form>
      ) : (
        <p className="muted">Aguardando a avaliação do cliente.</p>
      )}
    </section>
  );
}

export function SalaContratoView({
  contractId,
  onBack,
}: {
  contractId: number;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const toast = useToast();
  const contract = useContractDetail(contractId);
  usePageTitle(contract.data ? contract.data.title : 'Contratação');
  const history = useChatHistory(contractId);
  const send = useSendMessage(contractId);
  const sendFile = useSendAttachment(contractId);

  const [live, setLive] = useState<ChatMessage[]>([]); // mensagens que chegaram pelo socket
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [pending, setPending] = useState<File | null>(null); // anexo escolhido, ainda não enviado
  const [dragging, setDragging] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Conecta o socket, entra na sala e ouve mensagens novas em tempo real.
  useEffect(() => {
    const socket = getSocket();
    const append = (m: ChatMessageEvent | ChatMessage): void => {
      if ('contractId' in m && m.contractId !== contractId) return;
      setLive((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    };
    const onConnect = (): void => {
      setConnected(true);
      socket.emit('contract:join', contractId);
    };
    const onDisconnect = (): void => setConnected(false);
    if (socket.connected) onConnect();
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    // Removida ou devolvida pela moderação (ADR 44): a bolha troca no lugar.
    const replace = (m: ChatMessageEvent): void => {
      if (m.contractId !== contractId) return;
      setLive((prev) => [...prev.filter((x) => x.id !== m.id), m]);
    };
    socket.on('message:new', append);
    socket.on('message:updated', replace);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('message:new', append);
      socket.off('message:updated', replace);
    };
  }, [contractId]);

  // Histórico (cache) + mensagens ao vivo, sem duplicar, em ordem.
  const messages = useMemo(() => {
    const byId = new Map<number, ChatMessage>();
    for (const m of history.data?.messages ?? []) byId.set(m.id, m);
    for (const m of live) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }, [history.data, live]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  /** Escolhe um arquivo (clipe, colar ou arrastar); a API confere o tipo pelo conteúdo. */
  function pick(file: File | undefined | null): void {
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(`Arquivo maior que ${MAX_ATTACHMENT_MB} MB`);
      return;
    }
    setPending(file);
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>): void {
    const file = e.clipboardData.files[0];
    if (file) {
      e.preventDefault();
      pick(file);
    }
  }

  function onDrop(e: DragEvent<HTMLElement>): void {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  }

  const sending = send.isPending || sendFile.isPending;
  // Aviso ao digitar (ADR 45): o mesmo detector da API, só para avisar antes de enviar.
  const hints = useMemo(() => offPlatformSignals(draft), [draft]);
  const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const content = draft.trim();
    if (!content && !pending) return;
    try {
      const msg = pending
        ? await sendFile.mutateAsync({ file: pending, content: content || undefined })
        : await send.mutateAsync(content);
      setLive((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev, msg]));
      setDraft('');
      setPending(null);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao enviar');
    }
  }

  const c = contract.data;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Button variant="ghost" className="mini" onClick={onBack}>
            <ArrowLeft size={14} /> Voltar
          </Button>
          <h1 style={{ marginTop: 8 }}>{c?.title ?? `Contrato #${contractId}`}</h1>
          {c && (
            <p className="muted">
              {MODE_LABEL[c.paymentMode] ?? c.paymentMode} · criado em {dtm(c.createdAt)}
            </p>
          )}
        </div>
        {c && (
          <div className="sala-head-right">
            <span className={`pill status-${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
            <ContractActions
              contract={c}
              exclude={['review']}
              onDispute={() => setDisputeOpen(true)}
            />
          </div>
        )}
      </div>

      {c?.status === 'delivered' && c.clientId === myId && (
        <p className="notice">
          <Hourglass size={14} /> Entrega registrada. Aprove ou peça revisão; sem resposta em{' '}
          {TACIT_APPROVAL_DAYS} dias a entrega é aprovada automaticamente e o valor liberado.
        </p>
      )}

      <div className="sala">
        <div className="stack">
          <section className="card">
            <h3>
              <ListChecks size={16} /> Linha do tempo
            </h3>
            <QueryState
              isLoading={contract.isLoading}
              error={contract.error}
              data={contract.data}
              onRetry={() => void contract.refetch()}
            >
              {(d) => (
                <>
                  <div className="kv">
                    <span className="muted">Valor</span>
                    <strong>
                      {d.paymentMode === 'credits'
                        ? `${Math.round(d.price)} créditos`
                        : brl(d.price)}
                    </strong>
                    <span className="muted">Taxa</span>
                    <span>{d.paymentMode === 'credits' ? 'sem taxa' : brl(d.platformFee)}</span>
                    <span className="muted">Líquido</span>
                    <strong className="price">
                      {d.paymentMode === 'credits'
                        ? `${Math.round(d.freelancerNet)} créditos`
                        : brl(d.freelancerNet)}
                    </strong>
                    <span className="muted">Pagamento</span>
                    <span data-testid="payment-state">{paymentState(d)}</span>
                    <span className="muted">Prazo</span>
                    <span data-testid="deadline-kv">
                      {d.deadlineAt ? dt(d.deadlineAt) : 'sem prazo definido'}
                    </span>
                  </div>
                  <ol className="timeline">
                    {d.history.map((h, i) => (
                      <li key={i}>
                        <span className="dot" />
                        <div>
                          <strong>{STATUS_LABEL[h.status] ?? h.status}</strong>
                          {h.previousStatus && h.previousStatus !== h.status && (
                            <span className="muted tiny">
                              {' '}
                              · de {STATUS_LABEL[h.previousStatus] ?? h.previousStatus}
                            </span>
                          )}
                          {h.note && <div className="muted tiny">{h.note}</div>}
                          <div className="muted tiny">{dtm(h.at)}</div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </QueryState>
          </section>

          {c && <DeadlineSection contract={c} myId={myId} />}
          {c && <MilestonesSection contract={c} myId={myId} />}
          {c && <ReviewSection contract={c} myId={myId} />}
          {c && c.status === 'disputed' && <DisputeSection contractId={c.id} />}
        </div>

        <section
          className={`card chat${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="card-head">
            <h3>
              <MessageSquare size={16} /> Chat
            </h3>
            {connected ? (
              <span className="chip rank">ao vivo</span>
            ) : (
              <span className="pill">offline</span>
            )}
          </div>
          <div className="chat-log">
            {history.isLoading ? (
              <p className="muted">Carregando…</p>
            ) : messages.length === 0 ? (
              <p className="muted">Nenhuma mensagem ainda. Diga oi!</p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`bubble ${m.senderId === myId ? 'mine' : 'theirs'}${m.attachment ? ' with-attachment' : ''}${m.removedAt ? ' removed' : ''}`}
                  data-testid={
                    m.removedAt ? 'removed-message' : m.attachment ? 'attachment-bubble' : undefined
                  }
                >
                  {m.removedAt && (
                    <span className="bubble-removed">Mensagem removida pela moderação</span>
                  )}
                  {m.type === 'image' && m.attachment && (
                    <ImageAttachment attachment={m.attachment} />
                  )}
                  {m.type === 'file' && m.attachment && (
                    <FileAttachment attachment={m.attachment} />
                  )}
                  {m.content && <span>{m.content}</span>}
                  {m.signals.length > 0 && (
                    <span className="bubble-flag" data-testid="off-platform-warning">
                      <TriangleAlert size={12} aria-hidden="true" /> Fora do Escambo não há proteção
                      do escrow
                    </span>
                  )}
                  <span className="muted tiny">{hm(m.createdAt)}</span>
                </div>
              ))
            )}
            <div ref={endRef} />
          </div>
          {pending && <PendingAttachment file={pending} onRemove={() => setPending(null)} />}
          {hints.length > 0 && (
            <p className="chat-hint off-platform" role="status" data-testid="off-platform-hint">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                {capitalize(describeSignals(hints))} na mensagem: pagamento fora do Escambo não tem
                a proteção do escrow, e a mensagem vai para a moderação.
              </span>
            </p>
          )}
          <form className="chat-input" onSubmit={submit}>
            <input
              ref={fileRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              hidden
              data-testid="attachment-input"
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => fileRef.current?.click()}
              disabled={sending}
              aria-label="Anexar arquivo"
              title={`Imagem, PDF ou ZIP até ${MAX_ATTACHMENT_MB} MB`}
            >
              <Paperclip size={16} />
            </Button>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onPaste}
              placeholder={pending ? 'Legenda (opcional)…' : 'Escreva uma mensagem…'}
              maxLength={2000}
            />
            <Button
              type="submit"
              disabled={sending || (!draft.trim() && !pending)}
              aria-label="Enviar"
            >
              <Send size={16} />
            </Button>
          </form>
          <p className="muted tiny chat-hint">
            Imagem, PDF ou ZIP até {MAX_ATTACHMENT_MB} MB: clipe, colar ou arrastar aqui.
          </p>
        </section>
      </div>
      {c && disputeOpen && <DisputeModal contract={c} onClose={() => setDisputeOpen(false)} />}
    </div>
  );
}
