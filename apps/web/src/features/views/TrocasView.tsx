import { BusinessButton, BusinessForm } from '../../components/BusinessActions';
import { ArrowLeftRight, Plus, QrCode } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BarterAgreement, BarterValueSource, Service } from '@escambo/types';
import {
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  QueryState,
  Select,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { BARTER_STATUS_LABEL, brl, dt, TORNA_STATUS_LABEL } from '../../lib/format';
import {
  useBarterAction,
  useBarters,
  useProposeBarter,
  usePublicSettings,
  useServices,
  useWallet,
} from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { DepositModal } from '../wallet/DepositModal';

function pillClass(status: string): string {
  if (status === 'completed') return 'status-completed';
  if (status === 'accepted' || status === 'active') return 'status-accepted';
  if (status === 'cancelled' || status === 'rejected' || status === 'disputed')
    return 'status-cancelled';
  return 'status-pending';
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Quanto o catálogo diz que um lado da troca vale (RF-084): só o preço fechado. A combinar, por
 * hora ou sem preço, quem propõe informa. É a mesma regra da API, que recusa valor diferente.
 */
export function catalogPrice(s: Service | undefined): number | null {
  return s && s.priceType === 'fixed' && s.price != null && s.price > 0 ? round2(s.price) : null;
}

const SOURCE_LABEL: Record<BarterValueSource, string> = {
  catalog: 'preço do catálogo',
  informed: 'valor informado',
};

/** De onde vem o valor que a tela mostra antes de enviar. */
const sourceOf = (catalog: number | null): string =>
  catalog !== null ? SOURCE_LABEL.catalog : 'informado por você';

/** Preço como o catálogo mostra: fechado, por hora ou a combinar. */
const priceLabel = (s: Service): string =>
  s.price == null || s.priceType === 'negotiable'
    ? 'a combinar'
    : s.priceType === 'hourly'
      ? `${brl(s.price)}/h`
      : brl(s.price);

export function TrocasView() {
  usePageTitle('Trocas');
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const toast = useToast();
  const barters = useBarters();
  const services = useServices({ limit: 100 });
  const wallet = useWallet();
  const publicSettings = usePublicSettings();
  const [params, setParams] = useSearchParams();
  const propose = useProposeBarter();
  const act = useBarterAction();

  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState(0);
  const [offerMode, setOfferMode] = useState<'service' | 'describe'>('service');
  const [offerServiceId, setOfferServiceId] = useState(0);
  const [offerDesc, setOfferDesc] = useState('');
  const [offerValue, setOfferValue] = useState('');
  const [requestedValue, setRequestedValue] = useState('');
  const [depositFor, setDepositFor] = useState<number | null>(null);

  // Vindo de um card ("Propor troca"): abre o formulário com o serviço desejado já escolhido.
  useEffect(() => {
    const preset = Number(params.get('propor'));
    if (preset > 0) {
      setTargetId(preset);
      setOpen(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const all = useMemo(() => services.data?.items ?? [], [services.data]);
  const serviceById = useMemo(() => new Map(all.map((s) => [s.id, s])), [all]);
  const mine = useMemo(() => all.filter((s) => s.ownerId === myId), [all, myId]);
  const others = useMemo(() => all.filter((s) => s.ownerId !== myId), [all, myId]);
  const target: Service | undefined = serviceById.get(targetId);

  const offerService: Service | undefined =
    offerMode === 'service' ? serviceById.get(offerServiceId) : undefined;

  // RF-084: o sistema estima cada lado pelo catálogo; digita-se só o que não tem preço fechado.
  const balance = wallet.data?.balance ?? 0;
  const requestedCatalog = catalogPrice(target);
  const offeredCatalog = catalogPrice(offerService);
  const askRequested = target !== undefined && requestedCatalog === null;
  const askOffered =
    offerMode === 'describe' || (offerService !== undefined && offeredCatalog === null);
  const offered = offeredCatalog ?? (askOffered ? Number(offerValue) || 0 : 0);
  const requested = requestedCatalog ?? (Number(requestedValue) || 0);
  const offerReady =
    offerMode === 'describe' ? offerDesc.trim().length >= 3 : offerService !== undefined;
  const diff = round2(Math.abs(offered - requested));
  const feeRate = (publicSettings.data?.platformFeePercentage ?? 15) / 100; // RN-066: só sobre a torna
  const barterEnabled = publicSettings.data?.barterEnabled ?? true;
  const fee = round2(feeRate * diff);
  const iPayOnPropose = offered > 0 && requested > offered; // recebo o serviço mais valioso
  const missing = iPayOnPropose ? round2(Math.max(0, diff - balance)) : 0;
  const tornaHint =
    offered <= 0 || requested <= 0
      ? null
      : offered > requested
        ? `Receptor te paga ${brl(diff)} de torna · você recebe ${brl(round2(diff - fee))} líquido`
        : requested > offered
          ? `Você paga ${brl(diff)} de torna · reservado da sua carteira agora`
          : 'Troca equilibrada — sem torna nem taxa';

  const svcLabel = (id: number | null, title: string | null, desc: string | null): string =>
    title ?? (id != null ? (serviceById.get(id)?.title ?? `Serviço #${id}`) : (desc ?? '—'));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!target) return;
    try {
      // Os valores vão como a tela mostrou: se o catálogo mudou nesse meio-tempo, a API recusa
      // (estimate_mismatch) em vez de reservar uma torna que a pessoa não viu.
      await propose.mutateAsync({
        receiverId: target.ownerId,
        requestedServiceId: target.id,
        estimatedValueRequested: requested,
        estimatedValueOffered: offered,
        offeredServiceId: offerMode === 'service' ? offerServiceId : null,
        offeredDescription: offerMode === 'describe' ? offerDesc : null,
      });
      toast.success(
        iPayOnPropose
          ? `Proposta de troca enviada — ${brl(diff)} de torna reservados`
          : 'Proposta de troca enviada!',
      );
      setOpen(false);
      setTargetId(0);
      setOfferDesc('');
      setOfferValue('');
      setRequestedValue('');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao propor troca');
      // Preço do catálogo mudou: a lista é buscada de novo e a tela mostra o valor atual.
      if ((er as { code?: string } | null)?.code === 'estimate_mismatch') void services.refetch();
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
            Troque serviço por serviço. Quem recebe o serviço mais valioso paga a <b>torna</b>,
            reservada na carteira até os dois lados concluírem; a plataforma retém{' '}
            {Math.round(feeRate * 100)}% só sobre a torna.
          </>
        }
        action={
          barterEnabled ? (
            <BusinessButton
              variant={open ? 'secondary' : 'primary'}
              onClick={() => setOpen((o) => !o)}
              disabled={others.length === 0}
            >
              <Plus size={16} /> {open ? 'Fechar' : 'Propor troca'}
            </BusinessButton>
          ) : null
        }
      />

      {!barterEnabled && (
        <EmptyState>
          As trocas estão desativadas no momento. Trocas já propostas seguem o fluxo normal.
        </EmptyState>
      )}

      {open && barterEnabled && (
        <BusinessForm className="card" onSubmit={submit}>
          <h3>Nova proposta de troca</h3>
          <Field label="Eu quero (serviço de outro freelancer)">
            <Select value={targetId} onChange={(e) => setTargetId(Number(e.target.value))} required>
              <option value={0} disabled>
                Selecione um serviço…
              </option>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} — {priceLabel(s)}
                </option>
              ))}
            </Select>
          </Field>

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
            <Field label="Serviço que ofereço">
              <Select
                value={offerServiceId}
                onChange={(e) => setOfferServiceId(Number(e.target.value))}
                required
              >
                <option value={0} disabled>
                  {mine.length ? 'Selecione…' : 'Você ainda não tem serviços'}
                </option>
                {mine.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} — {priceLabel(s)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="O que ofereço">
              <Input
                value={offerDesc}
                onChange={(e) => setOfferDesc(e.target.value)}
                placeholder="Ex.: edição de 3 vídeos curtos"
                required
                minLength={3}
              />
            </Field>
          )}

          {askOffered && (
            <Field label="Valor estimado da minha oferta (R$)">
              <Input
                type="number"
                min={1}
                step="0.01"
                value={offerValue}
                onChange={(e) => setOfferValue(e.target.value)}
                required
              />
            </Field>
          )}

          {askRequested && (
            <Field label="Valor do serviço que eu quero, nesta troca (R$)">
              <Input
                type="number"
                min={1}
                step="0.01"
                value={requestedValue}
                onChange={(e) => setRequestedValue(e.target.value)}
                required
              />
            </Field>
          )}
          {(askOffered || askRequested) && (
            <p className="muted tiny" data-testid="barter-informed-hint">
              Sem preço fechado no catálogo (a combinar, por hora ou oferta descrita), o valor é o
              que você informa, e quem recebe a proposta vê que ele foi informado. Com preço
              fechado, o sistema usa o do catálogo.
            </p>
          )}

          {target && offerReady && offered > 0 && requested > 0 && (
            <div className="summary" data-testid="barter-estimate">
              <span className="muted tiny">
                {`Valores estimados: você oferece ${brl(offered)} (${sourceOf(offeredCatalog)}) e quer ${brl(requested)} (${sourceOf(requestedCatalog)})`}
              </span>
              <strong>{tornaHint}</strong>
              <span className="muted tiny">
                {diff > 0 ? `taxa ${brl(fee)} sobre a torna` : 'sem taxa'} · você recebe{' '}
                {brl(requested)} em serviço por {brl(offered)}
              </span>
            </div>
          )}

          {missing > 0 && (
            <div className="demo-box" data-testid="needs-deposit">
              <div>
                <strong>Falta {brl(missing)} na sua carteira para reservar a torna</strong>
                <div className="muted tiny">
                  Saldo {brl(balance)} · deposite via PIX sem sair daqui.
                </div>
              </div>
              <BusinessButton
                type="button"
                variant="secondary"
                onClick={() => setDepositFor(missing)}
              >
                <QrCode size={14} /> Depositar {brl(missing)}
              </BusinessButton>
            </div>
          )}

          <Button
            type="submit"
            disabled={
              propose.isPending ||
              !target ||
              !offerReady ||
              offered <= 0 ||
              requested <= 0 ||
              missing > 0
            }
          >
            {propose.isPending ? 'Enviando…' : 'Enviar proposta'}
          </Button>
        </BusinessForm>
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
          <div className="cards-grid swaps">
            {d.items.map((b: BarterAgreement) => {
              const iAmProposer = b.proposerId === myId;
              const iAmReceiver = b.receiverId === myId;
              const iPayTorna = b.cashPayerId === myId;
              const tornaLine =
                b.cashDifference <= 0
                  ? 'Sem torna'
                  : iPayTorna
                    ? `Você paga ${brl(b.cashDifference)} de torna`
                    : `Você recebe ${brl(b.tornaNet)} de torna (taxa ${brl(b.platformFee)})`;
              const tornaState = TORNA_STATUS_LABEL[b.tornaStatus] ?? '';
              // Receptor paga a torna e ainda não a reservou: precisa de saldo para aceitar.
              const mustFund =
                iAmReceiver &&
                iPayTorna &&
                b.status === 'proposed' &&
                b.tornaStatus === 'pending' &&
                balance < b.cashDifference;
              return (
                <div key={b.id} className="card service" data-testid={`barter-${b.id}`}>
                  <div className="svc-top">
                    <span className="chip rank">{iAmProposer ? 'Você propôs' : 'Recebida'}</span>
                    <span className={`pill ${pillClass(b.status)}`}>
                      {BARTER_STATUS_LABEL[b.status] ?? b.status}
                    </span>
                  </div>
                  <div className="swap">
                    <div className="swap-side">
                      <span className="muted tiny">
                        {iAmProposer ? 'Você oferece' : 'Oferecem'}
                      </span>
                      <strong>
                        {svcLabel(b.offeredServiceId, b.offeredServiceTitle, b.offeredDescription)}
                      </strong>
                      <span className="price">{brl(b.estimatedValueOffered)}</span>
                      {b.offeredValueSource && (
                        <span className="muted tiny" data-testid="offered-source">
                          {SOURCE_LABEL[b.offeredValueSource]}
                        </span>
                      )}
                    </div>
                    <span className="arrow">
                      <ArrowLeftRight size={18} />
                    </span>
                    <div className="swap-side">
                      <span className="muted tiny">{iAmProposer ? 'Você recebe' : 'Querem'}</span>
                      <strong>
                        {svcLabel(
                          b.requestedServiceId,
                          b.requestedServiceTitle,
                          b.requestedDescription,
                        )}
                      </strong>
                      <span className="price">{brl(b.estimatedValueRequested)}</span>
                      {b.requestedValueSource && (
                        <span className="muted tiny" data-testid="requested-source">
                          {SOURCE_LABEL[b.requestedValueSource]}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="svc-foot">
                    <span className="muted tiny">
                      {tornaLine}
                      {tornaState ? ` · ${tornaState}` : ''}
                    </span>
                    <span className="muted tiny">{dt(b.createdAt)}</span>
                  </div>
                  {b.status === 'active' && (
                    <p className="ok">2 contratos recíprocos gerados — acompanhe em Início</p>
                  )}
                  {b.status === 'proposed' && (
                    <div className="svc-actions">
                      {iAmReceiver && mustFund && (
                        <BusinessButton
                          variant="mini"
                          onClick={() => setDepositFor(round2(b.cashDifference - balance))}
                        >
                          <QrCode size={14} /> Depositar {brl(round2(b.cashDifference - balance))}{' '}
                          para aceitar
                        </BusinessButton>
                      )}
                      {iAmReceiver && !mustFund && (
                        <BusinessButton
                          variant="mini"
                          disabled={act.isPending}
                          onClick={() => void run(b.id, 'accept')}
                        >
                          Aceitar
                        </BusinessButton>
                      )}
                      {iAmReceiver && (
                        <BusinessButton
                          variant="mini"
                          disabled={act.isPending}
                          onClick={() => void run(b.id, 'reject')}
                        >
                          Recusar
                        </BusinessButton>
                      )}
                      {iAmProposer && (
                        <BusinessButton
                          variant="mini"
                          disabled={act.isPending}
                          onClick={() => void run(b.id, 'cancel')}
                        >
                          Cancelar
                        </BusinessButton>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </QueryState>

      {depositFor != null && (
        <DepositModal
          suggestedAmount={depositFor}
          onClose={() => setDepositFor(null)}
          onPaid={() => setDepositFor(null)}
        />
      )}
    </div>
  );
}
