import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, ChatMessageEvent } from '@escambo/types';
import { Button, Input, QueryState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { brl, dtm, hm, STATUS_LABEL } from '../../lib/format';
import { useChatHistory, useContractDetail, useSendMessage } from '../../lib/hooks';
import { getSocket } from '../../lib/socket';
import { useToast } from '../../lib/toast';

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
    <div className="view">
      <div className="view-head">
        <div>
          <Button variant="mini" onClick={onBack}>
            ← Voltar
          </Button>
          <h2 style={{ marginTop: 8 }}>{c?.title ?? `Contrato #${contractId}`}</h2>
        </div>
        {c && <span className={`pill status-${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>}
      </div>

      <div className="sala">
        <section className="card">
          <h3>📌 Linha do tempo</h3>
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
                  <strong>{brl(d.price)}</strong>
                  <span className="muted">Taxa</span>
                  <span>{brl(d.platformFee)}</span>
                  <span className="muted">Líquido</span>
                  <strong className="price">{brl(d.freelancerNet)}</strong>
                  {d.paymentMode !== 'cash' && (
                    <>
                      <span className="muted">Modalidade</span>
                      <span className="tag">{d.paymentMode === 'credits' ? 'créditos' : 'troca'}</span>
                    </>
                  )}
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
          <h3>
            💬 Chat {connected ? <span className="chip rank">● ao vivo</span> : <span className="pill">offline</span>}
          </h3>
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
            <Button type="submit" disabled={send.isPending || !draft.trim()}>
              Enviar
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
