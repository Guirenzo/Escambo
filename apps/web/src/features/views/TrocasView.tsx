import { ArrowLeftRight, Plus } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import type { BarterAgreement, Service } from '@escambo/types';
import { Button, Field, Input, PageHeader, QueryState, Select } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { BARTER_STATUS_LABEL, brl, dt } from '../../lib/format';
import { useBarterAction, useBarters, useProposeBarter, useServices } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

const PLATFORM_FEE_RATE = 0.15; // RN-066 (espelha o backend)

function pillClass(status: string): string {
  if (status === 'completed') return 'status-completed';
  if (status === 'accepted' || status === 'active') return 'status-accepted';
  if (status === 'cancelled' || status === 'rejected' || status === 'disputed') return 'status-cancelled';
  return 'status-pending';
}

export function TrocasView() {
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const toast = useToast();
  const barters = useBarters();
  const services = useServices();
  const propose = useProposeBarter();
  const act = useBarterAction();

  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState(0);
  const [offerMode, setOfferMode] = useState<'service' | 'describe'>('service');
  const [offerServiceId, setOfferServiceId] = useState(0);
  const [offerDesc, setOfferDesc] = useState('');
  const [offerValue, setOfferValue] = useState('');

  const all = useMemo(() => services.data?.items ?? [], [services.data]);
  const serviceById = useMemo(() => new Map(all.map((s) => [s.id, s])), [all]);
  const mine = useMemo(() => all.filter((s) => s.ownerId === myId), [all, myId]);
  const others = useMemo(() => all.filter((s) => s.ownerId !== myId), [all, myId]);
  const target: Service | undefined = serviceById.get(targetId);

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

  const svcLabel = (id: number | null, desc: string | null): string =>
    id != null ? (serviceById.get(id)?.title ?? `Serviço #${id}`) : (desc ?? '—');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!target) return;
    try {
      await propose.mutateAsync({
        receiverId: target.ownerId,
        requestedServiceId: target.id,
        estimatedValueRequested: requested,
        estimatedValueOffered: offered,
        offeredServiceId: offerMode === 'service' ? offerServiceId : null,
        offeredDescription: offerMode === 'describe' ? offerDesc : null,
      });
      toast.success('Proposta de troca enviada!');
      setOpen(false);
      setTargetId(0);
      setOfferDesc('');
      setOfferValue('');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao propor troca');
    }
  }

  async function run(id: number, action: 'accept' | 'reject' | 'cancel'): Promise<void> {
    try {
      await act.mutateAsync({ id, action });
      toast.success('Troca atualizada');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Trocas"
        subtitle={
          <>
            Troque serviço por serviço. Quem oferece menos paga a <b>torna</b>; a plataforma retém{' '}
            {Math.round(PLATFORM_FEE_RATE * 100)}% do maior valor.
          </>
        }
        action={
          <Button variant={open ? 'secondary' : 'primary'} onClick={() => setOpen((o) => !o)} disabled={others.length === 0}>
            <Plus size={16} /> {open ? 'Fechar' : 'Propor troca'}
          </Button>
        }
      />

      {open && (
        <form className="card" onSubmit={submit}>
          <h3>Nova proposta de troca</h3>
          <Field label="Eu quero (serviço de outro freelancer)">
            <Select value={targetId} onChange={(e) => setTargetId(Number(e.target.value))} required>
              <option value={0} disabled>
                Selecione um serviço…
              </option>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} — {s.price != null ? brl(s.price) : 'a combinar'}
                </option>
              ))}
            </Select>
          </Field>

          <div className="tabs">
            <button type="button" className={offerMode === 'service' ? 'active' : ''} onClick={() => setOfferMode('service')}>
              Ofereço um serviço meu
            </button>
            <button type="button" className={offerMode === 'describe' ? 'active' : ''} onClick={() => setOfferMode('describe')}>
              Descrever oferta
            </button>
          </div>

          {offerMode === 'service' ? (
            <Field label="Serviço que ofereço">
              <Select value={offerServiceId} onChange={(e) => setOfferServiceId(Number(e.target.value))} required>
                <option value={0} disabled>
                  {mine.length ? 'Selecione…' : 'Você ainda não tem serviços'}
                </option>
                {mine.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="O que ofereço">
              <Input value={offerDesc} onChange={(e) => setOfferDesc(e.target.value)} placeholder="Ex.: edição de 3 vídeos curtos" required minLength={3} />
            </Field>
          )}

          <Field label="Valor estimado da minha oferta (R$)">
            <Input type="number" min={1} step="0.01" value={offerValue} onChange={(e) => setOfferValue(e.target.value)} required />
          </Field>

          {target && offered > 0 && (
            <div className="summary">
              <strong>{tornaHint}</strong>
              <span className="muted tiny">taxa {brl(fee)} · você recebe {brl(requested)} em serviço por {brl(offered)}</span>
            </div>
          )}

          <Button type="submit" disabled={propose.isPending || !target}>
            {propose.isPending ? 'Enviando…' : 'Enviar proposta'}
          </Button>
        </form>
      )}

      <QueryState
        isLoading={barters.isLoading}
        error={barters.error}
        data={barters.data}
        isEmpty={(d) => d.items.length === 0}
        empty="Nenhuma troca ainda. Proponha a primeira!"
        onRetry={() => void barters.refetch()}
      >
        {(d) => (
          <div className="cards-grid">
            {d.items.map((b: BarterAgreement) => {
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
                    <span className={`pill ${pillClass(b.status)}`}>{BARTER_STATUS_LABEL[b.status] ?? b.status}</span>
                  </div>
                  <div className="swap">
                    <div className="swap-side">
                      <span className="muted tiny">{iAmProposer ? 'Você oferece' : 'Oferecem'}</span>
                      <strong>{svcLabel(b.offeredServiceId, b.offeredDescription)}</strong>
                      <span className="price">{brl(b.estimatedValueOffered)}</span>
                    </div>
                    <span className="arrow">
                      <ArrowLeftRight size={18} />
                    </span>
                    <div className="swap-side">
                      <span className="muted tiny">{iAmProposer ? 'Você recebe' : 'Querem'}</span>
                      <strong>{svcLabel(b.requestedServiceId, b.requestedDescription)}</strong>
                      <span className="price">{brl(b.estimatedValueRequested)}</span>
                    </div>
                  </div>
                  <div className="svc-foot">
                    <span className="muted tiny">{tornaLine}</span>
                    <span className="muted tiny">{dt(b.createdAt)}</span>
                  </div>
                  {b.status === 'active' && <p className="ok">2 contratos recíprocos gerados — acompanhe em Início</p>}
                  {b.status === 'proposed' && (
                    <div className="svc-actions">
                      {iAmReceiver && (
                        <>
                          <Button variant="mini" disabled={act.isPending} onClick={() => void run(b.id, 'accept')}>Aceitar</Button>
                          <Button variant="mini" disabled={act.isPending} onClick={() => void run(b.id, 'reject')}>Recusar</Button>
                        </>
                      )}
                      {iAmProposer && (
                        <Button variant="mini" disabled={act.isPending} onClick={() => void run(b.id, 'cancel')}>Cancelar</Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </QueryState>
    </div>
  );
}
