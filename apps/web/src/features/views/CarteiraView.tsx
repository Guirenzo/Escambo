import { BusinessButton, BusinessForm } from '../../components/BusinessActions';
import { ArrowDownToLine, Coins, Landmark, Lock, MailWarning, QrCode, Wallet } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import type {
  CreateWithdrawalRequest,
  CreditReason,
  Deposit,
  WalletTransaction,
  WithdrawalMethod,
} from '@escambo/types';
import { Button, Field, Input, PageHeader, QueryState, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import {
  brl,
  DEPOSIT_STATUS_LABEL,
  dtm,
  WALLET_REASON_LABEL,
  WITHDRAWAL_STATUS_LABEL,
  WITHDRAWAL_STATUS_TONE,
} from '../../lib/format';
import {
  useCancelWithdrawal,
  useCreditTransactions,
  useDeposits,
  usePublicSettings,
  useRequestWithdrawal,
  useWallet,
  useWalletTransactions,
  useWithdrawals,
} from '../../lib/hooks';
import { timezoneLabel } from '../../lib/timezones';
import { useToast } from '../../lib/toast';
import { DepositModal } from '../wallet/DepositModal';

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
  return (
    <li>
      <div>
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
  const minWithdrawal = usePublicSettings().data?.minWithdrawalAmount ?? 20;
  const withdrawals = useWithdrawals();
  const deposits = useDeposits();
  // Período do extrato de R$ (RF-047): dias no fuso da conta; vazio = sem limite daquele lado.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const invalidPeriod = from !== '' && to !== '' && from > to;
  const ledger = useWalletTransactions({ from, to });
  // As páginas juntas; um lançamento novo no meio da paginação não aparece duas vezes.
  const ledgerItems = useMemo(() => {
    const seen = new Set<number>();
    return (ledger.data?.pages ?? [])
      .flatMap((p) => p.items)
      .filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
  }, [ledger.data]);
  const creditTx = useCreditTransactions();
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
      await request.mutateAsync(body);
      toast.success('Saque solicitado! Você recebe um aviso quando for pago.');
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

  return (
    <div className="page">
      <PageHeader
        title="Carteira"
        subtitle="Saldo em reais, créditos Escambo, depósitos, extrato e saques."
        action={
          <BusinessButton type="button" onClick={() => setDepositing({})}>
            <QrCode size={16} /> Depositar
          </BusinessButton>
        }
      />

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Wallet size={18} />
            </span>
            <span className="kpi-label">Saldo disponível</span>
          </div>
          <strong className="kpi-value" data-testid="wallet-balance">
            {w ? brl(w.balance) : '—'}
          </strong>
          <span className="muted tiny">para contratar ou sacar (PIX ou transferência)</span>
        </div>
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
        {!canWithdraw && (
          <div className="kpi withdraw-locked" data-testid="withdraw-locked">
            <div className="kpi-top">
              <span className="kpi-ico">
                <Landmark size={18} />
              </span>
              <span className="kpi-label">Solicitar saque</span>
            </div>
            <p className="withdraw-locked-msg">
              <MailWarning size={16} />
              <span>
                Confirme seu e-mail para sacar. Enviamos um link para <strong>{user?.email}</strong>
                .
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
          </div>
        )}
        {canWithdraw && (
          <BusinessForm className="kpi" onSubmit={submit}>
            <div className="kpi-top">
              <span className="kpi-ico">
                <Landmark size={18} />
              </span>
              <span className="kpi-label">Solicitar saque</span>
            </div>
            <Field label={`Valor (R$) · mínimo ${brl(minWithdrawal)}`}>
              <Input
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
      </div>

      <div className="two-col">
        <section className="card">
          <div className="card-head">
            <h3>
              <ArrowDownToLine size={16} /> Extrato
            </h3>
            <div className="tabs tabs-mini" role="tablist" aria-label="Moeda do extrato">
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
          {tab === 'brl' ? (
            <>
              <div className="filters-bar" role="group" aria-label="Período do extrato">
                <label className="filter">
                  De
                  <input
                    type="date"
                    value={from}
                    max={to || undefined}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label className="filter">
                  Até
                  <input
                    type="date"
                    value={to}
                    min={from || undefined}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
                {(from || to) && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setFrom('');
                      setTo('');
                    }}
                  >
                    Limpar período
                  </Button>
                )}
              </div>
              <p className="muted tiny">Dias no horário de {timezoneLabel(user?.timezone)}.</p>
              {invalidPeriod ? (
                <p role="alert">A data inicial precisa ser até a final.</p>
              ) : (
                <QueryState
                  isLoading={ledger.isLoading}
                  error={ledger.error}
                  data={ledger.data ? ledgerItems : undefined}
                  isEmpty={(d) => d.length === 0}
                  empty={
                    from || to
                      ? 'Nenhuma movimentação em reais nesse período.'
                      : 'Nenhuma movimentação em reais ainda. Faça um depósito para contratar.'
                  }
                  onRetry={() => void ledger.refetch()}
                >
                  {(items) => (
                    <>
                      <ul className="list credit-tx" data-testid="ledger">
                        {items.map((t) => (
                          <LedgerRow key={t.id} t={t} />
                        ))}
                      </ul>
                      {ledger.hasNextPage && (
                        <div className="center">
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => void ledger.fetchNextPage()}
                            disabled={ledger.isFetchingNextPage}
                          >
                            {ledger.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </QueryState>
              )}
            </>
          ) : (
            <QueryState
              isLoading={creditTx.isLoading}
              error={creditTx.error}
              data={creditTx.data}
              isEmpty={(d) => d.items.length === 0}
              empty="Nenhuma movimentação de créditos ainda."
              onRetry={() => void creditTx.refetch()}
            >
              {(d) => (
                <ul className="list credit-tx">
                  {d.items.map((t) => (
                    <li key={t.id}>
                      <div>
                        <strong>{REASON_LABEL[t.reason] ?? t.reason}</strong>
                        <div className="muted tiny">
                          {dtm(t.createdAt)}
                          {t.contractId != null ? ` · contrato #${t.contractId}` : ''} · saldo após:{' '}
                          {t.balanceAfter}
                        </div>
                      </div>
                      <span className={`amt ${t.amount >= 0 ? 'pos' : 'neg'}`}>
                        {t.amount >= 0 ? '+' : ''}
                        {t.amount}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
          )}
        </section>

        <div className="stack">
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
