import { useState, type FormEvent } from 'react';
import { Button, Field, Input, PageHeader, QueryState } from '../../components/ui';
import { brl } from '../../lib/format';
import { useRequestWithdrawal, useWallet, useWithdrawals } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

export function CarteiraView() {
  const wallet = useWallet();
  const withdrawals = useWithdrawals();
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
    <div className="view">
      <PageHeader title="Carteira" />
      <div className="grid">
        <section className="card">
          <h3>💰 Saldo</h3>
          <p className="big">{w ? brl(w.balance) : '—'}</p>
          <p className="muted">disponível para saque</p>
          <div className="escrow">
            🔒 {w ? brl(w.balancePending) : '—'} <span>retido em escrow</span>
          </div>
        </section>

        <section className="card">
          <h3>🪙 Créditos Escambo</h3>
          <p className="big">{w ? `${w.credits}` : '—'}</p>
          <p className="muted">créditos para trocar por serviços</p>
          {w && w.creditsPending > 0 && (
            <div className="escrow">
              🔒 {w.creditsPending} <span>créditos em escrow</span>
            </div>
          )}
        </section>

        <form className="card" onSubmit={submit}>
          <h3>🏧 Solicitar saque</h3>
          <Field label="Valor (R$)">
            <Input type="number" min={20} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Chave PIX">
            <Input value={pixKey} onChange={(e) => setPixKey(e.target.value)} required placeholder="e-mail / telefone / aleatória" />
          </Field>
          <Button type="submit" disabled={request.isPending}>
            {request.isPending ? '…' : 'Sacar (mín. R$20)'}
          </Button>
        </form>

        <section className="card wide">
          <h3>Histórico de saques</h3>
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
                      <span className="muted"> · {x.method} · {x.maskedDestination}</span>
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
