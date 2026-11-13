import { BusinessButton, BusinessForm } from '../../components/BusinessActions';
import {
  useEmailVerified,
  useVerifiedEmailGate,
  VerifyEmailNotice,
} from '../../components/VerifyEmail';
import {
  ArrowLeftRight,
  Code,
  Coins,
  Handshake,
  Palette,
  PenLine,
  Plus,
  QrCode,
  Scale,
  Search,
  type LucideIcon,
} from 'lucide-react';
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
import { categoryArt, useCategoryRoots } from '../services/categoryArt';
import { packagesOf } from '../services/packages';

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

/**
 * De onde vem o valor que a tela mostra antes de enviar. Serviço com pacotes (RF-086) entra na
 * troca pelo Básico, o preço do anúncio (ADR 69): a tela diz qual pacote vale.
 */
const sourceOf = (catalog: number | null, s?: Service): string =>
  catalog === null
    ? 'informado por você'
    : s && packagesOf(s).length > 0
      ? 'preço do pacote Básico'
      : SOURCE_LABEL.catalog;

/** Preço como o catálogo mostra: fechado (o do Básico, com pacotes), por hora ou a combinar. */
const priceLabel = (s: Service): string =>
  s.price == null || s.priceType === 'negotiable'
    ? 'a combinar'
    : s.priceType === 'hourly'
      ? `${brl(s.price)}/h`
      : packagesOf(s).length > 0
        ? `${brl(s.price)}, pacote Básico`
        : brl(s.price);

/** As trocas fechadas (os dois lados viram figurinhas coladas) e as que não foram adiante. */
const STUCK = new Set(['accepted', 'active', 'completed']);
const OFF = new Set(['rejected', 'cancelled']);

interface TradeSideData {
  Icon: LucideIcon;
  title: string;
  value: number;
  source?: BarterValueSource;
  sourceTestId: string;
}

/**
 * Um lado da troca no cartão: o desenho do ofício (decorativo), o que é, quanto vale e de onde
 * veio o valor. `tone` diz se é o que a pessoa entrega ou o que recebe.
 */
function TradeSide({
  label,
  tone,
  side,
}: {
  label: string;
  tone: 'give' | 'get';
  side: TradeSideData;
}) {
  const { Icon } = side;
  return (
    <div className={`trade-side trade-side-${tone}`}>
      <span className="trade-side-art" aria-hidden="true">
        <Icon size={22} strokeWidth={1.75} />
      </span>
      <span className="trade-label">{label}</span>
      <strong className="trade-title">{side.title}</strong>
      <span className="price">{brl(side.value)}</span>
      {side.source && (
        <span className="muted tiny" data-testid={side.sourceTestId}>
          {SOURCE_LABEL[side.source]}
        </span>
      )}
    </div>
  );
}

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
  // Propor e aceitar troca exigem e-mail confirmado (RF-006); recusar e cancelar, não.
  const verified = useEmailVerified();
  const gate = useVerifiedEmailGate();

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
  const roots = useCategoryRoots();
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

  /** O ofício de um serviço do catálogo; sem serviço (oferta descrita), o lápis. */
  const sideIcon = (id: number | null): LucideIcon => {
    if (id == null) return PenLine;
    const service = serviceById.get(id);
    return categoryArt(service ? roots.get(service.categoryId)?.slug : null).Icon;
  };

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
        subtitle="Serviço por serviço, com a diferença em dinheiro protegida até o fim."
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

      {/* Como a troca funciona: texto sobre o verde sólido; ao lado, duas figurinhas de ofício e a
          moeda da troca no meio (ilustração, some no celular). */}
      <section className="trade-hero" aria-labelledby="trade-hero-title">
        <div className="trade-hero-text">
          <h2 id="trade-hero-title">Como funciona a troca</h2>
          <p>
            Troque serviço por serviço. Quem recebe o serviço mais valioso paga a <b>torna</b>,
            reservada na carteira até os dois lados concluírem; a plataforma retém{' '}
            {Math.round(feeRate * 100)}% só sobre a torna.
          </p>
          <ol className="trade-steps">
            <li>
              <span aria-hidden="true">
                <Search size={16} />
              </span>{' '}
              Você escolhe o serviço que quer e oferece um seu
            </li>
            <li>
              <span aria-hidden="true">
                <Scale size={16} />
              </span>{' '}
              A diferença de valor vira a torna, guardada em escrow
            </li>
            <li>
              <span aria-hidden="true">
                <Handshake size={16} />
              </span>{' '}
              Aceita a troca, nascem os dois contratos
            </li>
          </ol>
        </div>
        <div className="trade-hero-art" aria-hidden="true">
          <span className="th-sticker al-g-lilac">
            <Palette strokeWidth={1.75} />
          </span>
          <span className="th-coin">
            <ArrowLeftRight size={22} />
          </span>
          <span className="th-sticker al-g-sky">
            <Code strokeWidth={1.75} />
          </span>
        </div>
      </section>

      {!barterEnabled && (
        <EmptyState>
          As trocas estão desativadas no momento. Trocas já propostas seguem o fluxo normal.
        </EmptyState>
      )}

      {open && barterEnabled && !verified && (
        <section className="card" aria-labelledby="trade-new-title">
          <h3 id="trade-new-title">Nova proposta de troca</h3>
          <VerifyEmailNotice action="propor uma troca" />
        </section>
      )}

      {open && barterEnabled && verified && (
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
                {`Valores estimados: você oferece ${brl(offered)} (${sourceOf(offeredCatalog, offerService)}) e quer ${brl(requested)} (${sourceOf(requestedCatalog, target)})`}
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
          <div className="trade-grid">
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
              // O desenho de cada lado: o ofício do serviço do catálogo ou, na oferta descrita, o
              // lápis.
              const offeredSide: TradeSideData = {
                Icon: sideIcon(b.offeredServiceId),
                title: svcLabel(b.offeredServiceId, b.offeredServiceTitle, b.offeredDescription),
                value: b.estimatedValueOffered,
                source: b.offeredValueSource,
                sourceTestId: 'offered-source',
              };
              const requestedSide: TradeSideData = {
                Icon: sideIcon(b.requestedServiceId),
                title: svcLabel(
                  b.requestedServiceId,
                  b.requestedServiceTitle,
                  b.requestedDescription,
                ),
                value: b.estimatedValueRequested,
                source: b.requestedValueSource,
                sourceTestId: 'requested-source',
              };
              const state = STUCK.has(b.status) ? ' is-stuck' : OFF.has(b.status) ? ' is-off' : '';
              return (
                <article
                  key={b.id}
                  className={`trade-card${b.status === 'proposed' ? ' is-open' : ''}${state}`}
                  data-testid={`barter-${b.id}`}
                  aria-label={`Troca de ${dt(b.createdAt)}`}
                >
                  <div className="trade-top">
                    <span className="chip rank">{iAmProposer ? 'Você propôs' : 'Recebida'}</span>
                    <span className={`pill ${pillClass(b.status)}`}>
                      {BARTER_STATUS_LABEL[b.status] ?? b.status}
                    </span>
                    <span className="muted tiny trade-date">{dt(b.createdAt)}</span>
                  </div>
                  {/* Sempre do ponto de vista de quem lê: primeiro o que você oferece, depois o que
                      recebe. Para quem recebeu a proposta, o lado oferecido é o que ele recebe. */}
                  <div className="trade-swap">
                    <TradeSide
                      label="Você oferece"
                      tone="give"
                      side={iAmProposer ? offeredSide : requestedSide}
                    />
                    <span className="trade-arrow" aria-hidden="true">
                      <ArrowLeftRight size={20} />
                    </span>
                    <TradeSide
                      label="Você recebe"
                      tone="get"
                      side={iAmProposer ? requestedSide : offeredSide}
                    />
                  </div>
                  <p
                    className={`trade-torna${b.cashDifference <= 0 ? ' even' : iPayTorna ? ' pay' : ' get'}`}
                  >
                    <span className="trade-torna-ico" aria-hidden="true">
                      <Coins size={16} />
                    </span>
                    <span>
                      {tornaLine}
                      {tornaState ? ` · ${tornaState}` : ''}
                    </span>
                  </p>
                  {b.status === 'active' && (
                    <p className="ok trade-note">
                      2 contratos recíprocos gerados — acompanhe em Início
                    </p>
                  )}
                  {b.status === 'proposed' && (
                    <div className="trade-actions">
                      {iAmReceiver && mustFund && (
                        <BusinessButton
                          onClick={() => setDepositFor(round2(b.cashDifference - balance))}
                        >
                          <QrCode size={14} /> Depositar {brl(round2(b.cashDifference - balance))}{' '}
                          para aceitar
                        </BusinessButton>
                      )}
                      {iAmReceiver && !mustFund && (
                        <BusinessButton
                          disabled={act.isPending}
                          onClick={() => gate.guard('aceitar a troca', () => run(b.id, 'accept'))}
                        >
                          Aceitar
                        </BusinessButton>
                      )}
                      {iAmReceiver && (
                        <BusinessButton
                          variant="secondary"
                          disabled={act.isPending}
                          onClick={() => void run(b.id, 'reject')}
                        >
                          Recusar
                        </BusinessButton>
                      )}
                      {iAmProposer && (
                        <BusinessButton
                          variant="secondary"
                          disabled={act.isPending}
                          onClick={() => void run(b.id, 'cancel')}
                        >
                          Cancelar
                        </BusinessButton>
                      )}
                    </div>
                  )}
                </article>
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
      {gate.dialog}
    </div>
  );
}
