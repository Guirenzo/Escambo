import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Wallet, Withdrawal } from '@escambo/types';
import { api } from '../../lib/api';
import { brl } from '../../lib/format';

export function CarteiraView() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [list, setList] = useState<Withdrawal[]>([]);
  const [amount, setAmount] = useState('');
  const [pixKey, setPixKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.wallet().then(setWallet).catch(() => undefined);
    void api
      .withdrawals()
      .then((r) => setList(r.items))
      .catch(() => undefined);
  }, []);
  useEffect(() => load(), [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.requestWithdrawal({ amount: Number(amount), method: 'pix', pixKey });
      setOk('Saque solicitado!');
      setAmount('');
      setPixKey('');
      load();
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro no saque');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <h2>Carteira</h2>
      <div className="grid">
        <section className="card">
          <h3>💰 Saldo</h3>
          <p className="big">{wallet ? brl(wallet.balance) : '—'}</p>
          <p className="muted">disponível para saque</p>
          <div className="escrow">
            🔒 {wallet ? brl(wallet.balancePending) : '—'} <span>retido em escrow</span>
          </div>
        </section>

        <form className="card" onSubmit={submit}>
          <h3>🏧 Solicitar saque</h3>
          <label>
            Valor (R$)
            <input type="number" min={20} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          <label>
            Chave PIX
            <input value={pixKey} onChange={(e) => setPixKey(e.target.value)} required placeholder="e-mail / telefone / aleatória" />
          </label>
          {error && <p className="error">{error}</p>}
          {ok && <p className="ok">{ok}</p>}
          <button type="submit" disabled={busy}>
            {busy ? '…' : 'Sacar (mín. R$20)'}
          </button>
        </form>

        <section className="card wide">
          <h3>Histórico de saques</h3>
          {list.length === 0 ? (
            <p className="muted">Nenhum saque ainda.</p>
          ) : (
            <ul className="list">
              {list.map((w) => (
                <li key={w.id}>
                  <div>
                    <strong>{brl(w.amount)}</strong>
                    <span className="muted"> · {w.method} · {w.maskedDestination}</span>
                  </div>
                  <span className="pill">{w.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
