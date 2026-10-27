import { BrandMark } from '../../components/BrandMark';
import { BusinessButton, BusinessForm } from '../../components/BusinessActions';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowUpRight,
  Coins,
  IdCard,
  Landmark,
  Lock,
  MailWarning,
  QrCode,
  Wallet,
} from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  CreateWithdrawalRequest,
  CreditReason,
  Deposit,
  WalletTransaction,
  Withdrawal,
  WithdrawalMethod,
} from '@escambo/types';
import {
  Button,
  Field,
  Input,
  onTablistKeyDown,
  PageHeader,
  QueryState,
  Select,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  businessDaysLabel,
  DEFAULT_WITHDRAWAL_BUSINESS_DAYS,
  dueDayText,
  withdrawalDueAt,
} from '../../lib/business-days';
import { usePageTitle } from '../../lib/title';
import { scrollBehavior } from '../../lib/motion';
import {
  brl,
  DEPOSIT_STATUS_LABEL,
  dtm,
  WALLET_REASON_LABEL,
  WITHDRAWAL_STATUS_LABEL,
  WITHDRAWAL_STATUS_TONE,
} from '../../lib/format';
import { identityName } from '../../lib/documents';
import {
  useCancelWithdrawal,
  useCpfStatus,
  useCreditTransactions,
  useDeposits,
  useProfilesMe,
  usePublicSettings,
  useRequestWithdrawal,
  useWallet,
  useWalletTransactions,
  useWithdrawals,
} from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { DepositModal } from '../wallet/DepositModal';
import { EarningsSection } from '../wallet/EarningsSection';
import {
  isInvertedPeriod,
  LoadMore,
  NO_PERIOD,
  PeriodFilter,
  uniqueItems,
  type LedgerPeriod,
} from '../wallet/LedgerControls';

const REASON_LABEL: Record<CreditReason, string> = {
  welcome: 'Bônus de boas-vindas',
  escrow_hold: 'Retido para contratação',
  escrow_in: 'Recebido em escrow',
  escrow_release: 'Liberado',
  escrow_refund: 'Estorno do escrow',
  refund: 'Reembolso',
  grant: 'Crédito concedido',
  boost: 'Impulsionamento',
};

/** Saque ainda não pago (aguardando ou em processamento): é o que tem prazo a cumprir. */
const isOpen = (w: Withdrawal): boolean => w.status === 'requested' || w.status === 'processing';

/**
 * O prazo de um saque aberto (RN-035), no calendário de Brasília: "cai até qua, 21/10", ou
 * "prazo era qua, 21/10" quando já passou sem o pagamento.
 */
function dueNote(w: Withdrawal, now: number): string {
  if (!w.dueAt || !isOpen(w)) return '';
  const day = dueDayText(w.dueAt);
  return new Date(w.dueAt).getTime() < now ? ` · prazo era ${day}` : ` · cai até ${day}`;
}

/** Uma linha do extrato de R$: movimento do disponível ou, quando só o retido muda, do retido. */
function LedgerRow({ t }: { t: WalletTransaction }) {
  const heldOnly = t.amount === 0 && t.pendingDelta !== 0;
  const value = heldOnly ? t.pendingDelta : t.amount;
  const ref =
    t.contractId != null
      ? ` · contrato #${t.contractId}`
      : t.withdrawalId != null
        ? ` · saque #${t.withdrawalId}`
        : t.paymentId != null
          ? ` · depósito #${t.paymentId}`
          : '';
  const Icon = heldOnly ? Lock : value >= 0 ? ArrowDownLeft : ArrowUpRight;
  return (
    <li>
      <span
        className={`tx-ico ${heldOnly ? 'held' : value >= 0 ? 'in' : 'out'}`}
        aria-hidden="true"
      >
        <Icon size={16} />
      </span>
      <div className="tx-text">
        <strong>{WALLET_REASON_LABEL[t.reason] ?? t.reason}</strong>
        <div className="muted tiny">
          {dtm(t.createdAt)}
          {ref} · disponível {brl(t.balanceAfter)}
          {t.pendingAfter > 0 ? ` · retido ${brl(t.pendingAfter)}` : ''}
        </div>
      </div>
      <span className={`amt ${value >= 0 ? 'pos' : 'neg'} ${heldOnly ? 'held' : ''}`}>
        {heldOnly && <Lock size={12} aria-label="retido" />}
        {value >= 0 ? '+' : '−'}
        {brl(Math.abs(value))}
      </span>
    </li>
  );
}

export function CarteiraView() {
  usePageTitle('Carteira');
  const { user } = useAuth();
  const wallet = useWallet();
  const settings = usePublicSettings().data;
  const minWithdrawal = settings?.minWithdrawalAmount ?? 20;
  const withdrawals = useWithdrawals();
  const deposits = useDeposits();
  // Período dos extratos (RF-047), o mesmo nas duas abas: dias no fuso da conta.
  const [period, setPeriod] = useState<LedgerPeriod>(NO_PERIOD);
  const invalidPeriod = isInvertedPeriod(period);
  const filtered = period.from !== '' || period.to !== '';
  const ledger = useWalletTransactions(period);
  const ledgerItems = useMemo(() => uniqueItems(ledger.data?.pages), [ledger.data]);
  const creditTx = useCreditTransactions(period);
  const creditItems = useMemo(() => uniqueItems(creditTx.data?.pages), [creditTx.data]);
  const request = useRequestWithdrawal();
  const cancelWithdrawal = useCancelWithdrawal();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<WithdrawalMethod>('pix');
  const [pixKey, setPixKey] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAgency, setBankAgency] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [tab, setTab] = useState<'brl' | 'credits'>('brl');
  const [depositing, setDepositing] = useState<null | { initial?: Deposit }>(null);
  const [resending, setResending] = useState(false);
  // Saque é a única ação que tira dinheiro da plataforma: a API exige e-mail confirmado (403).
  const canWithdraw = user?.emailVerified ?? true;
  // E, de quem entrega trabalho, o CPF validado no Perfil (RF-020); sem a chave de cifragem no
  // servidor, nem dá para validar. Quem só contrata saca o que depositou sem CPF.
  const cpf = useCpfStatus().data;
  const cpfBlock: 'required' | 'unavailable' | null = !cpf?.required
    ? null
    : !cpf.available
      ? 'unavailable'
      : cpf.verified
        ? null
        : 'required';
  // Prazo da forma escolhida (RN-035): a previsão daqui; o que vale é o dueAt que a API grava.
  const businessDays =
    settings?.withdrawalBusinessDays?.[method] ?? DEFAULT_WITHDRAWAL_BUSINESS_DAYS[method];
  const now = Date.now();

  async function resend(): Promise<void> {
    setResending(true);
    try {
      await api.resendVerification();
      toast.success(`Link reenviado para ${user?.email ?? 'seu e-mail'}.`);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível reenviar');
    } finally {
      setResending(false);
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    // Só os dados do destino escolhido vão para a API (RF-045: PIX ou transferência bancária).
    const body: CreateWithdrawalRequest =
      method === 'pix'
        ? { amount: Number(amount), method, pixKey }
        : { amount: Number(amount), method, bankName, bankAgency, bankAccount };
    try {
      const created = await request.mutateAsync(body);
      toast.success(
        created.dueAt
          ? `Saque solicitado! Cai até ${dueDayText(created.dueAt)}. Você recebe um aviso quando for pago.`
          : 'Saque solicitado! Você recebe um aviso quando for pago.',
      );
      setAmount('');
      setPixKey('');
      setBankName('');
      setBankAgency('');
      setBankAccount('');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro no saque');
    }
  }

  async function cancel(id: number): Promise<void> {
    try {
      await cancelWithdrawal.mutateAsync(id);
      toast.success('Saque cancelado. O valor voltou para o saldo.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível cancelar');
    }
  }

  const w = wallet.data;
  const profiles = useProfilesMe();
  const owner = identityName(profiles.data, user?.email);

  /** "Pedir saque" leva ao formulário (o foco vai ao valor) ou, sem e-mail confirmado, ao aviso. */
  function goToWithdraw(): void {
    const target = document.getElementById('saque-valor') ?? document.getElementById('saque');
    target?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'center' });
    target?.focus({ preventScroll: true });
  }

  return (
    <div className="page">
      <PageHeader
        title="Carteira"
        subtitle="Saldo em reais, créditos Escambo, depósitos, extrato e saques."
      />

      <div className="wallet-top">
        {/* O saldo como um cartão de banco: texto branco sobre o verde sólido; os círculos do fundo
            são enfeite claro de opacidade baixa (o contraste continua acima de 12:1). */}
        <section className="bank-card" aria-labelledby="bank-card-label">
          <span className="bank-deco" aria-hidden="true" />
          <div className="bank-card-top">
            <span className="bank-brand">
              <BrandMark onDark className="bank-brand-mark" />
              Escambo
            </span>
            <span className="bank-chip" aria-hidden="true">
              <Wallet size={18} />
            </span>
          </div>
          <div className="bank-balance">
            <span className="bank-label" id="bank-card-label">
              Saldo disponível
            </span>
            <strong className="bank-value" data-testid="wallet-balance">
              {w ? brl(w.balance) : '—'}
            </strong>
            <span className="bank-hint">para contratar ou sacar (PIX ou transferência)</span>
          </div>
          <div className="bank-card-foot">
            <span className="bank-owner">{owner}</span>
            <div className="bank-actions">
              <BusinessButton type="button" className="amber" onClick={() => setDepositing({})}>
                <QrCode size={16} /> Depositar
              </BusinessButton>
              <button type="button" className="on-dark" onClick={goToWithdraw}>
                <Landmark size={16} aria-hidden="true" /> Pedir saque
              </button>
            </div>
          </div>
        </section>

        <div className="wallet-side">
          <div className="kpi amber">
            <div className="kpi-top">
              <span className="kpi-ico">
                <Lock size={18} />
              </span>
              <span className="kpi-label">Retido</span>
            </div>
            <strong className="kpi-value">{w ? brl(w.balancePending) : '—'}</strong>
            <span className="muted tiny">reservado em propostas ou em escrow</span>
          </div>
          <div className="kpi">
            <div className="kpi-top">
              <span className="kpi-ico">
                <Coins size={18} />
              </span>
              <span className="kpi-label">Créditos Escambo</span>
            </div>
            <strong className="kpi-value">{w ? String(w.credits) : '—'}</strong>
            <span className="muted tiny">
              {w && w.creditsPending > 0 ? `${w.creditsPending} em escrow · ` : ''}para contratar ou
              impulsionar
            </span>
          </div>
        </div>
      </div>

      {/* Ganhos por período (RF-082): só leitura do ledger; quem nunca recebeu vê o vazio. */}
      <EarningsSection />

      <div className="two-col">
        <section className="card">
          <div className="card-head">
            <h3>
              <ArrowDownToLine size={16} /> Extrato
            </h3>
            <div
              className="tabs tabs-mini"
              role="tablist"
              onKeyDown={onTablistKeyDown}
              aria-label="Moeda do extrato"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'brl'}
                className={tab === 'brl' ? 'active' : ''}
                onClick={() => setTab('brl')}
              >
                Reais
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'credits'}
                className={tab === 'credits' ? 'active' : ''}
                onClick={() => setTab('credits')}
              >
                Créditos
              </button>
            </div>
          </div>
          <PeriodFilter value={period} onChange={setPeriod} timezone={user?.timezone} />
          {invalidPeriod ? (
            <p role="alert">A data inicial precisa ser até a final.</p>
          ) : tab === 'brl' ? (
            <QueryState
              isLoading={ledger.isLoading}
              error={ledger.error}
              data={ledger.data ? ledgerItems : undefined}
              isEmpty={(d) => d.length === 0}
              empty={
                filtered
                  ? 'Nenhuma movimentação em reais nesse período.'
                  : 'Nenhuma movimentação em reais ainda. Faça um depósito para contratar.'
              }
              onRetry={() => void ledger.refetch()}
            >
              {(items) => (
                <>
                  <ul className="list credit-tx tx-list" data-testid="ledger">
                    {items.map((t) => (
                      <LedgerRow key={t.id} t={t} />
                    ))}
                  </ul>
                  <LoadMore query={ledger} />
                </>
              )}
            </QueryState>
          ) : (
            <QueryState
              isLoading={creditTx.isLoading}
              error={creditTx.error}
              data={creditTx.data ? creditItems : undefined}
              isEmpty={(d) => d.length === 0}
              empty={
                filtered
                  ? 'Nenhuma movimentação de créditos nesse período.'
                  : 'Nenhuma movimentação de créditos ainda.'
              }
              onRetry={() => void creditTx.refetch()}
            >
              {(items) => (
                <>
                  <ul className="list credit-tx tx-list" data-testid="credit-ledger">
                    {items.map((t) => (
                      <li key={t.id}>
                        <span
                          className={`tx-ico ${t.amount >= 0 ? 'in' : 'out'}`}
                          aria-hidden="true"
                        >
                          {t.amount >= 0 ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                        </span>
                        <div className="tx-text">
                          <strong>{REASON_LABEL[t.reason] ?? t.reason}</strong>
                          <div className="muted tiny">
                            {dtm(t.createdAt)}
                            {t.contractId != null ? ` · contrato #${t.contractId}` : ''} · saldo
                            após: {t.balanceAfter}
                          </div>
                        </div>
                        <span className={`amt ${t.amount >= 0 ? 'pos' : 'neg'}`}>
                          {t.amount >= 0 ? '+' : ''}
                          {t.amount}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <LoadMore query={creditTx} />
                </>
              )}
            </QueryState>
          )}
        </section>

        <div className="stack">
          {/* Saque num cartão próprio, fora da fileira de indicadores (o formulário ficava espremido). */}
          {!canWithdraw && (
            <section
              className="card withdraw-locked"
              data-testid="withdraw-locked"
              id="saque"
              tabIndex={-1}
              data-hash-target
            >
              <div className="card-head">
                <h3>
                  <Landmark size={16} /> Solicitar saque
                </h3>
              </div>
              <p className="withdraw-locked-msg">
                <MailWarning size={16} />
                <span>
                  Confirme seu e-mail para sacar. Enviamos um link para{' '}
                  <strong>{user?.email}</strong>.
                </span>
              </p>
              <span className="muted tiny">
                Segurança: o saque é a única ação que tira dinheiro da plataforma.
              </span>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void resend()}
                disabled={resending}
              >
                {resending ? 'Reenviando…' : 'Reenviar e-mail de confirmação'}
              </Button>
            </section>
          )}
          {canWithdraw && cpfBlock && (
            <section
              className="card withdraw-locked"
              data-testid="withdraw-cpf"
              id="saque"
              tabIndex={-1}
              data-hash-target
            >
              <div className="card-head">
                <h3>
                  <Landmark size={16} /> Solicitar saque
                </h3>
              </div>
              <p className="withdraw-locked-msg">
                <IdCard size={16} aria-hidden="true" />
                {cpfBlock === 'required' ? (
                  <span>
                    Valide seu CPF para sacar: o saque do que você recebe por trabalhos pede o CPF e
                    a data de nascimento, em Perfil, “Dados para receber”.
                  </span>
                ) : (
                  <span>
                    O saque do que você recebe por trabalhos pede o CPF validado, e a validação de
                    CPF ainda não está disponível neste servidor.
                  </span>
                )}
              </p>
              {cpfBlock === 'required' ? (
                <Link to="/perfil#dados-recebimento" className="btn secondary">
                  Informar o CPF
                </Link>
              ) : (
                <Link to="/suporte" className="btn secondary">
                  Falar com o suporte
                </Link>
              )}
            </section>
          )}
          {canWithdraw && !cpfBlock && (
            <BusinessForm className="card withdraw-form" onSubmit={submit} id="saque">
              <div className="card-head">
                <h3>
                  <Landmark size={16} /> Solicitar saque
                </h3>
              </div>
              <Field label={`Valor (R$) · mínimo ${brl(minWithdrawal)}`}>
                <Input
                  id="saque-valor"
                  type="number"
                  min={minWithdrawal}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </Field>
              <Field label="Receber por">
                <Select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as WithdrawalMethod)}
                >
                  <option value="pix">PIX</option>
                  <option value="bank">Transferência bancária</option>
                </Select>
              </Field>
              <p className="muted tiny" data-testid="withdraw-due">
                Em até {businessDaysLabel(businessDays)} (seg. a sex.): cai até{' '}
                {dueDayText(withdrawalDueAt(businessDays))}.
              </p>
              {method === 'pix' ? (
                <Field label="Chave PIX">
                  <Input
                    value={pixKey}
                    onChange={(e) => setPixKey(e.target.value)}
                    required
                    maxLength={255}
                    placeholder="e-mail / telefone / aleatória"
                  />
                </Field>
              ) : (
                <>
                  <Field label="Banco">
                    <Input
                      value={bankName}
                      onChange={(e) => setBankName(e.target.value)}
                      required
                      maxLength={100}
                      placeholder="nome ou código do banco"
                    />
                  </Field>
                  <Field label="Agência">
                    <Input
                      value={bankAgency}
                      onChange={(e) => setBankAgency(e.target.value)}
                      required
                      maxLength={10}
                      placeholder="sem o dígito"
                    />
                  </Field>
                  <Field label="Conta">
                    <Input
                      value={bankAccount}
                      onChange={(e) => setBankAccount(e.target.value)}
                      required
                      maxLength={20}
                      placeholder="com o dígito"
                    />
                  </Field>
                </>
              )}
              <Button type="submit" variant="secondary" disabled={request.isPending}>
                {request.isPending ? '…' : `Sacar (mín. ${brl(minWithdrawal)})`}
              </Button>
            </BusinessForm>
          )}
          <section className="card">
            <div className="card-head">
              <h3>
                <Landmark size={16} /> Saques
              </h3>
            </div>
            <QueryState
              isLoading={withdrawals.isLoading}
              error={withdrawals.error}
              data={withdrawals.data}
              isEmpty={(d) => d.items.length === 0}
              empty="Nenhum saque ainda."
              onRetry={() => void withdrawals.refetch()}
            >
              {(d) => (
                <ul className="list" data-testid="withdrawals">
                  {d.items.map((x) => (
                    <li key={x.id}>
                      <div>
                        <strong>{brl(x.amount)}</strong>
                        <div className="muted tiny">
                          {x.method === 'pix' ? 'PIX' : 'Conta'} · {x.maskedDestination} ·{' '}
                          {dtm(x.processedAt ?? x.createdAt)}
                          {dueNote(x, now)}
                        </div>
                      </div>
                      <div className="acts">
                        <span className={`pill status-${WITHDRAWAL_STATUS_TONE[x.status] ?? ''}`}>
                          {WITHDRAWAL_STATUS_LABEL[x.status] ?? x.status}
                        </span>
                        {x.status === 'requested' && (
                          <BusinessButton
                            variant="mini"
                            type="button"
                            onClick={() => void cancel(x.id)}
                            disabled={cancelWithdrawal.isPending}
                          >
                            Cancelar
                          </BusinessButton>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>
                <QrCode size={16} /> Depósitos
              </h3>
            </div>
            <QueryState
              isLoading={deposits.isLoading}
              error={deposits.error}
              data={deposits.data}
              isEmpty={(d) => d.items.length === 0}
              empty="Nenhum depósito ainda."
              onRetry={() => void deposits.refetch()}
            >
              {(d) => (
                <ul className="list" data-testid="deposits">
                  {d.items.slice(0, 6).map((x) => (
                    <li key={x.id}>
                      <div>
                        <strong>{brl(x.amount)}</strong>
                        <div className="muted tiny">PIX · {dtm(x.paidAt ?? x.createdAt)}</div>
                      </div>
                      <div className="acts">
                        <span
                          className={`pill status-${
                            x.status === 'paid'
                              ? 'completed'
                              : x.status === 'pending'
                                ? 'pending'
                                : 'cancelled'
                          }`}
                        >
                          {DEPOSIT_STATUS_LABEL[x.status] ?? x.status}
                        </span>
                        {x.status === 'pending' && (
                          <Button
                            variant="mini"
                            type="button"
                            onClick={() => setDepositing({ initial: x })}
                          >
                            Pagar
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
          </section>
        </div>
      </div>

      {depositing && (
        <DepositModal initial={depositing.initial ?? null} onClose={() => setDepositing(null)} />
      )}
    </div>
  );
}
