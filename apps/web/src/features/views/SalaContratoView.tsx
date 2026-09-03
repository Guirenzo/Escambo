import { ArrowLeft, ListChecks, MessageSquare, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, ChatMessageEvent } from '@escambo/types';
import { Button, Input, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { brl, dtm, hm, STATUS_LABEL } from '../../lib/format';
import { useChatHistory, useContractDetail, useSendMessage } from '../../lib/hooks';
import { getSocket } from '../../lib/socket';
import { useToast } from '../../lib/toast';

const MODE_LABEL: Record<string, string> = { cash: 'Dinheiro', credits: 'Créditos Escambo', barter: 'Troca' };

export function SalaContratoView({ contractId, onBack }: { contractId: number; onBack: () => void }) {
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const toast = useToast();
  const contract = useContractDetail(contractId);
  const history = useChatHistory(contractId);
  const send = useSendMessage(contractId);

  const [live, setLive] = useState<ChatMessage[]>([]); // mensagens que chegaram pelo socket
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

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
    socket.on('message:new', append);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('message:new', append);
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

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    try {
      const msg = await send.mutateAsync(content);
      setLive((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev, msg]));
      setDraft('');
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
        {c && <span className={`pill status-${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>}
      </div>

      <div className="sala">
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
                  <strong>{d.paymentMode === 'credits' ? `${Math.round(d.price)} créditos` : brl(d.price)}</strong>
                  <span className="muted">Taxa</span>
                  <span>{d.paymentMode === 'credits' ? 'sem taxa' : brl(d.platformFee)}</span>
                  <span className="muted">Líquido</span>
                  <strong className="price">
                    {d.paymentMode === 'credits' ? `${Math.round(d.freelancerNet)} créditos` : brl(d.freelancerNet)}
                  </strong>
                </div>
                <ol className="timeline">
                  {d.history.map((h, i) => (
                    <li key={i}>
                      <span className="dot" />
                      <div>
                        <strong>{STATUS_LABEL[h.status] ?? h.status}</strong>
                        {h.previousStatus && (
                          <span className="muted tiny"> · de {STATUS_LABEL[h.previousStatus] ?? h.previousStatus}</span>
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

        <section className="card chat">
          <div className="card-head">
            <h3>
              <MessageSquare size={16} /> Chat
            </h3>
            {connected ? <span className="chip rank">ao vivo</span> : <span className="pill">offline</span>}
          </div>
          <div className="chat-log">
            {history.isLoading ? (
              <p className="muted">Carregando…</p>
            ) : messages.length === 0 ? (
              <p className="muted">Nenhuma mensagem ainda. Diga oi!</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`bubble ${m.senderId === myId ? 'mine' : 'theirs'}`}>
                  <span>{m.content}</span>
                  <span className="muted tiny">{hm(m.createdAt)}</span>
                </div>
              ))
            )}
            <div ref={endRef} />
          </div>
          <form className="chat-input" onSubmit={submit}>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Escreva uma mensagem…"
              maxLength={2000}
            />
            <Button type="submit" disabled={send.isPending || !draft.trim()} aria-label="Enviar">
              <Send size={16} />
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
