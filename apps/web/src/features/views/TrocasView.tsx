import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BarterAgreement, Service } from '@escambo/types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { brl, BARTER_STATUS_LABEL, dt } from '../../lib/format';

const PLATFORM_FEE_RATE = 0.15; // RN-066 (espelha o backend)

/** Bucket visual reaproveitando as pills de contrato. */
function pillClass(status: string): string {
  if (status === 'completed') return 'status-completed';
  if (status === 'accepted' || status === 'active') return 'status-accepted';
  if (status === 'cancelled' || status === 'rejected' || status === 'disputed') return 'status-cancelled';
  return 'status-pending';
}

export function TrocasView() {
  const { user } = useAuth();
  const myId = user?.id ?? -1;

  const [barters, setBarters] = useState<BarterAgreement[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // formulário de proposta
  const [targetId, setTargetId] = useState(0); // serviço-alvo (o que eu quero)
  const [offerMode, setOfferMode] = useState<'service' | 'describe'>('service');
  const [offerServiceId, setOfferServiceId] = useState(0);
  const [offerDesc, setOfferDesc] = useState('');
  const [offerValue, setOfferValue] = useState('');

  const load = useCallback(() => {
    void api.barters().then((r) => setBarters(r.items)).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    void api.listServices().then((r) => setServices(r.items)).catch(() => undefined);
  }, [load]);

  const serviceById = useMemo(() => {
    const m = new Map<number, Service>();
    for (const s of services) m.set(s.id, s);
    return m;
  }, [services]);

  const mine = useMemo(() => services.filter((s) => s.ownerId === myId), [services, myId]);
  const others = useMemo(() => services.filter((s) => s.ownerId !== myId), [services, myId]);
  const target = serviceById.get(targetId);

  // prévia da torna (espelha barter.service.propose)
  const offered = Number(offerValue) || 0;
  const requested = target?.price ?? 0;
  const diff = Math.abs(offered - requested);
  const fee = PLATFORM_FEE_RATE * Math.max(offered, requested);
  const tornaHint =
    offered === 0 || requested === 0
      ? null
      : offered > requested
        ? `Receptor te paga ${brl(diff)} de torna`
        : requested > offered
          ? `Você paga ${brl(diff)} de torna`
          : 'Troca equilibrada — sem torna';

  function svcLabel(id: number | null, desc: string | null): string {
    if (id != null) return serviceById.get(id)?.title ?? `Serviço #${id}`;
    return desc ?? '—';
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy('new');
    setError(null);
    try {
      await api.proposeBarter({
        receiverId: target.ownerId,
        requestedServiceId: target.id,
        estimatedValueRequested: requested,
        estimatedValueOffered: offered,
        offeredServiceId: offerMode === 'service' ? offerServiceId : null,
        offeredDescription: offerMode === 'describe' ? offerDesc : null,
      });
      setOpen(false);
      setTargetId(0);
      setOfferDesc('');
      setOfferValue('');
      load();
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro ao propor troca');
    } finally {
      setBusy(null);
    }
  }

  async function act(id: number, action: 'accept' | 'reject' | 'cancel') {
    setBusy(id);
    setError(null);
    try {
      await api.barterAction(id, action);
      load();
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="view">
      <div className="view-head">
        <h2>Trocas ⇄</h2>
        <button onClick={() => setOpen((o) => !o)} disabled={others.length === 0}>
          {open ? 'Fechar' : '+ Propor troca'}
        </button>
      </div>
      <p className="muted">
        O coração do Escambo: troque serviço por serviço. Quem oferece menos paga a <b>torna</b> (a
        diferença), e a plataforma retém {Math.round(PLATFORM_FEE_RATE * 100)}% do maior valor.
      </p>
      {error && <p className="error">{error}</p>}

      {open && (
        <form className="card" onSubmit={submit}>
          <h3>Nova proposta de troca</h3>
          <label>
            Eu quero (serviço de outro freelancer)
            <select value={targetId} onChange={(e) => setTargetId(Number(e.target.value))} required>
              <option value={0} disabled>
                Selecione um serviço…
              </option>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} — {s.price != null ? brl(s.price) : 'a combinar'}
                </option>
              ))}
            </select>
          </label>

          <div className="tabs">
            <button
              type="button"
              className={offerMode === 'service' ? 'active' : ''}
              onClick={() => setOfferMode('service')}
            >
              Ofereço um serviço meu
            </button>
            <button
              type="button"
              className={offerMode === 'describe' ? 'active' : ''}
              onClick={() => setOfferMode('describe')}
            >
              Descrever oferta
            </button>
          </div>

          {offerMode === 'service' ? (
            <label>
              Serviço que ofereço
              <select
                value={offerServiceId}
                onChange={(e) => setOfferServiceId(Number(e.target.value))}
                required
              >
                <option value={0} disabled>
                  {mine.length ? 'Selecione…' : 'Você ainda não tem serviços'}
                </option>
                {mine.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              O que ofereço
              <input
                value={offerDesc}
                onChange={(e) => setOfferDesc(e.target.value)}
                placeholder="Ex.: edição de 3 vídeos curtos"
                required
                minLength={3}
              />
            </label>
          )}

          <label>
            Valor estimado da minha oferta (R$)
            <input
              type="number"
              min={1}
              step="0.01"
              value={offerValue}
              onChange={(e) => setOfferValue(e.target.value)}
              required
            />
          </label>

          {target && offered > 0 && (
            <div className="escrow">
              {tornaHint} · taxa da plataforma {brl(fee)}
              <span> — você recebe {brl(requested)} em serviço por {brl(offered)}</span>
            </div>
          )}

          <button type="submit" disabled={busy === 'new' || !target}>
            {busy === 'new' ? 'Enviando…' : 'Enviar proposta'}
          </button>
        </form>
      )}

      <div className="cards-grid">
        {barters.length === 0 ? (
          <p className="muted">Nenhuma troca ainda. Proponha a primeira!</p>
        ) : (
          barters.map((b) => {
            const iAmProposer = b.proposerId === myId;
            const iAmReceiver = b.receiverId === myId;
            const iPayTorna = b.cashPayerId === myId;
            const tornaLine =
              b.cashDifference <= 0
                ? 'Sem torna'
                : iPayTorna
                  ? `Você paga ${brl(b.cashDifference)} de torna`
                  : `Você recebe ${brl(b.cashDifference)} de torna`;
            return (
              <div key={b.id} className="card service">
                <div className="svc-top">
                  <span className="chip rank">{iAmProposer ? 'Você propôs' : 'Recebida'}</span>
                  <span className={`pill ${pillClass(b.status)}`}>
                    {BARTER_STATUS_LABEL[b.status] ?? b.status}
                  </span>
                </div>

                <div className="swap">
                  <div className="swap-side">
                    <span className="muted tiny">{iAmProposer ? 'Você oferece' : 'Oferecem'}</span>
                    <strong>{svcLabel(b.offeredServiceId, b.offeredDescription)}</strong>
                    <span className="price">{brl(b.estimatedValueOffered)}</span>
                  </div>
                  <span className="arrow">⇄</span>
                  <div className="swap-side">
                    <span className="muted tiny">{iAmProposer ? 'Você recebe' : 'Querem'}</span>
                    <strong>{svcLabel(b.requestedServiceId, b.requestedDescription)}</strong>
                    <span className="price">{brl(b.estimatedValueRequested)}</span>
                  </div>
                </div>

                <div className="svc-foot">
                  <span className="muted">{tornaLine}</span>
                  <span className="muted tiny">{dt(b.createdAt)}</span>
                </div>

                {b.status === 'active' && (
                  <p className="ok">✓ 2 contratos recíprocos gerados — acompanhe em Contratações</p>
                )}

                {b.status === 'proposed' && (
                  <div className="acts">
                    {iAmReceiver && (
                      <>
                        <button className="mini" disabled={busy === b.id} onClick={() => act(b.id, 'accept')}>
                          Aceitar
                        </button>
                        <button className="mini" disabled={busy === b.id} onClick={() => act(b.id, 'reject')}>
                          Recusar
                        </button>
                      </>
                    )}
                    {iAmProposer && (
                      <button className="mini" disabled={busy === b.id} onClick={() => act(b.id, 'cancel')}>
                        Cancelar
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
