import { ArrowDownToLine, Coins, Landmark, Lock, MailWarning, QrCode, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { CreditReason, Deposit, WalletTransaction } from '@escambo/types';
import { Button, Field, Input, PageHeader, QueryState } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
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
  useRequestWithdrawal,
  useWallet,
  useWalletTransactions,
  useWithdrawals,
} from '../../lib/hooks';
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
  const { user } = useAuth();
  const wallet = useWallet();
  const withdrawals = useWithdrawals();
  const deposits = useDeposits();
  const ledger = useWalletTransactions();
  const creditTx = useCreditTransactions();
  const request = useRequestWithdrawal();
  const cancelWithdrawal = useCancelWithdrawal();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [pixKey, setPixKey] = useState('');
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
    try {
      await request.mutateAsync({ amount: Number(amount), method: 'pix', pixKey });
      toast.success('Saque solicitado! Você recebe um aviso quando for pago.');
      setAmount('');
      setPixKey('');
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
          <Button type="button" onClick={() => setDepositing({})}>
            <QrCode size={16} /> Depositar
          </Button>
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
          <span className="muted tiny">para contratar ou sacar via PIX</span>
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
          <form className="kpi" onSubmit={submit}>
            <div className="kpi-top">
              <span className="kpi-ico">
                <Landmark size={18} />
              </span>
              <span className="kpi-label">Solicitar saque</span>
            </div>
            <Field label="Valor (R$)">
              <Input
                type="number"
                min={20}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </Field>
            <Field label="Chave PIX">
              <Input
                value={pixKey}
                onChange={(e) => setPixKey(e.target.value)}
                required
                placeholder="e-mail / telefone / aleatória"
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={request.isPending}>
              {request.isPending ? '…' : 'Sacar (mín. R$20)'}
            </Button>
          </form>
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
            <QueryState
              isLoading={ledger.isLoading}
              error={ledger.error}
              data={ledger.data}
              isEmpty={(d) => d.items.length === 0}
              empty="Nenhuma movimentação em reais ainda. Faça um depósito para contratar."
              onRetry={() => void ledger.refetch()}
            >
              {(d) => (
                <ul className="list credit-tx" data-testid="ledger">
                  {d.items.map((t) => (
                    <LedgerRow key={t.id} t={t} />
                  ))}
                </ul>
              )}
            </QueryState>
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
                          <Button
                            variant="mini"
                            type="button"
                            onClick={() => void cancel(x.id)}
                            disabled={cancelWithdrawal.isPending}
                          >
                            Cancelar
                          </Button>
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
