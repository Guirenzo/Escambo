import type { Wallet } from '@escambo/types';

const brl = (v: number): string => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function WalletCard({ wallet }: { wallet: Wallet | null }) {
  return (
    <section className="card">
      <h3>💰 Carteira</h3>
      {wallet ? (
        <>
          <p className="big">{brl(wallet.balance)}</p>
          <p className="muted">disponível para saque</p>
          <div className="escrow">
            🔒 {brl(wallet.balancePending)} <span>retido em escrow</span>
          </div>
        </>
      ) : (
        <p className="muted">carregando…</p>
      )}
    </section>
  );
}
