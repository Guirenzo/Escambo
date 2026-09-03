import { Coins, Landmark, Lock, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { CreditReason } from '@escambo/types';
import { Button, Field, Input, PageHeader, QueryState } from '../../components/ui';
import { brl, dtm } from '../../lib/format';
import { useCreditTransactions, useRequestWithdrawal, useWallet, useWithdrawals } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

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

export function CarteiraView() {
  const wallet = useWallet();
  const withdrawals = useWithdrawals();
  const creditTx = useCreditTransactions();
  const request = useRequestWithdrawal();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [pixKey, setPixKey] = useState('');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await request.mutateAsync({ amount: Number(amount), method: 'pix', pixKey });
      toast.success('Saque solicitado!');
      setAmount('');
      setPixKey('');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro no saque');
    }
  }

  const w = wallet.data;

  return (
    <div className="page">
      <PageHeader title="Carteira" subtitle="Saldo em reais, créditos Escambo e movimentações." />

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Wallet size={18} />
            </span>
            <span className="kpi-label">Saldo disponível</span>
          </div>
          <strong className="kpi-value">{w ? brl(w.balance) : '—'}</strong>
          <span className="muted tiny">para saque via PIX</span>
        </div>
        <div className="kpi amber">
          <div className="kpi-top">
            <span className="kpi-ico">
              <Lock size={18} />
            </span>
            <span className="kpi-label">Em escrow</span>
          </div>
          <strong className="kpi-value">{w ? brl(w.balancePending) : '—'}</strong>
          <span className="muted tiny">liberado quando o cliente aprova</span>
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
            {w && w.creditsPending > 0 ? `${w.creditsPending} em escrow · ` : ''}para contratar ou impulsionar
          </span>
        </div>
        <form className="kpi" onSubmit={submit}>
          <div className="kpi-top">
            <span className="kpi-ico">
              <Landmark size={18} />
            </span>
            <span className="kpi-label">Solicitar saque</span>
          </div>
          <Field label="Valor (R$)">
            <Input type="number" min={20} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Chave PIX">
            <Input value={pixKey} onChange={(e) => setPixKey(e.target.value)} required placeholder="e-mail / telefone / aleatória" />
          </Field>
          <Button type="submit" variant="secondary" disabled={request.isPending}>
            {request.isPending ? '…' : 'Sacar (mín. R$20)'}
          </Button>
        </form>
      </div>

      <div className="two-col">
        <section className="card">
          <div className="card-head">
            <h3>
              <Coins size={16} /> Extrato de créditos
            </h3>
          </div>
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
                        {t.contractId != null ? ` · contrato #${t.contractId}` : ''} · saldo após: {t.balanceAfter}
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
        </section>

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
              <ul className="list">
                {d.items.map((x) => (
                  <li key={x.id}>
                    <div>
                      <strong>{brl(x.amount)}</strong>
                      <div className="muted tiny">
                        {x.method} · {x.maskedDestination}
                      </div>
                    </div>
                    <span className="pill">{x.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </section>
      </div>
    </div>
  );
}
