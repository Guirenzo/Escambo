import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, ChatMessageEvent, ContractWithHistory } from '@escambo/types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { brl, dtm, hm, STATUS_LABEL } from '../../lib/format';
import { getSocket } from '../../lib/socket';

export function SalaContratoView({ contractId, onBack }: { contractId: number; onBack: () => void }) {
  const { user } = useAuth();
  const myId = user?.id ?? -1;

  const [contract, setContract] = useState<ContractWithHistory | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Carrega detalhe + histórico do chat.
  useEffect(() => {
    void api.contractDetail(contractId).then(setContract).catch(() => undefined);
    void api
      .chatHistory(contractId)
      .then((h) => setMessages(h.messages))
      .catch(() => undefined);
  }, [contractId]);

  // Conecta o socket, entra na sala e ouve mensagens novas em tempo real.
  useEffect(() => {
    const socket = getSocket();
    const append = (m: ChatMessageEvent | ChatMessage): void => {
      if ('contractId' in m && m.contractId !== contractId) return;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    };
    const onConnect = (): void => {
      setLive(true);
      socket.emit('contract:join', contractId);
    };
    if (socket.connected) onConnect();
    socket.on('connect', onConnect);
    socket.on('disconnect', () => setLive(false));
    socket.on('message:new', append);
    return () => {
      socket.off('connect', onConnect);
      socket.off('message:new', append);
    };
  }, [contractId]);

  // Rola para a última mensagem.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setSending(true);
    setError(null);
    try {
      const msg = await api.sendMessage(contractId, content);
      setDraft('');
      setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev, msg]));
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro ao enviar');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <button className="mini" onClick={onBack}>
            ← Voltar
          </button>
          <h2 style={{ marginTop: 8 }}>{contract?.title ?? `Contrato #${contractId}`}</h2>
        </div>
        {contract && (
          <span className={`pill status-${contract.status}`}>
            {STATUS_LABEL[contract.status] ?? contract.status}
          </span>
        )}
      </div>

      <div className="sala">
        {/* Timeline da máquina de estados */}
        <section className="card">
          <h3>📌 Linha do tempo</h3>
          {contract ? (
            <>
              <div className="kv">
                <span className="muted">Valor</span>
                <strong>{brl(contract.price)}</strong>
                <span className="muted">Taxa</span>
                <span>{brl(contract.platformFee)}</span>
                <span className="muted">Líquido</span>
                <strong className="price">{brl(contract.freelancerNet)}</strong>
              </div>
              <ol className="timeline">
                {contract.history.map((h, i) => (
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
          ) : (
            <p className="muted">Carregando…</p>
          )}
        </section>

        {/* Chat em tempo real */}
        <section className="card chat">
          <h3>
            💬 Chat {live ? <span className="chip rank">● ao vivo</span> : <span className="pill">offline</span>}
          </h3>
          <div className="chat-log">
            {messages.length === 0 ? (
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
          {error && <p className="error">{error}</p>}
          <form className="chat-input" onSubmit={send}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Escreva uma mensagem…"
              maxLength={2000}
            />
            <button type="submit" disabled={sending || !draft.trim()}>
              Enviar
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
