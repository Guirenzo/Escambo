import { BusinessForm } from '../../components/BusinessActions';
import { useReadOnlyAccount } from '../../lib/account-access';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Hourglass,
  ListChecks,
  MessageSquare,
  Paperclip,
  Send,
  Star,
  TriangleAlert,
} from 'lucide-react';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import type {
  ChatMessage,
  ChatMessageEvent,
  ChatReadEvent,
  ContractWithHistory,
} from '@escambo/types';
import { CompanyTag } from '../../components/CompanyTag';
import { StarInput, Stars } from '../../components/Stars';
import { Breadcrumbs, Button, Input, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { brl, dt, dtm, hm, statusLabel, STATUS_LABEL } from '../../lib/format';
import {
  useChatHistory,
  useContractDetail,
  useCreateReview,
  useMarkChatRead,
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
import { CancelModal } from '../contracts/CancelModal';
import { DeliveriesSection } from '../contracts/DeliveriesSection';
import { DeliverModal } from '../contracts/DeliverModal';
import { DropoutAgreement } from '../contracts/DropoutAgreement';
import { ContractActions } from '../contracts/ContractActions';
import { DisputeWindowNotice, RevisionSummary } from '../contracts/ContractRuleNotices';
import { ContractPackageSummary } from '../contracts/ContractPackageSummary';
import { disputeWaiting, revisionCount, revisionsExhausted } from '../contracts/contractRules';
import { useContractNow } from '../contracts/useContractNow';
import { CounterOfferModal } from '../contracts/CounterOfferModal';
import { AcceptCounterModal } from '../contracts/AcceptCounterModal';
import { NegotiationDueNotice, NegotiationSection } from '../contracts/NegotiationSection';
import { DeadlineSection, RevisionSince } from '../contracts/DeadlineSection';
import { DisputeModal, DisputeSection } from '../contracts/DisputePanel';
import { MilestonesSection } from '../contracts/MilestonesSection';
import { describeSignals, offPlatformSignals } from '../../lib/offPlatform';
import { deadlineText, deadlineZoneNote, momentText, untilLabel } from '../../lib/deadline';
import { DEFAULT_TIMEZONE } from '../../lib/timezones';
import { scrollBehavior } from '../../lib/motion';
import { useToast } from '../../lib/toast';

/** Valor da contratação na unidade dela ("R$ 200,00" ou "30 créditos"). */
const valueOf = (c: ContractWithHistory, v: number): string =>
  c.paymentMode === 'credits' ? `${Math.round(v)} créditos` : brl(v);

/**
 * Até quando cada lado age (ADR 57), com a hora gravada pela API no fuso de quem lê: a aprovação
 * automática da entrega e a validade da proposta.
 */
function DueNotice({
  contract: c,
  myId,
  zone,
}: {
  contract: ContractWithHistory;
  myId: number;
  zone: string | null | undefined;
}) {
  const now = useContractNow(c);
  const isClient = c.clientId === myId;
  const isFreelancer = c.freelancerId === myId;
  if (c.status === 'pending' && c.negotiation && c.paymentMode !== 'barter')
    return <NegotiationDueNotice contract={c} myId={myId} zone={zone} />;
  if (c.status === 'delivered' && c.approvalDueAt && (isClient || isFreelancer)) {
    const when = momentText(c.approvalDueAt, zone);
    const barter = c.paymentMode === 'barter';
    const choices = [
      'aprove',
      ...(!revisionsExhausted(c.revisions) ? ['peça revisão'] : []),
      ...(!disputeWaiting(c, now) ? ['abra disputa'] : []),
    ];
    const options =
      choices.length === 1
        ? choices[0]!
        : `${choices.slice(0, -1).join(', ')} ou ${choices.at(-1)!}`;
    return (
      <p className="notice" data-testid="approval-due">
        <Hourglass size={14} />{' '}
        {isClient
          ? `Entrega registrada. ${options.charAt(0).toUpperCase()}${options.slice(1)} até ${when}; depois disso a entrega é aprovada automaticamente${
              barter ? ' e conta para fechar a troca.' : ' e o pagamento é liberado ao freelancer.'
            }`
          : `Entrega registrada. Sem resposta do cliente até ${when}, ela é aprovada automaticamente${
              barter ? '.' : ` e ${valueOf(c, c.freelancerNet)} é liberado para você.`
            }${c.revisions && !c.hasMilestones ? ` Revisões pedidas: ${revisionCount(c.revisions)}.` : ''}`}
      </p>
    );
  }
  if (c.status === 'pending' && c.proposalExpiresAt && (isClient || isFreelancer)) {
    const when = momentText(c.proposalExpiresAt, zone);
    const left = new Date(c.proposalExpiresAt).getTime() - Date.now();
    if (isFreelancer) {
      const toDeadline = c.deadlineAt ? new Date(c.deadlineAt).getTime() - Date.now() : null;
      return (
        <p className={`notice${left < 24 * 3_600_000 ? ' danger' : ''}`} data-testid="proposal-due">
          <Hourglass size={14} /> Responda até {when}: aceite ou recuse.
          {toDeadline !== null && toDeadline > 0
            ? ` Se aceitar agora, você terá ${untilLabel(toDeadline)} até o prazo.`
            : ''}
        </p>
      );
    }
    return (
      <p className="notice" data-testid="proposal-due">
        <Hourglass size={14} /> O freelancer tem até {when} para responder; sem resposta, a proposta
        se encerra
        {c.paymentMode === 'cash' ? ' e o valor reservado volta para a sua carteira.' : '.'}
      </p>
    );
  }
  return null;
}

/** Leitura (RF-059) de uma mensagem que eu mandei: ícone e texto, não só cor. */
function ReadStatus({ readAt }: { readAt: string | null }) {
  return readAt ? (
    <span
      className="muted tiny read-status"
      data-testid="read-status"
      title={`Lida em ${dtm(readAt)}`}
    >
      <CheckCheck size={14} aria-hidden="true" /> Lida
    </span>
  ) : (
    <span className="muted tiny read-status" data-testid="read-status">
      <Check size={14} aria-hidden="true" /> Enviada
    </span>
  );
}

const MODE_LABEL: Record<string, string> = {
  cash: 'Dinheiro',
  credits: 'Créditos Escambo',
  barter: 'Troca',
};

/** As quatro etapas do caminho de uma contratação e os status que contam como cada uma. */
const STEPS: { label: string; statuses: string[] }[] = [
  { label: 'Proposta', statuses: ['pending'] },
  { label: 'Aceita', statuses: ['accepted', 'in_progress', 'revision_requested'] },
  { label: 'Entregue', statuses: ['delivered'] },
  { label: 'Concluída', statuses: ['completed'] },
];

/** Fim fora do caminho: a etapa final em vermelho, no lugar das que não vão acontecer. */
const OFF_PATH: Record<string, string> = {
  cancelled: 'Cancelada',
  rejected: 'Recusada',
  disputed: 'Em disputa',
};

/**
 * As etapas da contratação na horizontal (proposta, aceita, entregue, concluída), com o dia em que
 * cada uma aconteceu, tirado do histórico. Cancelada, recusada ou em disputa entram como a última
 * etapa, em vermelho. Para o leitor de tela, cada etapa diz se já foi, se é a atual ou se vem depois.
 */
export function ContractStepper({ contract: c }: { contract: ContractWithHistory }) {
  const firstAt = (statuses: string[]): string | null =>
    c.history.find((h) => statuses.includes(h.status))?.at ?? null;
  const reachedIndex = (status: string): number =>
    STEPS.findIndex((st) => st.statuses.includes(status));
  const off = OFF_PATH[c.status];
  // Até onde chegou: a etapa do status atual ou, fora do caminho, a mais avançada do histórico.
  const reached = off
    ? Math.max(-1, ...c.history.map((h) => reachedIndex(h.status)))
    : reachedIndex(c.status);
  const steps = off
    ? [
        ...STEPS.slice(0, reached + 1).map((st) => ({ label: st.label, at: firstAt(st.statuses) })),
        { label: off, at: firstAt([c.status]) },
      ]
    : STEPS.map((st) => ({ label: st.label, at: firstAt(st.statuses) }));
  const current = off ? steps.length - 1 : reached;
  return (
    <ol className={`stepper${off ? ' off-path' : ''}`} aria-label="Etapas da contratação">
      {steps.map((st, i) => {
        // Concluída: a última etapa é a atual e também já foi (a marca acesa, com o visto).
        const finished = c.status === 'completed' && i === current;
        const state = i < current || finished ? 'done' : i === current ? 'current' : 'next';
        return (
          <li
            key={st.label}
            className={`step ${state}`}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className="step-mark" aria-hidden="true">
              {state === 'done' ? <Check size={14} strokeWidth={3} /> : i + 1}
            </span>
            <span className="step-text">
              <strong>{st.label}</strong>
              <span className="step-at">
                {st.at ? dt(st.at) : state === 'next' ? 'a seguir' : ''}
              </span>
              <span className="sr-only">
                {state === 'done' ? ' (concluída)' : state === 'current' ? ' (etapa atual)' : ''}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** "Hoje", "Ontem" ou "20 de outubro": o separador de dia no chat. */
export function chatDayLabel(iso: string, now: Date = new Date()): string {
  const day = new Date(iso);
  const start = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(now) - start(day)) / 86_400_000);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  return new Intl.DateTimeFormat('pt-BR', {
    day: 'numeric',
    month: 'long',
    ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  }).format(day);
}

/** Onde o dinheiro (ou os créditos) está neste momento do contrato. */
function paymentState(
  c: Pick<ContractWithHistory, 'paymentMode' | 'status' | 'hasMilestones' | 'negotiation'>,
): string {
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
        : `Reservado na carteira do cliente${c.negotiation ? ` (oferta ${c.negotiation.seq % 2 === 1 ? c.negotiation.seq : c.negotiation.seq - 1})` : ''}`;
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
            <BusinessForm className="stack" onSubmit={submitReply}>
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
            </BusinessForm>
          ) : null}
        </div>
      ) : isClient ? (
        <BusinessForm className="stack" onSubmit={submitReview}>
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
        </BusinessForm>
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
  const readOnly = useReadOnlyAccount();
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const toast = useToast();
  const contract = useContractDetail(contractId);
  // "Contratação: …" separa a Sala do detalhe do serviço, que costuma ter o mesmo título (WCAG 2.4.2).
  usePageTitle(contract.data ? `Contratação: ${contract.data.title}` : 'Contratação');
  const history = useChatHistory(contractId);
  const send = useSendMessage(contractId);
  const sendFile = useSendAttachment(contractId);
  const { mutate: markReadUpTo } = useMarkChatRead(contractId);

  const [live, setLive] = useState<ChatMessage[]>([]); // mensagens que chegaram pelo socket
  const [reads, setReads] = useState<ChatReadEvent[]>([]); // leituras avisadas pelo socket
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [acceptCounterOpen, setAcceptCounterOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [pending, setPending] = useState<File | null>(null); // anexo escolhido, ainda não enviado
  const [dragging, setDragging] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!readOnly) return;
    setPending(null);
    setDragging(false);
    setDisputeOpen(false);
    setCancelOpen(false);
    setCounterOpen(false);
    setAcceptCounterOpen(false);
  }, [readOnly]);

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
    // Leitura (RF-059): a outra parte leu até upToId; "Enviada" vira "Lida" na hora.
    const onRead = (r: ChatReadEvent): void => {
      if (r.contractId !== contractId) return;
      setReads((prev) => [...prev, r]);
    };
    socket.on('message:new', append);
    socket.on('message:updated', replace);
    socket.on('message:read', onRead);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('message:new', append);
      socket.off('message:updated', replace);
      socket.off('message:read', onRead);
    };
  }, [contractId]);

  // Histórico (cache) + mensagens ao vivo, sem duplicar, em ordem, com as leituras avisadas.
  const messages = useMemo(() => {
    const byId = new Map<number, ChatMessage>();
    for (const m of history.data?.messages ?? []) byId.set(m.id, m);
    for (const m of live) {
      // A versão ao vivo é a mais nova, mas a leitura que o histórico já trouxe continua valendo.
      const readAt = m.readAt ?? byId.get(m.id)?.readAt ?? null;
      byId.set(m.id, { ...m, readAt });
    }
    return [...byId.values()]
      .map((m) => {
        if (m.readAt) return m;
        // A primeira leitura que cobre a mensagem dá o horário; quem lê é sempre a outra parte.
        // Só as desta Sala: trocar de contratação sem sair da tela não leva a leitura de outra.
        const read = reads.find(
          (r) => r.contractId === contractId && r.readerId !== m.senderId && r.upToId >= m.id,
        );
        return read ? { ...m, readAt: read.readAt } : m;
      })
      .sort((a, b) => a.id - b.id);
  }, [history.data, live, reads, contractId]);

  // A maior mensagem recebida ainda não lida (0 = nenhuma).
  const lastUnread = useMemo(
    () =>
      messages.reduce((max, m) => (m.senderId !== myId && !m.readAt && m.id > max ? m.id : max), 0),
    [messages, myId],
  );

  // Até onde esta tela já pediu para marcar, por contratação (os ids são da plataforma toda).
  const markedUpTo = useRef({ contractId, upTo: 0 });

  // Marca como lidas as recebidas quando a conversa está na tela: ao abrir, quando chega mensagem
  // nova e quando a aba volta a ficar visível. Aba escondida não marca nada.
  useEffect(() => {
    if (markedUpTo.current.contractId !== contractId) markedUpTo.current = { contractId, upTo: 0 };
    if (!lastUnread) return;
    const done = markedUpTo.current;
    const mark = (): void => {
      if (document.visibilityState !== 'visible' || lastUnread <= done.upTo) return;
      const previous = done.upTo;
      done.upTo = lastUnread;
      markReadUpTo(lastUnread, {
        // Falhou (rede): a próxima mensagem ou a volta à aba tentam de novo.
        onError: () => {
          if (done.upTo === lastUnread) done.upTo = previous;
        },
      });
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [contractId, lastUnread, markReadUpTo]);

  // Só a lista do chat rola até a última mensagem. O scrollIntoView de antes rolava também a
  // página: ao abrir a Sala, a tela pulava para o chat e o Tab começava no campo de mensagem, longe
  // do "pular para o conteúdo" e do topo da contratação (WCAG 2.4.3).
  useEffect(() => {
    const log = logRef.current;
    log?.scrollTo?.({ top: log.scrollHeight, behavior: scrollBehavior() });
  }, [messages.length]);

  /** Escolhe um arquivo (clipe, colar ou arrastar); a API confere o tipo pelo conteúdo. */
  function pick(file: File | undefined | null): void {
    if (!file || readOnly) return;
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
    if (readOnly) return;
    pick(e.dataTransfer.files[0]);
  }

  const sending = send.isPending || sendFile.isPending;
  // Aviso ao digitar (ADR 45): o mesmo detector da API, só para avisar antes de enviar.
  const hints = useMemo(() => offPlatformSignals(draft), [draft]);
  const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (readOnly) return;
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
      <section className="sala-header" aria-labelledby="sala-title">
        {/* Migalhas: a sala é uma das contratações listadas no Início. */}
        <div className="sala-crumbs">
          <Button variant="ghost" className="mini" onClick={onBack}>
            <ArrowLeft size={14} /> Voltar
          </Button>
          <Breadcrumbs
            items={[{ label: 'Início', to: '/' }, { label: c?.title ?? `Contrato #${contractId}` }]}
          />
        </div>
        <div className="sala-head-row">
          <div className="sala-head-text">
            <h1 id="sala-title">{c?.title ?? `Contrato #${contractId}`}</h1>
            {c && (
              <p className="sala-head-meta">
                <span className={`pill status-${c.status}`}>{statusLabel(c)}</span>
                <span className="muted">
                  {MODE_LABEL[c.paymentMode] ?? c.paymentMode} · criado em {dtm(c.createdAt)}
                </span>
              </p>
            )}
            {/* RF-018: quem contrata é empresa; quem entrega vê com quem está trabalhando. */}
            {c?.clientCompany && c.clientId !== myId && (
              <p className="sala-head-meta">
                <CompanyTag company={c.clientCompany} label="Contratante:" />
              </p>
            )}
          </div>
          {c && (
            <div className="sala-head-right">
              <ContractActions
                contract={c}
                exclude={['review']}
                onDispute={() => setDisputeOpen(true)}
                onCancel={() => setCancelOpen(true)}
                onCounter={() => setCounterOpen(true)}
                onAcceptCounter={() => setAcceptCounterOpen(true)}
                onDeliver={() => setDeliverOpen(true)}
              />
            </div>
          )}
        </div>
        {c && <ContractStepper contract={c} />}
        {c && <DisputeWindowNotice contract={c} myId={myId} />}
      </section>

      {c && <DueNotice contract={c} myId={myId} zone={user?.timezone} />}
      {c && <RevisionSummary contract={c} myId={myId} />}
      {c?.dropout && <DropoutAgreement contract={c} myId={myId} />}

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
                    <ContractPackageSummary pkg={d.package} />
                    <span className="muted">
                      {d.status === 'pending' && (d.negotiation?.seq ?? 0) > 1
                        ? 'Valor (oferta do cliente)'
                        : 'Valor'}
                    </span>
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
                      {d.deadlineAt
                        ? `${deadlineText(d.deadlineAt, d.deadlineZone ?? DEFAULT_TIMEZONE)}${deadlineZoneNote(d.deadlineAt, d.deadlineZone ?? DEFAULT_TIMEZONE, user?.timezone)}`
                        : 'sem prazo definido'}
                    </span>
                  </div>
                  <ol className="timeline" aria-label="Histórico da contratação">
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

          {c && <DeliveriesSection contract={c} myId={myId} />}
          {c && <NegotiationSection contract={c} myId={myId} />}
          {c && <DeadlineSection contract={c} myId={myId} />}
          {c && <RevisionSince contract={c} myId={myId} />}
          {c && <MilestonesSection contract={c} myId={myId} />}
          {c && <ReviewSection contract={c} myId={myId} />}
          {c && c.status === 'disputed' && <DisputeSection contractId={c.id} />}
        </div>

        <section
          className={`card chat${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!readOnly) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="card-head chat-head">
            <span className="chat-head-ico" aria-hidden="true">
              <MessageSquare size={18} />
            </span>
            <div className="chat-head-text">
              <h3>Chat</h3>
              <p className="card-sub">
                Tudo o que for combinado aqui fica registrado na contratação.
              </p>
            </div>
            {connected ? (
              <span className="chat-live">ao vivo</span>
            ) : (
              <span className="pill">offline</span>
            )}
          </div>
          <div className="chat-log" ref={logRef}>
            {history.isLoading ? (
              <p className="muted">Carregando…</p>
            ) : messages.length === 0 ? (
              <p className="muted">Nenhuma mensagem ainda. Diga oi!</p>
            ) : (
              messages.map((m, i) => (
                <Fragment key={m.id}>
                  {(i === 0 ||
                    new Date(messages[i - 1]!.createdAt).toDateString() !==
                      new Date(m.createdAt).toDateString()) && (
                    <p className="chat-day">
                      <span>{chatDayLabel(m.createdAt)}</span>
                    </p>
                  )}
                  <div
                    className={`bubble ${m.senderId === myId ? 'mine' : 'theirs'}${m.attachment ? ' with-attachment' : ''}${m.removedAt ? ' removed' : ''}`}
                    data-testid={
                      m.removedAt
                        ? 'removed-message'
                        : m.attachment
                          ? 'attachment-bubble'
                          : undefined
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
                        <TriangleAlert size={12} aria-hidden="true" /> Fora do Escambo não há
                        proteção do escrow
                      </span>
                    )}
                    <span className="bubble-meta">
                      <span className="muted tiny">{hm(m.createdAt)}</span>
                      {m.senderId === myId && !m.removedAt && <ReadStatus readAt={m.readAt} />}
                    </span>
                  </div>
                </Fragment>
              ))
            )}
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
          <BusinessForm className="chat-input" onSubmit={submit}>
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
          </BusinessForm>
          <p className="muted tiny chat-hint">
            {readOnly ? (
              'Chat disponível somente para leitura durante a suspensão.'
            ) : (
              <>Imagem, PDF ou ZIP até {MAX_ATTACHMENT_MB} MB: clipe, colar ou arrastar aqui.</>
            )}
          </p>
        </section>
      </div>
      {c && disputeOpen && <DisputeModal contract={c} onClose={() => setDisputeOpen(false)} />}
      {c && cancelOpen && <CancelModal contract={c} onClose={() => setCancelOpen(false)} />}
      {c && counterOpen && <CounterOfferModal contract={c} onClose={() => setCounterOpen(false)} />}
      {c && acceptCounterOpen && (
        <AcceptCounterModal contract={c} onClose={() => setAcceptCounterOpen(false)} />
      )}
      {c && deliverOpen && <DeliverModal contract={c} onClose={() => setDeliverOpen(false)} />}
    </div>
  );
}
